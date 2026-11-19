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

-- Ergänzung: Leaderinnen tragen ihren Stand aus FLP360 selbst ein.
-- period = 'main' (Haupt-Level) oder 'bonus'. Eingetragene Werte gehen vor der Automatik.
create table if not exists incentive_entries (
  id bigserial primary key,
  incentive_id uuid not null references incentives(id) on delete cascade,
  leader_id uuid not null references leaders(id) on delete cascade,
  period text not null default 'main',
  new_cc numeric(10,3),
  new_as int,
  new_s int,
  updated_at timestamptz not null default now(),
  unique (incentive_id, leader_id, period)
);
alter table incentive_entries enable row level security;

-- Ergänzung (19.11.2026): Incentives, die nur Dominik sieht
alter table incentives add column if not exists admin_only boolean not null default false;

-- Business Start Incentive, Runde 1 und 2 (nur für Dominik)
insert into incentives (title, subtitle, start_date, end_date, admin_only, levels)
select 'Business Start · Runde 1', 'Reise München 4.–5.6.2027', '2026-09-01', '2027-02-28', true,
'[{"name":"Business Start","combo_cc":35,"combo_months":3,"new_as":3,"direct_as":true,"active_cc":4,
   "reward":"Übernachtung München für dich und einen Gast, Villa Loeb, Training Next Steps to Manager, Get-together und BBQ-Dinner."}]'::jsonb
where not exists (select 1 from incentives where title = 'Business Start · Runde 1');

insert into incentives (title, subtitle, start_date, end_date, admin_only, levels)
select 'Business Start · Runde 2', 'Reise München 10.–11.12.2027', '2027-03-01', '2027-08-31', true,
'[{"name":"Business Start","combo_cc":35,"combo_months":3,"new_as":3,"direct_as":true,"active_cc":4,
   "reward":"Übernachtung München für dich und einen Gast, Villa Loeb, Training Next Steps to Manager, Get-together und Winter-Grillen."}]'::jsonb
where not exists (select 1 from incentives where title = 'Business Start · Runde 2');

-- Business Boost Incentive (nur für Dominik)
insert into incentives (title, subtitle, start_date, end_date, admin_only, levels)
select 'Business Boost', 'Reise Breda 28.–29.11.2027', '2026-09-01', '2027-02-28', true,
'[{"name":"Noch nicht Manager","track":"below_manager","reach_manager":true,"new_cc":50,"active_cc":4,
   "reward":"Übernachtung Breda für dich und einen Gast, Forever Direct, Business-Training, Dinner, 150 € Reisezuschuss."},
  {"name":"Schon Manager","track":"manager","own_cc_total":360,"new_cc":50,"active_cc":4,
   "reward":"Übernachtung Breda für dich und einen Gast, Forever Direct, Business-Training, Dinner, 150 € Reisezuschuss."}]'::jsonb
where not exists (select 1 from incentives where title = 'Business Boost');
