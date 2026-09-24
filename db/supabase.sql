-- RankOps on Supabase. Apply in the Supabase SQL editor (or: psql "$DATABASE_URL" -f db/supabase.sql).
-- Supersedes db/schema.sql, which assumed a single shared bearer token. Here every row is owned by an
-- agency, membership is tied to Supabase Auth users, and RLS enforces it in the database itself — so a
-- bug in the API cannot leak one agency's sites to another.
--
-- Site credentials are NEVER stored in plaintext: the API encrypts them (AES-256-GCM, api/_lib/crypto.js)
-- with ENCRYPTION_KEY from the Vercel environment, and only the ciphertext reaches this table.

create extension if not exists pgcrypto;

-- ---------- tenancy ----------
create table if not exists agencies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists agency_members (
  agency_id  uuid not null references agencies(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner','admin','member','viewer')),
  created_at timestamptz not null default now(),
  primary key (agency_id, user_id)
);
create index if not exists agency_members_user_idx on agency_members(user_id);

-- Which agencies the caller belongs to. SECURITY DEFINER so the policies below can consult
-- agency_members without recursing into its own RLS policy.
create or replace function auth_agency_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select agency_id from agency_members where user_id = auth.uid()
$$;

create or replace function auth_can_write(a uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from agency_members
    where agency_id = a and user_id = auth.uid() and role in ('owner','admin','member')
  )
$$;

-- ---------- console state (the event-sourced snapshot the app already uses) ----------
create table if not exists snapshots (
  agency_id  uuid primary key references agencies(id) on delete cascade,
  seq        bigint not null default 0,
  state      jsonb  not null,
  updated_at timestamptz not null default now()
);

create table if not exists actions (
  agency_id  uuid   not null references agencies(id) on delete cascade,
  seq        bigint not null,
  origin     text,
  actor      uuid references auth.users(id),
  action     jsonb  not null,
  created_at timestamptz not null default now(),
  primary key (agency_id, seq)
);

-- ---------- connections ----------
create table if not exists site_connections (
  id            uuid primary key default gen_random_uuid(),
  agency_id     uuid not null references agencies(id) on delete cascade,
  site_id       text not null,                    -- the site id inside the console snapshot
  platform      text not null default 'wordpress' check (platform in ('wordpress','shopify')),
  base_url      text not null,
  credentials   text not null,                    -- AES-256-GCM ciphertext, AAD-bound to (agency_id, site_id)
  seo_plugin    text,
  capabilities  jsonb not null default '{}'::jsonb,   -- last testConnection result
  paused        boolean not null default false,       -- per-site kill switch: blocks every write
  settings      jsonb not null default '{}'::jsonb,   -- fix inputs (author names, prefix replacements, org schema…)
  last_test_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (agency_id, site_id)
);

-- ---------- scan queue (drained in batches by Vercel Cron) ----------
create table if not exists scan_jobs (
  id            uuid primary key default gen_random_uuid(),
  agency_id     uuid not null references agencies(id) on delete cascade,
  site_id       text not null,
  status        text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  checks        text[] not null default '{}',     -- empty = every mapped check
  pending       text[] not null default '{}',     -- checks still to run; a batch pops from here
  attempts      int  not null default 0,
  lease_until   timestamptz,                      -- a crashed worker's job becomes claimable again after this
  requested_by  uuid references auth.users(id),
  error         text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
create index if not exists scan_jobs_claim_idx on scan_jobs(status, lease_until) where status in ('queued','running');

-- ---------- results ----------
create table if not exists findings (
  id          uuid primary key default gen_random_uuid(),
  agency_id   uuid not null references agencies(id) on delete cascade,
  site_id     text not null,
  scan_id     uuid references scan_jobs(id) on delete set null,
  check_id    text not null,
  item_ids    text[] not null default '{}',       -- checklist items this verdict decided
  verdict     text not null check (verdict in ('pass','fail','unknown')),
  summary     text,
  note        text,
  evidence_url text,
  details     jsonb not null default '[]'::jsonb, -- the findings array
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists findings_site_idx on findings(agency_id, site_id, created_at desc);

create table if not exists fix_operations (
  id           uuid primary key default gen_random_uuid(),
  agency_id    uuid not null references agencies(id) on delete cascade,
  site_id      text not null,
  finding_id   uuid references findings(id) on delete set null,
  fix_id       text not null,
  item_id      text,
  status       text not null default 'planned' check (status in ('planned','applied','failed','reverted','skipped')),
  target       jsonb not null,                    -- { type, id, url }
  field        text,
  before_value jsonb,                             -- the snapshot that makes rollback possible
  after_value  jsonb,
  describe     text,
  irreversible boolean not null default false,
  error        text,
  approved_by  uuid references auth.users(id),
  applied_at   timestamptz,
  reverted_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists fix_ops_site_idx on fix_operations(agency_id, site_id, created_at desc);

-- ---------- row-level security ----------
alter table agencies        enable row level security;
alter table agency_members  enable row level security;
alter table snapshots       enable row level security;
alter table actions         enable row level security;
alter table site_connections enable row level security;
alter table scan_jobs       enable row level security;
alter table findings        enable row level security;
alter table fix_operations  enable row level security;

drop policy if exists agencies_read on agencies;
create policy agencies_read on agencies for select using (id in (select auth_agency_ids()));

drop policy if exists members_read on agency_members;
create policy members_read on agency_members for select using (user_id = auth.uid() or agency_id in (select auth_agency_ids()));

-- Same shape for every agency-scoped table: read if you are a member, write if your role allows it.
do $$
declare t text;
begin
  foreach t in array array['snapshots','actions','site_connections','scan_jobs','findings','fix_operations'] loop
    execute format('drop policy if exists %I_read on %I', t, t);
    execute format('create policy %I_read on %I for select using (agency_id in (select auth_agency_ids()))', t, t);
    execute format('drop policy if exists %I_write on %I', t, t);
    execute format('create policy %I_write on %I for all using (auth_can_write(agency_id)) with check (auth_can_write(agency_id))', t, t);
  end loop;
end $$;

-- Credentials are never selectable by a client, even by an owner: only the service role (the Vercel
-- functions) may read the ciphertext, and only the server holds ENCRYPTION_KEY.
--
-- A column-level REVOKE does NOT override a table-level GRANT in Postgres, and Supabase grants
-- table-level privileges to `authenticated` by default. So the table grant has to be dropped first
-- and the safe columns granted back one by one.
revoke all on site_connections from anon, authenticated;
grant select (id, agency_id, site_id, platform, base_url, seo_plugin, capabilities,
              paused, settings, last_test_at, created_at, updated_at)
  on site_connections to authenticated;
-- Connecting or editing a site always goes through the API (it must encrypt the credentials),
-- so clients get no direct INSERT/UPDATE/DELETE here at all.

-- Same reasoning for the raw action log: readable, but only the API appends to it.
revoke insert, update, delete on actions from anon, authenticated;

-- ---------- AI settings ----------
create table if not exists agency_ai_settings (
  agency_id   uuid primary key references agencies(id) on delete cascade,
  provider    text not null default 'anthropic' check (provider in ('anthropic','openai')),
  model       text,
  api_key     text,                               -- AES-256-GCM ciphertext, AAD-bound to the agency
  auto_apply  boolean not null default false,     -- apply AI-proposed edits without a human review step
  updated_at  timestamptz not null default now()
);
alter table agency_ai_settings enable row level security;
drop policy if exists agency_ai_settings_read on agency_ai_settings;
create policy agency_ai_settings_read on agency_ai_settings for select using (agency_id in (select auth_agency_ids()));
revoke all on agency_ai_settings from anon, authenticated;
grant select (agency_id, provider, model, auto_apply, updated_at) on agency_ai_settings to authenticated;

-- ---------- helper: claim a batch of scan work (atomic, lease-based) ----------
create or replace function claim_scan_job(lease_seconds int default 60)
returns setof scan_jobs language sql volatile security definer set search_path = public as $$
  update scan_jobs set
    status      = 'running',
    started_at  = coalesce(started_at, now()),
    attempts    = attempts + 1,
    lease_until = now() + make_interval(secs => lease_seconds)
  where id = (
    select id from scan_jobs
    where status = 'queued' or (status = 'running' and lease_until < now())
    order by created_at
    for update skip locked
    limit 1
  )
  returning *;
$$;

-- ---------- reporting views ----------
create or replace view site_health_v as
  select f.agency_id, f.site_id,
         count(*) filter (where f.verdict = 'fail'    and f.resolved_at is null) as open_failures,
         count(*) filter (where f.verdict = 'unknown' and f.resolved_at is null) as unknown_checks,
         max(f.created_at) as last_scan_at
  from findings f group by f.agency_id, f.site_id;

create or replace view fix_activity_v as
  select agency_id, site_id, fix_id, status, count(*) as n, max(applied_at) as last_applied
  from fix_operations group by agency_id, site_id, fix_id, status;
