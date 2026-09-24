-- AI settings per agency: which model provider drives AI reviews, and the API key (encrypted by the
-- API with ENCRYPTION_KEY — never readable from a client). Run once in the Supabase SQL editor.
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
