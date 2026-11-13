// netlify/functions/leader-get-dashboard.js
//
// GET /.netlify/functions/leader-get-dashboard   (angemeldet per Cookie,
// übergangsweise auch ?token=<alter Link>; Prüfung in _lib/auth.js)
//
// Lädt die angemeldete Leaderin, ihre letzten Wochen-Einträge und
// die Strategie für den laufenden Monat, und berechnet den Fortschritt.

const { pgrest } = require('./_lib/supabase');
const { requireLeader } = require('./_lib/auth');
const { computeProgress, viennaTodayStr } = require('./_lib/ranks');
const { planWindow } = require('./_lib/plan');
const { leaderChallenge } = require('./_lib/challenge');
const { monthMetrics, evaluate, publicPin } = require('./_lib/pins');
const { planStatus } = require('./_lib/leader-context');
const { leaderPlans } = require('./_lib/devplan');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const auth = await requireLeader(event, null);
    if (!auth.ok) return auth.response;
    const leaders = await pgrest('leaders', {
      query: `id=eq.${auth.leader.id}&select=id,name,slug,current_rank,manager_achieved_at,vision_image_url,specialized_products`,
    });
    const leader = leaders[0];

    // Besuch protokollieren, fürs Nutzungs-Muster auf der Team-Übersicht.
    // Absichtlich nicht blockierend für den Rest der Antwort.
    try {
      await pgrest('dashboard_visits', { method: 'POST', body: [{ leader_id: leader.id }] });
    } catch (e) { /* Logging-Fehler sollen das Dashboard nicht kaputt machen */ }

    const weeklyEntries = await pgrest('weekly_entries', {
      query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=26`,
    });

    // Tägliche Reflexionen der letzten 14 Tage (Tabelle daily_reflections).
    // Fehlt die Tabelle noch, soll das Dashboard trotzdem laden.
    let recentDays = [];
    try {
      recentDays = await pgrest('daily_reflections', {
        query: `leader_id=eq.${leader.id}&order=entry_date.desc&limit=14&select=*`,
      });
    } catch (e) { recentDays = []; }

    // Monatsplanung: aktueller und nächster Monat, plus Sperre ab dem 25.
    // Fehlt die Tabelle noch, wird nie gesperrt (sonst käme niemand mehr rein).
    const pw = planWindow(viennaTodayStr());
    let plans = [];
    let plansAvailable = true;
    try {
      plans = await pgrest('monthly_plans', {
        query: `leader_id=eq.${leader.id}&target_month=in.(${pw.current},${pw.next})&select=target_month,plan_cc,sponsoring_cc,eigen_cc,kunden_cc,kunden_text,team_cc`,
      });
    } catch (e) { plansAvailable = false; plans = []; }
    const planInfo = {
      currentMonth: pw.current,
      nextMonth: pw.next,
      requiredMonth: pw.required,
      locked: !!(plansAvailable && pw.required && !plans.some((p) => p.target_month === pw.required)),
      plans,
    };

    const currentMonthStart = viennaTodayStr().slice(0, 7) + '-01';
    const strategyRows = await pgrest('monthly_strategy', {
      query: `target_month=eq.${currentMonthStart}&select=content`,
    });
    const strategyContent = strategyRows && strategyRows[0] ? strategyRows[0].content : null;
    const strategyReady = !!(strategyContent && strategyContent.trim().length > 0);

    const currentWeekMonday = (() => {
      const today = viennaTodayStr();
      const d = new Date(today + 'T00:00:00Z');
      const day = d.getUTCDay() || 7; // Sonntag=0 -> 7
      d.setUTCDate(d.getUTCDate() - (day - 1));
      return d.toISOString().slice(0, 10);
    })();
    const missingThisWeek = !weeklyEntries.some((e) => e.week_start === currentWeekMonday);

    const progress = computeProgress(leader, weeklyEntries);

    // Erledigt erst, wenn die Fokus-Produkte gewählt sind. Wer nur die alte
    // Einstiegs-Umfrage (ohne Produkte) ausgefüllt hat, bekommt die neue.
    const intakeRows = await pgrest('intake_survey', { query: `leader_id=eq.${leader.id}&select=leader_id,fokus_produkte` });
    const intakeDone = !!(intakeRows && intakeRows[0] && intakeRows[0].fokus_produkte);

    const newTps = await pgrest('new_tps', {
      query: `leader_id=eq.${leader.id}&order=created_at.desc&select=id,tp_name,step_1,step_2,step_3,step_4,step_5,step_6,step_7`,
    });

    // 52-Wochen-Challenge (supabase/challenge.sql). Fehlt die Tabelle, ohne.
    let challenge = null;
    try {
      challenge = await leaderChallenge(leader.id, viennaTodayStr());
    } catch (e) { challenge = null; }

    // Leadership-Pins (supabase/pins.sql): Sammlung, neuer Pin, Fortschritt im laufenden Monat
    let pins = null;
    try {
      const rows = await pgrest('leader_pins', { query: `leader_id=eq.${leader.id}&order=month.desc&select=*` });
      const history = (rows || []).map(publicPin);
      const unseen = (rows || []).filter((r) => !r.seen_at);
      if (unseen.length) {
        await pgrest('leader_pins', { method: 'PATCH', query: `leader_id=eq.${leader.id}&seen_at=is.null`, body: { seen_at: new Date().toISOString() } });
      }
      const ev = evaluate(await monthMetrics(leader.id, viennaTodayStr().slice(0, 7)));
      pins = {
        history,
        newPin: unseen.length ? publicPin(unseen.sort((a, b) => String(b.month).localeCompare(String(a.month)))[0]) : null,
        progress: ev.results.map((r) => ({ key: r.key, emoji: r.emoji, label: r.label, rule: r.rule, ok: r.ok, value: r.value, target: r.target })),
      };
    } catch (e) { pins = null; }

    // Cockpit der Startseite: Monatsziel (Plan vs. CC-Stand), Kontakte und Präsentationen im laufenden Monat
    let cockpit = null;
    try {
      const today = viennaTodayStr();
      const mk = today.slice(0, 7);
      const monthWeeks = (weeklyEntries || []).filter((w) => String(w.week_start).slice(0, 7) === mk);
      const ccVals = monthWeeks.map((w) => w.cc_stand).filter((v) => v != null).map(Number);
      const ccSoFar = ccVals.length ? Math.max(...ccVals) : null;
      let monthDays = [];
      try {
        monthDays = (await pgrest('daily_reflections', { query: `leader_id=eq.${leader.id}&entry_date=gte.${mk}-01&select=kontakte_heute` })) || [];
      } catch (e) { monthDays = []; }
      const dayContacts = monthDays.reduce((a, d) => a + (Number(d.kontakte_heute) || 0), 0);
      const weekContacts = monthWeeks.reduce((a, w) => a + (Number(w.kontakte_gesamt) || 0), 0);
      const plan = (plans || []).find((p) => String(p.target_month).slice(0, 7) === mk);
      cockpit = {
        month: mk,
        planCc: plan ? Number(plan.plan_cc) : null,
        ccSoFar,
        status: plan ? planStatus(Number(plan.plan_cc), ccSoFar, today) : null,
        contacts: Math.max(dayContacts, weekContacts),
        presentations: monthWeeks.reduce((a, w) => a + (Number(w.geschaeftspraesentationen_versendet) || 0), 0),
      };
    } catch (e) { cockpit = null; }

    // JARVIS-Entwicklungsprofil: nur die Sicht für die Leaderin (ohne Dominiks Teil)
    let growth = null;
    try {
      const rows = await pgrest('leader_profiles', { query: `leader_id=eq.${leader.id}&order=created_at.desc&limit=1&select=data,created_at` });
      if (rows && rows[0] && rows[0].data && rows[0].data.fuer_leaderin) {
        growth = { ...rows[0].data.fuer_leaderin, stand: String(rows[0].created_at).slice(0, 10) };
      }
    } catch (e) { growth = null; }

    // Persönlicher Entwicklungsplan (supabase/devplans.sql)
    let devplan = null;
    try { devplan = await leaderPlans(leader.id); } catch (e) { devplan = null; }

    return {
      statusCode: 200,
      body: JSON.stringify({
        name: leader.name,
        cockpit,
        growth,
        devplan,
        challenge,
        pins,
        slug: leader.slug || null,
        currentRank: leader.current_rank,
        visionImageUrl: leader.vision_image_url || null,
        specializedProducts: leader.specialized_products || null,
        progress,
        recentWeeks: weeklyEntries,
        currentWeekMonday,
        today: viennaTodayStr(),
        planInfo,
        recentDays,
        missingThisWeek,
        strategy: { ready: strategyReady, content: strategyReady ? strategyContent : null },
        intakeDone,
        newTps: newTps || [],
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
