-- Checkliste "Neue Team-Partnerinnen" mit "Mein Team" zusammenlegen (Nov 2026).
-- Jede Checkliste gehört danach zu genau einer Partnerin in team_members.
-- Es wird nichts gelöscht. Mehrfaches Ausführen schadet nicht.
-- Voraussetzung: supabase/team.sql ist ausgeführt.

alter table new_tps add column if not exists member_id uuid references team_members(id) on delete set null;
create unique index if not exists new_tps_member_key on new_tps (member_id);

-- 1. Checklisten mit einer schon eingetragenen Partnerin gleichen Namens verknüpfen
--    (gleiche Leaderin, Groß/Klein egal). Jede Partnerin bekommt höchstens eine.
with pairs as (
  select distinct on (m.id) t.id as tp_id, m.id as member_id
  from new_tps t
  join team_members m
    on m.leader_id = t.leader_id
   and lower(trim(m.name)) = lower(trim(t.tp_name))
  where t.member_id is null
    and not exists (select 1 from new_tps x where x.member_id = m.id)
  order by m.id, t.created_at
),
uniq as (
  select distinct on (tp_id) tp_id, member_id from pairs order by tp_id, member_id
)
update new_tps t set member_id = u.member_id
from uniq u
where t.id = u.tp_id;

-- 2. Für alle übrigen Checklisten die Partnerin neu anlegen
--    (von der Leaderin selbst gesponsert, Rang "Partnerin"; gleiche id wie die Checkliste)
insert into team_members (id, leader_id, name, created_at)
select t.id, t.leader_id, trim(t.tp_name), t.created_at
from new_tps t
where t.member_id is null
  and not exists (select 1 from team_members m where m.id = t.id);

update new_tps set member_id = id
where member_id is null
  and exists (select 1 from team_members m where m.id = new_tps.id);
