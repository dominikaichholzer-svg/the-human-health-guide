-- Erinnerungszeiten (Nov 2026): jede Leaderin wählt selbst, wann sie an die
-- Tagesreflexion (täglich) und an die Wochenreflexion (sonntags) erinnert wird.
-- Nicht ausgefüllt? Dann kommt am nächsten Morgen um 08:00 automatisch eine Erinnerung.
-- Im Supabase SQL Editor einmal ausführen.

alter table leaders add column if not exists reminder_daily_time text not null default '19:00';
alter table leaders add column if not exists reminder_weekly_time text not null default '19:00';
alter table leaders add column if not exists reminder_set_at timestamptz;   -- null = Fenster noch zeigen

-- Was schon geschickt wurde (damit nichts doppelt kommt)
create table if not exists reminder_log (
  leader_id uuid not null references leaders(id) on delete cascade,
  kind text not null,          -- daily | weekly | plan | morning
  ref_date date not null,
  sent_at timestamptz not null default now(),
  primary key (leader_id, kind, ref_date)
);
alter table reminder_log enable row level security;
