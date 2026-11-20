-- Tagesabschluss neu + JARVIS-Wochen-Coaching (Nov 2026).
-- Im Supabase SQL Editor einmal ausführen. Löscht nichts, fügt nur hinzu.

-- 1. Neue Fragen im Tagesabschluss (bestehende Spalten bleiben):
--    bewegt  = Was hast du heute für dein Business bewegt?
--    gut     = Was war heute dein schönster Erfolg? (bestehende Spalte)
--    schwer  = Was ist dir heute schwergefallen? (bestehende Spalte)
--    gefuehl = Wie fühlst du dich, 1 bis 10 (stimmung 1 bis 5 wird daraus weiter befüllt)
alter table daily_reflections add column if not exists bewegt text;
alter table daily_reflections add column if not exists gefuehl smallint;
-- Kurze Rückmeldung von JARVIS nach dem Speichern, eventuell mit einer Rückfrage
alter table daily_reflections add column if not exists jarvis_notiz text;
alter table daily_reflections add column if not exists jarvis_frage text;
alter table daily_reflections add column if not exists frage_antwort text;

-- 2. Wochen-Coaching: eins pro Leaderin und Woche (week_start = Montag, Wiener Zeit).
--    Der Unique-Schlüssel verhindert doppelte Wochenberichte.
create table if not exists weekly_coachings (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  week_start date not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'error')),
  data jsonb,              -- Coaching + JARVIS' Langzeit-Gedächtnis zu ihr
  days_count int,          -- auf wie vielen Tagesabschlüssen es beruht
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  unique (leader_id, week_start)
);
create index if not exists weekly_coachings_leader_idx on weekly_coachings (leader_id, week_start desc);
alter table weekly_coachings enable row level security;
