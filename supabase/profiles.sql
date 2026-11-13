-- JARVIS-Entwicklungsprofile der Leaderinnen (Nov 2026).
-- Jeden Sonntagabend eine neue Zeile pro Leaderin. JARVIS baut dabei auf dem
-- letzten Profil auf; die alten Zeilen bleiben als Verlauf erhalten.
-- Nur eine neue Tabelle. Im Supabase SQL Editor einmal ausführen.

create table if not exists leader_profiles (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  data jsonb not null,                 -- Stärken, Muster, Wachstumsfelder, Sicht der Leaderin, Chat-Hinweise
  created_at timestamptz not null default now()
);
create index if not exists leader_profiles_leader_idx on leader_profiles (leader_id, created_at desc);
alter table leader_profiles enable row level security;
