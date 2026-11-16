-- Reihenfolge der Leaderinnen im Dashboard (Nov 2026): Laura, Sarah, Kathrin, Sandra.
-- Pausierte (Sandy, Alicia) kommen danach.
update leaders set sort_order = case
  when name ilike 'laura%'   then 1
  when name ilike 'sarah%'   then 2
  when name ilike 'kathrin%' then 3
  when name ilike 'sandra%'  then 4
  when name ilike 'sandy%'   then 5
  when name ilike 'alicia%'  then 6
  else 10 end;

select name, sort_order, on_hold from leaders order by sort_order;
