-- Proves the RLS policies in db/supabase.sql actually isolate tenants.
-- Run against a throwaway Postgres (NOT your Supabase project — it truncates auth.users):
--
--   createdb rankops_rls_test
--   psql rankops_rls_test -c "create schema auth;
--     create table auth.users (id uuid primary key default gen_random_uuid(), email text);
--     create or replace function auth.uid() returns uuid language sql stable as
--       \$\$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid \$\$;
--     create role anon; create role authenticated;"
--   psql rankops_rls_test -f db/supabase.sql
--   psql rankops_rls_test -f db/rls-test.sql
--
-- Every line must print OK. A LEAK line means a policy regressed.

\set ON_ERROR_STOP on
-- two agencies, two users, one member each; plus a viewer who may read but not write
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','ismail@wsz.ae'),
  ('22222222-2222-2222-2222-222222222222','rival@other.com'),
  ('33333333-3333-3333-3333-333333333333','viewer@wsz.ae');
insert into agencies (id,name) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Web Solution Zone'),
  ('bbbbbbbb-0000-0000-0000-000000000002','Rival Agency');
insert into agency_members values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','owner'),
  ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','owner'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','viewer');
insert into site_connections (agency_id, site_id, base_url, credentials) values
  ('aaaaaaaa-0000-0000-0000-000000000001','s_vapewizard','https://vapewizarddxb.com','v1.secret-ciphertext'),
  ('bbbbbbbb-0000-0000-0000-000000000002','s_rival','https://rival.example','v1.rival-ciphertext');

-- mimic Supabase's default broad grants, then re-apply the schema's hardening on top
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on site_connections from anon, authenticated;
grant select (id, agency_id, site_id, platform, base_url, seo_plugin, capabilities,
              paused, settings, last_test_at, created_at, updated_at) on site_connections to authenticated;

\echo '--- owner of agency A sees only agency A ---'
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select site_id, base_url from site_connections order by site_id;

\echo '--- owner of agency B sees only agency B ---'
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select site_id, base_url from site_connections order by site_id;

\echo '--- cross-tenant + client writes to site_connections are rejected ---'
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin
  update site_connections set paused = true where site_id = 's_vapewizard';
  raise exception 'LEAK: rival updated another agency row';
exception when insufficient_privilege then raise notice 'OK: no client UPDATE on site_connections at all';
end $$;
do $$ begin
  insert into site_connections (agency_id, site_id, base_url, credentials)
    values ('aaaaaaaa-0000-0000-0000-000000000001','s_injected','https://evil.example','x');
  raise exception 'LEAK: rival inserted into another agency';
exception when insufficient_privilege then raise notice 'OK: no client INSERT on site_connections';
end $$;

\echo '--- cross-tenant write on an RLS-only table (findings) is rejected ---'
do $$ begin
  insert into findings (agency_id, site_id, check_id, verdict)
    values ('aaaaaaaa-0000-0000-0000-000000000001','s_vapewizard','canonical','fail');
  raise exception 'LEAK: rival wrote a finding into another agency';
exception when insufficient_privilege then raise notice 'OK: cross-tenant finding insert blocked by RLS';
end $$;
do $$ declare n int; begin
  update findings set summary = 'tampered' where site_id = 's_vapewizard';
  get diagnostics n = row_count;
  if n > 0 then raise exception 'LEAK: rival updated % findings', n; else raise notice 'OK: rival updated 0 findings'; end if;
end $$;

\echo '--- member of agency A CAN write its own findings ---'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ begin
  insert into findings (agency_id, site_id, check_id, verdict, summary)
    values ('aaaaaaaa-0000-0000-0000-000000000001','s_vapewizard','canonical','fail','2 pages missing canonical');
  raise notice 'OK: owner wrote a finding for its own agency';
end $$;

\echo '--- viewer may read but not write ---'
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select count(*) as viewer_visible_findings from findings;
do $$ begin
  insert into findings (agency_id, site_id, check_id, verdict) values ('aaaaaaaa-0000-0000-0000-000000000001','s_vapewizard','sitemap','fail');
  raise exception 'LEAK: viewer wrote a finding';
exception when insufficient_privilege then raise notice 'OK: viewer write blocked by RLS';
end $$;

\echo '--- credentials column is not readable by any client role ---'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ begin
  perform credentials from site_connections limit 1;
  raise exception 'LEAK: client role read the credentials column';
exception when insufficient_privilege then raise notice 'OK: credentials column denied to authenticated';
end $$;
do $$ begin
  perform base_url from site_connections limit 1;
  raise notice 'OK: safe columns still readable';
end $$;
reset role;
