-- Leaderinnen pausieren (Nov 2026).
-- Pausiert = bleibt in Dominiks Dashboard sichtbar (grau, "Pausiert"), aber JARVIS
-- erwähnt sie nicht mehr im Briefing und in den Hinweisen, und die wöchentlichen
-- KI-Auswertungen laufen für sie nicht. Umschalten geht auch im Admin-Dashboard.
alter table leaders add column if not exists on_hold boolean not null default false;

update leaders set on_hold = true where name ilike 'sandy%' or name ilike 'alicia%';

-- Kontrolle: hier sollten Sandy und Alicia mit true stehen
select name, on_hold from leaders order by sort_order;
