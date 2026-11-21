-- Road to 200: C9-Neujahrs-Challenge (Start Samstag 30.01.2027).
-- Eine Umfrage für alle, jede Partnerin hat ihren Link /neujahr/<slug>.
-- Duplizieren = eine Zeile in c9_partners. Im Supabase SQL Editor einmal ausführen.

create table if not exists c9_partners (
  slug text primary key,             -- steht im Link, z. B. "dominik"
  name text not null,                -- Vorname, so wie er auf der Seite steht
  whatsapp text,                     -- internationale Nummer ohne +, z. B. 4366412345678
  email text,                        -- für die Benachrichtigung (später)
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table c9_partners enable row level security;

create table if not exists c9_leads (
  id uuid primary key default gen_random_uuid(),
  partner_slug text not null references c9_partners(slug),
  name text not null,
  phone text not null,
  email text,
  answers jsonb not null default '{}'::jsonb,   -- ziel, hindernis, alltag, start
  consent_text text not null,                  -- Wortlaut der Einwilligung (DSGVO-Nachweis)
  wa_clicked_at timestamptz,                   -- hat selbst auf WhatsApp geschrieben
  friend_shared_at timestamptz,                -- hat an eine Freundin weitergeleitet
  status text not null default 'neu' check (status in ('neu', 'im_gespraech', 'bestellt', 'kein_interesse')),
  ordered_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists c9_leads_partner_idx on c9_leads (partner_slug, created_at desc);
alter table c9_leads enable row level security;

-- Muster: Dominik. WhatsApp-Nummer bitte eintragen (ohne +, ohne Leerzeichen).
insert into c9_partners (slug, name, whatsapp)
values ('dominik', 'Dominik', null)
on conflict (slug) do nothing;

-- Ergänzung (21.11.2026): Teilnehmerinnen tragen sich nach der Bestellung selbst ein
-- (/dabei/<slug>) und bekommen dafür den Link zur WhatsApp-Gruppe.
alter table c9_leads add column if not exists confirmed_at timestamptz;   -- selbst als bestellt eingetragen
create table if not exists c9_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
alter table c9_settings enable row level security;
insert into c9_settings (key, value) values ('group_link', null) on conflict (key) do nothing;
