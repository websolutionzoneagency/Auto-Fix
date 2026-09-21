// Which checklist items a machine can honestly handle, and how.
//
//   tier 'auto'   — the scanner decides the item AND a fixer can repair it unattended (with a diff + rollback)
//   tier 'check'  — the scanner decides the item; repairing it needs a human (destructive, or needs judgement)
//   tier 'manual' — a person owns it. Regulatory claims, stocking calls, anything asserting first-party data.
//
// Anything not named below is 'manual' by design: silence here means "a machine must not touch this".
// Shared by the front end (to label items) and the API (to route a scan), so the two can never disagree.

/** itemId → id of the read-only check that decides it. */
export const ITEM_CHECKS = {
  f1:  'plugin-config',        f2:  'sitemap',              f3:  'legacy-links',
  f4:  'duplicate-categories', f5:  'thin-archives',        f6:  'revisions',
  f7:  'canonical',            f8:  'broken-links',         f9:  'core-web-vitals',
  t1:  'trust-pages',          t7:  'broken-links',         t8:  'author-identity',
  t9:  'dead-nav-links',
  n8:  'schema-presence',      n9:  'schema-presence',
  r4:  'outbound-links',
  s3:  'schema-presence',      s6:  'schema-presence',
  im1: 'image-filenames',      im2: 'image-alt',            im5: 'sitemap',
  l1:  'orphan-pages',
  sc1: 'open-registration',    sc3: 'debug-mode',
  ga1: 'analytics-tags',
  cp2: 'click-depth',          cp5: 'faceted-urls',
  bp4: 'click-depth',
};

/** itemId → id of the fixer that can repair it unattended. Presence here implies tier 'auto'. */
export const ITEM_FIXES = {
  f3:  'rewrite-legacy-links',
  f5:  'noindex-thin-archive',
  f6:  'purge-revisions',
  f7:  'set-canonical',
  t8:  'set-author-name',
  im2: 'set-image-alt',
  s3:  'inject-organization-schema',
  sc1: 'close-registration',
};

/** Why a checked-but-not-fixed item stays manual — shown in the UI so the limit is explicit, not mysterious. */
export const FIX_BLOCKED_REASON = {
  f4:  'Merging categories issues 301s and moves products — destructive, needs your call on which survives.',
  f8:  'A broken link can be repointed, redirected or removed; only you know which.',
  f9:  'Core Web Vitals fixes are theme and hosting work, not content edits.',
  t1:  'A missing policy page needs real policy text, not generated filler.',
  t7:  'A dead trust-page link needs a destination chosen by a human.',
  t9:  'A dead nav link needs a destination chosen by a human.',
  n8:  'FAQ schema must mirror real on-page answers — generating it would fabricate content.',
  n9:  'Product schema must match live catalogue facts; drafted for approval, never auto-published.',
  r4:  'Removing an outbound link can break a citation — flagged for review.',
  s6:  'Breadcrumb schema depends on the theme; drafted for approval.',
  im1: 'Renaming a media file changes its URL and can break existing links.',
  l1:  'An orphan page needs a link from somewhere a human chooses.',
  sc3: 'Turning off debug display is a server config change (wp-config.php), outside the REST API.',
  ga1: 'Installing an analytics tag touches the theme; we report, you install.',
  cp2: 'A missing category page needs catalogue decisions.',
  cp5: 'Facet rules depend on which filters you want indexed.',
  f1:  'Plugin configuration changes can break a live site; reported, not changed.',
  f2:  'Sitemap submission happens in Search Console under your Google account.',
  im5: 'Image sitemap generation is a plugin setting.',
  bp4: 'Fixing click depth means changing navigation — a design decision.',
};

export function tierOf(itemId) {
  if (ITEM_FIXES[itemId]) return 'auto';
  if (ITEM_CHECKS[itemId]) return 'check';
  return 'manual';
}

export const TIER_LABEL = { auto: 'auto-fix', check: 'auto-check', manual: 'manual' };

/** Decorate the checklist with tier info for rendering. */
export function withAutomation(checklist) {
  return checklist.map(cat => ({
    ...cat,
    items: cat.items.map(it => ({
      ...it,
      tier: tierOf(it.id),
      check: ITEM_CHECKS[it.id] || null,
      fix: ITEM_FIXES[it.id] || null,
      fixBlockedReason: FIX_BLOCKED_REASON[it.id] || null,
    })),
  }));
}

export function tierCounts(checklist) {
  const c = { auto: 0, check: 0, manual: 0 };
  for (const cat of checklist) for (const it of cat.items) c[tierOf(it.id)]++;
  return c;
}

/** The distinct checks a full scan of one site has to run. */
export function allCheckIds() { return [...new Set(Object.values(ITEM_CHECKS))]; }

/** checkId → every checklist item whose state it decides. */
export function itemsForCheck(checkId) {
  return Object.keys(ITEM_CHECKS).filter(id => ITEM_CHECKS[id] === checkId);
}
