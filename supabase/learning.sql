-- Schritt 2: JARVIS als Lernbegleiter (Nov 2026).
-- Nur Ergänzungen. Im Supabase SQL Editor einmal ausführen.

-- Freigabe der Bibliothek für die Leaderinnen:
--   null = nur für Dominik (z. B. persönliche Bücher), 'alle' = alle Leaderinnen,
--   'ab_assistant_manager' / 'ab_manager' = erst ab diesem Rang
alter table agent_books add column if not exists team_level text;
update agent_books set team_level = 'alle' where filename like 'schulung-video:%' and team_level is null;

-- Lernnotizen und Aufgaben der Leaderinnen (sieht sie und Dominik)
create table if not exists learning_notes (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  kind text not null default 'note' check (kind in ('note', 'task')),
  text text not null,
  source text,                          -- 'chat' oder 'manuell'
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists learning_notes_leader_idx on learning_notes (leader_id, created_at desc);
alter table learning_notes enable row level security;

-- Chat-Aufträge: die Antwort entsteht im Hintergrund (Schulungen nachschlagen dauert länger)
create table if not exists chat_jobs (
  id uuid primary key default gen_random_uuid(),
  leader_id uuid not null references leaders(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'done', 'error')),
  request jsonb not null,
  shown_message text,
  reply text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists chat_jobs_leader_idx on chat_jobs (leader_id, created_at desc);
alter table chat_jobs enable row level security;
