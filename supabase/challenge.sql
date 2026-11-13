-- 52-Wochen-Leadership-Challenge (Phase 2, Nov 2026). Start: Montag 30.11.2026.
-- Nur neue Tabellen. Im Supabase SQL Editor einmal ausführen.

-- Inhalte, die Dominik zentral im Admin-Dashboard schreibt (eine Zeile pro Woche)
create table if not exists challenge_weeks (
  week_no int primary key check (week_no between 1 and 52),
  impuls text,
  aufgabe text,
  frage text,
  updated_at timestamptz not null default now()
);
alter table challenge_weeks enable row level security;

-- Was jede Leaderin pro Woche gemacht hat
create table if not exists challenge_progress (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  week_no int not null check (week_no between 1 and 52),
  task_done boolean not null default false,
  answer text,
  updated_at timestamptz not null default now(),
  unique (leader_id, week_no)
);
alter table challenge_progress enable row level security;
