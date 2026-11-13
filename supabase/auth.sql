-- Login mit Benutzername und Passwort (Phase 0, Nov 2026).
-- Nur Ergänzungen: es wird nichts gelöscht und keine bestehende Spalte verändert.
-- Im Supabase SQL Editor einmal komplett ausführen. Mehrfaches Ausführen schadet nicht.

-- 1. Personentabelle: Rolle, Benutzername, Passwort-Hash, Zustimmung, Einmal-Link
alter table leaders add column if not exists role text not null default 'leader';
alter table leaders add column if not exists username text;
alter table leaders add column if not exists password_hash text;          -- scrypt, nie Klartext
alter table leaders add column if not exists password_set_at timestamptz;
alter table leaders add column if not exists consent_at timestamptz;      -- Zustimmung Datenzugriff
alter table leaders add column if not exists setup_token_hash text;       -- Einmal-Link nach Zurücksetzen (sha256)
alter table leaders add column if not exists setup_token_expires timestamptz;

-- Benutzername = Kurzname in Kleinbuchstaben (laura, sandy, ...), nur wo noch leer
update leaders set username = lower(slug) where username is null and slug is not null;
create unique index if not exists leaders_username_key on leaders (username);
create unique index if not exists leaders_setup_token_hash_key on leaders (setup_token_hash);

-- 2. Sitzungen: im Cookie liegt ein Zufallswert, hier nur dessen sha256-Hash
create table if not exists auth_sessions (
  id bigserial primary key,
  token_hash text not null unique,
  leader_id uuid not null references leaders(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  user_agent text
);
create index if not exists auth_sessions_leader_idx on auth_sessions (leader_id);
alter table auth_sessions enable row level security;

-- 3. Fehlversuche, für die Sperre nach zu vielen falschen Eingaben
create table if not exists auth_attempts (
  id bigserial primary key,
  attempt_key text not null,             -- "user:laura" oder "ip:1.2.3.4"
  success boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists auth_attempts_key_time_idx on auth_attempts (attempt_key, created_at desc);
alter table auth_attempts enable row level security;

-- 4. Zugriffsprotokoll: wer hat sich wann angemeldet, Passwort gesetzt, zugestimmt usw.
create table if not exists access_log (
  id bigserial primary key,
  leader_id uuid references leaders(id) on delete set null,
  action text not null,
  detail text,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists access_log_time_idx on access_log (created_at desc);
alter table access_log enable row level security;
