-- Tabellen für JARVIS (Dominiks Telegram-Agent).
-- Einmal im Supabase SQL Editor ausführen.

create table if not exists agent_messages (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  kind text not null default 'chat',          -- chat | briefing | reset
  telegram_update_id bigint unique
);

create table if not exists agent_memory (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  fact text not null
);

-- Nur der Server (service_role) darf lesen und schreiben
alter table agent_messages enable row level security;
alter table agent_memory enable row level security;
