-- Persönlicher Entwicklungsplan (Nov 2026) + zwei Zahlen im Tagesabschluss.
-- Nur Ergänzungen. Im Supabase SQL Editor einmal ausführen.

-- Tagesabschluss: Gespräche und neue Kundinnen (damit JARVIS die Kette Kontakt -> Gespräch -> Kundin sieht)
alter table daily_reflections add column if not exists gespraeche_heute int;
alter table daily_reflections add column if not exists neue_kunden_heute int;

-- Ein Entwicklungsplan pro Leaderin und Monat
create table if not exists development_plans (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  month date not null,                         -- immer der 1. des Monats
  status text not null default 'proposed' check (status in ('proposed', 'confirmed', 'reviewed')),
  proposal jsonb,                              -- JARVIS' ursprünglicher Vorschlag (Schwerpunkt, warum, Ziel, Schritte)
  focus text,                                  -- bestätigter Schwerpunkt (darf sie anpassen)
  goal text,                                   -- bestätigtes Ziel
  steps jsonb not null default '[]',           -- [{ text, done, note }]
  review jsonb,                                -- JARVIS-Auswertung am Monatsende (erreicht, verbessert, naechster_schritt)
  leader_reflection text,                      -- ihre eigene Sicht am Monatsende
  coach_feedback text,                         -- Dominiks Feedback und Coaching-Schwerpunkt
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (leader_id, month)
);
alter table development_plans enable row level security;
