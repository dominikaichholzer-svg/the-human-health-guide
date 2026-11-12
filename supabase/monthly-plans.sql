-- Monatsplanung der Leaderinnen (seit Nov 2026).
-- Eine Zeile pro Leaderin und Monat. Im Supabase SQL Editor einmal ausführen.
create table if not exists monthly_plans (
  id bigserial primary key,
  leader_id uuid not null references leaders(id) on delete cascade,
  target_month date not null,                 -- immer der 1. des Monats
  plan_cc numeric(10,3) not null,             -- Plan: persönliche CC im Monat
  sponsoring_cc numeric(10,3),                -- davon durch Sponsern (neue Partner)
  eigen_cc numeric(10,3),                     -- davon Eigenverbrauch
  kunden_cc numeric(10,3),                    -- davon Kundenbestellungen
  kunden_text text,                           -- Freitext: Aufteilung und Konzept(e)
  team_cc numeric(10,3),                      -- CC des Teams in Summe
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (leader_id, target_month)
);

alter table monthly_plans enable row level security;

-- Falls die Tabelle schon mit der ersten Version angelegt wurde (Konzept-Felder):
alter table monthly_plans add column if not exists kunden_cc numeric(10,3);
alter table monthly_plans add column if not exists kunden_text text;
alter table monthly_plans drop column if exists kunden_konzepte;
