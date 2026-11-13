-- Phase 3 "Teamführung" (Nov 2026): Teamprofil, Coaching-Notizen, Entwicklungsziele.
-- Nur Ergänzungen. Im Supabase SQL Editor einmal ausführen.

-- Teamprofil: Startdatum und Warum der Partnerin
alter table team_members add column if not exists start_date date;
alter table team_members add column if not exists warum text;

-- Wann zuletzt ein Schritt der Einarbeitung abgehakt wurde (für "Einarbeitung hängt")
alter table new_tps add column if not exists steps_updated_at timestamptz;

-- Coaching-Notizen
--   author = 'leader': Notiz einer Leaderin zu einer Partnerin (member_id gesetzt). Dominik liest mit (wird protokolliert).
--   author = 'admin' : Notiz von Dominik zu einer Leaderin (member_id leer). Sieht nur Dominik.
create table if not exists coaching_notes (
  id bigserial primary key,
  author text not null check (author in ('leader', 'admin')),
  leader_id uuid not null references leaders(id) on delete cascade,
  member_id uuid references team_members(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists coaching_notes_leader_idx on coaching_notes (leader_id);
alter table coaching_notes enable row level security;

-- Entwicklungsziele einer Partnerin (von der Leaderin gesetzt)
create table if not exists member_goals (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  member_id uuid not null references team_members(id) on delete cascade,
  goal text not null,
  target_rank text,                    -- gesetzt, wenn das Ziel ein Rang ist (zeigt CC-Fortschritt)
  target_date date,
  next_step text,
  status text not null default 'open' check (status in ('open', 'reached')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists member_goals_leader_idx on member_goals (leader_id);
alter table member_goals enable row level security;
