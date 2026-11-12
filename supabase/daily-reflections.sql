-- Tägliche Reflexion im Leader-Dashboard (seit Nov 2026).
-- Eine Zeile pro Leaderin und Tag. Im Supabase SQL Editor einmal ausführen.
create table if not exists daily_reflections (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  entry_date date not null,
  kontakte_heute int,
  stimmung int check (stimmung between 1 and 5),
  gut text,
  schwer text,
  morgen text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (leader_id, entry_date)
);

alter table daily_reflections enable row level security;
