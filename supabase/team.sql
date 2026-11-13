-- "Mein Team" (Phase 1, Nov 2026): Jede Leaderin pflegt ihre Partnerinnen selbst.
-- Nur neue Tabellen. Im Supabase SQL Editor einmal ausführen.

-- Partnerinnen einer Leaderin. sponsor_id = null heißt: von der Leaderin selbst gesponsert.
create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  leader_id uuid not null references leaders(id) on delete cascade,
  name text not null,
  sponsor_id uuid references team_members(id) on delete set null,
  rank text not null default 'partner',   -- partner | supervisor | assistant_manager | manager | eagle_manager
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists team_members_leader_idx on team_members (leader_id);
alter table team_members enable row level security;

-- CC pro Partnerin und Monat (einmal im Monat mit der Monatsplanung eingetragen)
create table if not exists team_member_cc (
  id bigserial primary key,
  member_id uuid not null references team_members(id) on delete cascade,
  month date not null,                    -- immer der 1. des Monats
  cc numeric(10,3) not null,
  updated_at timestamptz not null default now(),
  unique (member_id, month)
);
alter table team_member_cc enable row level security;
