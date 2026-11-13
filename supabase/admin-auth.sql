-- Admin-Login mit Passwort und E-Mail-Code (Phase 0, Nov 2026).
-- Nur neue Tabellen. Im Supabase SQL Editor einmal ausführen.

-- Das eine Admin-Konto (genau eine Zeile)
create table if not exists admin_account (
  id int primary key default 1 check (id = 1),
  username text not null,
  password_hash text not null,            -- scrypt, nie Klartext
  password_set_at timestamptz not null default now()
);
alter table admin_account enable row level security;

-- 6-stellige Codes per E-Mail (nur als Hash, 10 Minuten gültig)
create table if not exists admin_login_codes (
  id bigserial primary key,
  challenge_hash text not null unique,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  pending_username text,                  -- nur beim ersten Einrichten: Konto wird erst
  pending_password_hash text,             -- nach dem richtigen Code angelegt
  created_at timestamptz not null default now()
);
alter table admin_login_codes enable row level security;

-- Admin-Sitzungen (7 Tage, im Cookie nur ein Zufallswert, hier dessen Hash)
create table if not exists admin_sessions (
  id bigserial primary key,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text
);
alter table admin_sessions enable row level security;
