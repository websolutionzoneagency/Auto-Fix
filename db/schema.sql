-- RankOps backend schema (Postgres). Apply once:  psql "$DATABASE_URL" -f db/schema.sql
--
-- Design: event-sourced. The browser and the API run the *same* reducer (js/store.js), so the
-- canonical state is a JSON snapshot per agency plus an append-only log of the actions that
-- produced it. Other open consoles poll `actions` to converge. The views at the bottom expose
-- the snapshot as ordinary rows for SQL reporting without a second write path.

CREATE TABLE IF NOT EXISTS agencies (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS snapshots (
  agency_id   text PRIMARY KEY REFERENCES agencies(id) ON DELETE CASCADE,
  seq         bigint NOT NULL DEFAULT 0,          -- seq of the last action folded into `state`
  state       jsonb  NOT NULL,                    -- the whole RankOps state object (version 2)
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actions (
  agency_id   text   NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  origin      text,                               -- the browser tab that sent it (so it is not replayed to itself)
  action      jsonb  NOT NULL,                    -- { type, payload }
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, seq)
);

INSERT INTO agencies (id, name) VALUES ('default', 'Web Solution Zone') ON CONFLICT (id) DO NOTHING;

-- ---------- read-model views (reporting / BI) ----------
CREATE OR REPLACE VIEW clients_v AS
  SELECT s.agency_id, c.value->>'id' AS id, c.value->>'name' AS name, c.value->>'contact' AS contact,
         c.value->>'plan' AS plan, (c.value->>'createdAt')::timestamptz AS created_at
  FROM snapshots s, jsonb_each(s.state->'clients') c;

CREATE OR REPLACE VIEW sites_v AS
  SELECT s.agency_id, x.value->>'id' AS id, x.value->>'clientId' AS client_id, x.value->>'name' AS name,
         x.value->>'domain' AS domain, x.value->>'platform' AS platform, x.value->>'connector' AS connector,
         (x.value->>'lastAuditAt')::timestamptz AS last_audit_at,
         (SELECT count(*) FROM jsonb_each_text(x.value->'items') i WHERE i.value = 'done') AS items_done,
         (SELECT count(*) FROM jsonb_each_text(x.value->'items') i WHERE i.value = 'na')   AS items_na
  FROM snapshots s, jsonb_each(s.state->'sites') x;

CREATE OR REPLACE VIEW site_items_v AS
  SELECT s.agency_id, x.key AS site_id, i.key AS item_id, i.value AS state,
         (x.value->'evidence'->i.key->>'checkedAt')::timestamptz AS checked_at,
         x.value->'evidence'->i.key->>'url' AS evidence_url
  FROM snapshots s, jsonb_each(s.state->'sites') x, jsonb_each_text(x.value->'items') i;

CREATE OR REPLACE VIEW flags_v AS
  SELECT s.agency_id, f.value->>'id' AS id, f.value->>'siteId' AS site_id, f.value->>'text' AS text,
         f.value->>'severity' AS severity, f.value->>'tag' AS tag, (f.value->>'resolved')::boolean AS resolved,
         (f.value->>'createdAt')::timestamptz AS created_at, (f.value->>'resolvedAt')::timestamptz AS resolved_at
  FROM snapshots s, jsonb_each(s.state->'flags') f;

CREATE OR REPLACE VIEW fix_requests_v AS
  SELECT s.agency_id, r.value->>'id' AS id, r.value->>'siteId' AS site_id, r.value->>'itemId' AS item_id,
         r.value->>'priority' AS priority, r.value->>'status' AS status, r.value->>'note' AS note,
         (r.value->>'requestedAt')::timestamptz AS requested_at, (r.value->>'updatedAt')::timestamptz AS updated_at
  FROM snapshots s, jsonb_each(s.state->'fixReqs') r;

CREATE OR REPLACE VIEW audit_log_v AS
  SELECT s.agency_id, e->>'id' AS id, e->>'siteId' AS site_id, e->>'kind' AS kind, e->>'text' AS text,
         (e->>'at')::timestamptz AS at
  FROM snapshots s, jsonb_array_elements(s.state->'log') e;
