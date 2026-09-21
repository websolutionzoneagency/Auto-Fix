// Creates a fresh database with the Supabase schema (plus a stub of Supabase's auth schema) for
// integration tests. Skips cleanly when RANKOPS_TEST_DATABASE_URL is unset.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

export const TEST_URL = process.env.RANKOPS_TEST_DATABASE_URL || '';

export async function freshTestDatabase(name = 'rankops_test_' + Date.now().toString(36)) {
  const admin = new pg.Client({ connectionString: TEST_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = TEST_URL.replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query(`create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;`);
  await c.query(await readFile(new URL('../../db/supabase.sql', import.meta.url), 'utf8'));
  await c.end();
  return {
    url,
    async drop() {
      const a = new pg.Client({ connectionString: TEST_URL }); await a.connect();
      await a.query(`drop database if exists ${name} with (force)`); await a.end();
    },
  };
}
