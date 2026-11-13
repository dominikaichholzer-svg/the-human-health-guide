-- Datenquellen für die vier Admin-Rankings (Phase 2, Nov 2026).
-- Nur Ergänzungen. Im Supabase SQL Editor einmal ausführen.

-- Call-Teilnahme: die Leaderin hakt in der Wochenreflexion ab, ob sie dabei war
alter table weekly_entries add column if not exists call_montag boolean not null default false;
alter table weekly_entries add column if not exists call_dienstag boolean not null default false;

-- Tatsächliche Monatszahlen, die die Leaderin im Monatsabschluss einträgt
-- (zusammen mit der Team-CC; erweiterbar um weitere Ist-Werte)
create table if not exists monthly_actuals (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  month date not null,                 -- immer der 1. des Monats
  eigen_cc numeric(10,3),              -- tatsächlicher Eigenverbrauch in CC
  updated_at timestamptz not null default now(),
  unique (leader_id, month)
);
alter table monthly_actuals enable row level security;

-- Ergänzung (Nov 2026): Global gesamt CC der Leaderin im Monatsabschluss
alter table monthly_actuals add column if not exists global_cc numeric(10,3);
-- Ergänzung (Nov 2026): Anzahl Partnerinnen mit mindestens 4 CC (aus FLP360 abgelesen)
alter table monthly_actuals add column if not exists four_cc_count int;
