-- Monatlicher Leadership-Pin (Phase 2, Nov 2026).
-- Das System schlägt vor, Dominik vergibt. Ein Pin pro Leaderin und Monat, Verlauf bleibt.
-- Nur eine neue Tabelle. Im Supabase SQL Editor einmal ausführen.

create table if not exists leader_pins (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  month date not null,                 -- immer der 1. des Monats
  pin_key text not null,               -- z. B. queen_of_consistency (Regeln in netlify/functions/_lib/pins.js)
  reason text,                         -- Begründung zum Zeitpunkt der Vergabe, z. B. "24 Tagesabschlüsse"
  note text,                           -- persönliche Worte von Dominik
  awarded_at timestamptz not null default now(),
  seen_at timestamptz,                 -- wann die Leaderin ihn zum ersten Mal gesehen hat
  unique (leader_id, month)
);
alter table leader_pins enable row level security;
