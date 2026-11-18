-- Incentives (Nov 2026): z. B. "Heart in Athens". Dominik legt sie im Admin an,
-- die Leaderinnen sehen im Dashboard, was ihnen noch fehlt.
-- Im Supabase SQL Editor einmal ausführen.

create table if not exists incentives (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subtitle text,
  start_date date not null,          -- Beginn Qualifikation
  end_date date not null,            -- Ende Qualifikation (Haupt-Level)
  -- Level als Liste, z. B.
  -- [{"name":"Level 1","new_cc":25,"new_as":3,"new_s":0,"active_cc":4,"reward":"...",
  --   "bonus":false,"from":null,"to":null}]
  -- bonus=true: zählt nur, wenn ein Haupt-Level erreicht ist; eigener Zeitraum from/to.
  levels jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table incentives enable row level security;

-- Athen, Runde 2 (Flyer "Heart in Athens")
insert into incentives (title, subtitle, start_date, end_date, levels)
select 'Athen Incentive', 'European Incentive Runde 2 · 2.–3. Juli 2027', '2026-11-01', '2027-01-31',
'[
  {"name":"Level 1","new_cc":25,"new_as":3,"new_s":0,"active_cc":4,"bonus":false,
   "reward":"Hotel für 2 Nächte für dich und eine Begleitperson. Qualifier-Training am Freitag (nur du)."},
  {"name":"Level 2","new_cc":45,"new_as":3,"new_s":1,"active_cc":4,"bonus":false,
   "reward":"Hotel für 2 Nächte, Qualifier-Training, Party am Freitagabend und SD am Samstag, jeweils für dich und eine Begleitperson."},
  {"name":"Bonus","new_cc":20,"new_as":0,"new_s":1,"active_cc":4,"bonus":true,"from":"2027-02-01","to":"2027-03-31",
   "reward":"2 × 250 € Reisekostenerstattung. Nur wenn Level 1 oder 2 erreicht ist."}
]'::jsonb
where not exists (select 1 from incentives where title = 'Athen Incentive');
