-- Schritt 3: "JARVIS ist aufgefallen …" (Nov 2026).
-- Nur Ergänzungen. Im Supabase SQL Editor einmal ausführen.

-- Höchstens eine proaktive Erkenntnis pro Leaderin und Woche.
-- Sieht die Leaderin (Überblick) und Dominik (Admin + Montags-Briefing).
create table if not exists jarvis_insights (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  week_start date not null,                -- Montag der Woche, für die sie gilt
  kind text not null check (kind in ('positiv', 'stagnation', 'ziel_verfehlt', 'aktivitaet')),
  title text not null,
  text text not null,
  question text,                           -- Frage zum Selbstführen
  suggestion text,                         -- kleiner Schritt für die Woche
  evidence jsonb,                          -- die rechnerisch erkannten Belege
  status text not null default 'neu' check (status in ('neu', 'erledigt', 'spaeter')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (leader_id, week_start)
);
alter table jarvis_insights enable row level security;
