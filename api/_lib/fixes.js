// The fixer. Every fix is a two-phase operation:
//
//   plan(finding)  → { ops: [{ target, field, before, after, describe }] }   — reads only
//   apply(op)      → writes, returns { snapshot } so the write can be undone
//   revert(op)     → restores the snapshot
//
// Nothing writes without a plan being produced and approved first, and no write happens
// without a snapshot of what it replaced. A site with `paused: true` refuses every write
// (the per-site kill switch).
import { seoKeys, restBase } from './connectors/wordpress.js';

export class FixBlocked extends Error {
  constructor(msg) { super(msg); this.name = 'FixBlocked'; }
}

function assertWritable(site) {
  if (site?.paused) throw new FixBlocked('Writes are paused for this site (kill switch is on).');
}

export const FIXES = {
  /* ---------- f7 ---------- */
  'set-canonical': {
    label: 'Set the canonical URL to the page itself',
    itemId: 'f7',
    async plan({ finding, seoPlugin }) {
      const key = seoKeys(seoPlugin).canonical;
      return [{
        target: { type: finding.type || 'posts', id: finding.id, url: finding.url },
        field: `meta.${key}`,
        before: finding.actual || '',
        after: finding.expected,
        describe: finding.actual
          ? `Repoint canonical from ${finding.actual} to ${finding.expected}`
          : `Add canonical ${finding.expected}`,
      }];
    },
    async apply({ connector, op, seoPlugin }) {
      const key = seoKeys(seoPlugin).canonical;
      const row = await connector.updatePost(op.target.id, { meta: { [key]: op.after } }, op.target.type);
      return { snapshot: { field: op.field, value: op.before }, verify: row?.meta?.[key] === op.after };
    },
    async revert({ connector, op, seoPlugin }) {
      const key = seoKeys(seoPlugin).canonical;
      await connector.updatePost(op.target.id, { meta: { [key]: op.snapshot.value } }, op.target.type);
    },
  },

  /* ---------- im2 ---------- */
  'set-image-alt': {
    label: 'Write alt text from the image file name',
    itemId: 'im2',
    async plan({ finding }) {
      const alt = altFromFilename(finding.filename || finding.url);
      if (!alt) return [];                       // nothing meaningful to derive — leave it for a human
      return [{
        target: { type: 'media', id: finding.id, url: finding.url },
        field: 'alt_text',
        before: '',
        after: alt,
        describe: `Set alt text to "${alt}"`,
        lowConfidence: true,                     // derived from a filename, so worth eyeballing
      }];
    },
    async apply({ connector, op }) {
      const row = await connector.updateMedia(op.target.id, { alt_text: op.after });
      return { snapshot: { field: 'alt_text', value: op.before }, verify: row?.alt_text === op.after };
    },
    async revert({ connector, op }) { await connector.updateMedia(op.target.id, { alt_text: op.snapshot.value }); },
  },

  /* ---------- f5 ---------- */
  'noindex-thin-archive': {
    label: 'Noindex a thin archive',
    itemId: 'f5',
    async plan({ finding, seoPlugin }) {
      const key = seoKeys(seoPlugin).robots;
      return [{
        target: { type: 'categories', id: finding.id, url: finding.url, name: finding.name },
        field: `meta.${key}`,
        before: [],
        after: ['noindex', 'follow'],
        describe: `Noindex "${finding.name}" (${finding.count} product${finding.count === 1 ? '' : 's'})`,
      }];
    },
    async apply({ connector, op, seoPlugin }) {
      const key = seoKeys(seoPlugin).robots;
      const row = await connector.updateTerm(op.target.id, { meta: { [key]: op.after } }, 'categories');
      return { snapshot: { field: op.field, value: op.before }, verify: !!row };
    },
    async revert({ connector, op, seoPlugin }) {
      const key = seoKeys(seoPlugin).robots;
      await connector.updateTerm(op.target.id, { meta: { [key]: op.snapshot.value } }, 'categories');
    },
  },

  /* ---------- t8 ---------- */
  'set-author-name': {
    label: 'Replace a placeholder display name',
    itemId: 't8',
    async plan({ finding, ctx }) {
      const specific = ctx?.authorNames?.[finding.id];
      const proposed = specific || ctx?.defaultAuthorName;
      if (!proposed) {
        throw new FixBlocked(`No real name supplied for account #${finding.id} ("${finding.name}"). Set one in Site settings before running this fix.`);
      }
      return [{
        target: { type: 'users', id: finding.id },
        field: 'name',
        before: finding.name,
        after: proposed,
        describe: `Rename account #${finding.id} from "${finding.name}" to "${proposed}"`,
        lowConfidence: !specific,               // the default name applies to every placeholder account — worth a look
      }];
    },
    async apply({ connector, op }) {
      const row = await connector.updateUser(op.target.id, { name: op.after });
      return { snapshot: { field: 'name', value: op.before }, verify: row?.name === op.after };
    },
    async revert({ connector, op }) { await connector.updateUser(op.target.id, { name: op.snapshot.value }); },
  },

  /* ---------- f6 ---------- */
  'purge-revisions': {
    label: 'Purge old post revisions',
    itemId: 'f6',
    async plan({ finding, ctx }) {
      const keep = ctx?.revisionKeep ?? 5;
      return [{
        target: { type: 'posts', id: finding.id },
        field: 'revisions',
        before: finding.count,
        after: keep,
        describe: `Delete ${Math.max(0, finding.count - keep)} of ${finding.count} revisions on post #${finding.id}, keeping the newest ${keep}`,
        irreversible: true,                      // deleted revisions cannot be restored
      }];
    },
    async apply({ connector, op, ctx }) {
      const res = await connector.purgeRevisions(op.target.id, ctx?.revisionKeep ?? 5);
      return { snapshot: { field: 'revisions', value: op.before, irreversible: true }, verify: res?.remaining <= op.after, detail: res };
    },
    async revert() { throw new FixBlocked('Deleted revisions cannot be restored.'); },
  },

  /* ---------- f3 ---------- */
  'rewrite-legacy-links': {
    label: 'Rewrite legacy permalink prefixes in content',
    itemId: 'f3',
    async plan({ finding, connector, ctx }) {
      const replacement = ctx?.prefixReplacements?.[finding.prefix];
      if (!replacement) throw new FixBlocked(`No replacement configured for the legacy prefix "${finding.prefix}".`);
      const { data } = await connector.request(`/wp-json/wp/v2/${restBase(finding.type || 'post')}/${finding.id}`, { query: { context: 'edit' } });
      const before = typeof data.content === 'string' ? data.content : (data.content?.raw ?? data.content?.rendered ?? '');
      const after = before.split(finding.prefix).join(replacement);
      if (after === before) return [];
      const hits = before.split(finding.prefix).length - 1;
      return [{
        target: { type: finding.type || 'posts', id: finding.id, url: finding.url },
        field: 'content',
        before, after,
        describe: `Rewrite ${hits} link${hits === 1 ? '' : 's'} from ${finding.prefix} to ${replacement}`,
        diffHint: { from: finding.prefix, to: replacement, hits },
      }];
    },
    async apply({ connector, op }) {
      const row = await connector.updatePost(op.target.id, { content: op.after }, op.target.type);
      const now = typeof row?.content === 'string' ? row.content : (row?.content?.raw ?? '');
      return { snapshot: { field: 'content', value: op.before }, verify: now === op.after };
    },
    async revert({ connector, op }) { await connector.updatePost(op.target.id, { content: op.snapshot.value }, op.target.type); },
  },

  /* ---------- s3 ---------- */
  'inject-organization-schema': {
    label: 'Add Organization schema',
    itemId: 's3',
    async plan({ finding, site, ctx }) {
      if (finding.type !== 'Organization') return [];
      const name = ctx?.organizationName || site?.name;
      const url = ctx?.siteUrl || (site?.domain ? `https://${site.domain}` : null);
      if (!name || !url) throw new FixBlocked('Organization schema needs the business name and site URL — set them in Site settings.');
      const schema = { '@context': 'https://schema.org', '@type': 'Organization', name, url, ...(ctx?.logoUrl ? { logo: ctx.logoUrl } : {}), ...(ctx?.sameAs?.length ? { sameAs: ctx.sameAs } : {}) };
      return [{
        target: { type: 'option', id: 'rankops_organization_schema' },
        field: 'rankops_organization_schema',
        before: '',
        after: JSON.stringify(schema),
        describe: `Publish Organization schema for "${name}"`,
        note: 'Injected sitewide by the RankOps companion plugin.',
      }];
    },
    async apply({ connector, op }) {
      const row = await connector.updateSettings({ [op.field]: op.after });
      return { snapshot: { field: op.field, value: op.before }, verify: row?.[op.field] === op.after };
    },
    async revert({ connector, op }) { await connector.updateSettings({ [op.snapshot.field]: op.snapshot.value }); },
  },

  /* ---------- sc1 ---------- */
  'close-registration': {
    label: 'Close open user registration',
    itemId: 'sc1',
    async plan() {
      return [{
        target: { type: 'option', id: 'users_can_register' },
        field: 'users_can_register',
        before: true,
        after: false,
        describe: 'Turn off open user registration',
      }];
    },
    async apply({ connector, op }) {
      const row = await connector.updateSettings({ users_can_register: false });
      return { snapshot: { field: 'users_can_register', value: true }, verify: row?.users_can_register === false };
    },
    async revert({ connector, op }) { await connector.updateSettings({ users_can_register: op.snapshot.value }); },
  },
};

/* ---------- orchestration ---------- */

/** Turn a check's findings into a reviewable plan. Reads only — nothing is written here. */
export async function planFix(fixId, { connector, site, findings, ctx = {}, seoPlugin = 'Rank Math', limit = 50 }) {
  const fix = FIXES[fixId];
  if (!fix) throw new Error(`unknown fix: ${fixId}`);
  const ops = [];
  const blocked = [];
  for (const finding of findings.slice(0, limit)) {
    try {
      const planned = await fix.plan({ finding, connector, site, ctx, seoPlugin });
      for (const op of planned) ops.push({ ...op, fixId, itemId: fix.itemId });
    } catch (e) {
      if (e instanceof FixBlocked) blocked.push({ finding, reason: e.message });
      else throw e;
    }
  }
  return { fixId, itemId: fix.itemId, label: fix.label, ops, blocked, dryRun: true };
}

/** Execute an approved plan. Each op that succeeds carries the snapshot needed to undo it. */
export async function applyPlan({ connector, site, plan, ctx = {}, seoPlugin = 'Rank Math' }) {
  assertWritable(site);
  const fix = FIXES[plan.fixId];
  const applied = [], failed = [];
  for (const op of plan.ops) {
    try {
      const res = await fix.apply({ connector, op, ctx, seoPlugin });
      if (res.verify === false) throw new Error('write did not verify — the site reported a different value back');
      applied.push({ ...op, snapshot: res.snapshot, appliedAt: new Date().toISOString(), detail: res.detail });
    } catch (e) {
      failed.push({ ...op, error: e.message });
    }
  }
  return { fixId: plan.fixId, itemId: plan.itemId, applied, failed, appliedAt: new Date().toISOString() };
}

/** Undo applied operations, newest first. */
export async function revertOperations({ connector, site, operations, seoPlugin = 'Rank Math' }) {
  assertWritable(site);
  const reverted = [], failed = [];
  for (const op of [...operations].reverse()) {
    const fix = FIXES[op.fixId];
    try {
      if (!fix) throw new Error(`unknown fix: ${op.fixId}`);
      if (op.snapshot?.irreversible) throw new FixBlocked('This operation is irreversible.');
      await fix.revert({ connector, op, seoPlugin });
      reverted.push(op);
    } catch (e) {
      failed.push({ ...op, error: e.message });
    }
  }
  return { reverted, failed };
}

function altFromFilename(nameOrUrl) {
  const base = String(nameOrUrl || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '');
  const words = base.replace(/[-_]+/g, ' ').replace(/\b\d{3,}\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words || words.length < 3) return null;
  if (/^(img|dsc|dscn|pxl|photo|image|screenshot|untitled)$/i.test(words.replace(/\s/g, ''))) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function getFix(id) { return FIXES[id] || null; }
export function fixIds() { return Object.keys(FIXES); }
