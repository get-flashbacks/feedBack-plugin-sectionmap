# Section Map — AI Agent Guide

Draws a minimap bar of the current song's structure over the player, with
click/wheel seeking and a per-section difficulty "tier rail" indicator.
Frontend-only — there's no `routes.py`; all logic lives in `screen.js`,
reading state straight off the Host's `window.highway` object.

## Plugin-spec compliance (see got-feedBack/feedBack-plugin-spec)

- **Folder name must equal `plugin.json`'s `id` exactly** (case-sensitive:
  `section_map`) — a mismatch is a silent skip at plugin discovery.
- **Idempotent script guard, already in place:** the `playSong` wrapping,
  the `screen:changed` listener, and the `setInterval` poller are all
  installed inside a single `window.__slopsmithSectionMapHooksInstalled`
  guard at the bottom of `screen.js`. The Host may re-execute `screen.js` on
  plugin reload — any new top-level listener/timer needs to go inside that
  same guard, not a bare call alongside it.
- **Mount/unmount tracks the player screen via the `screen:changed` event on
  `window.feedBack`, NOT by monkey-patching `window.showScreen`.** Core's own
  internal navigation (`playSong`, `closeCurrentSong`, …) calls its own
  imported `showScreen()` directly and never touches `window.showScreen` —
  see `feedBack/static/js/session.js`'s comment on `showScreen()` re:
  feedBack#923/#924. Patching `window.showScreen` here would silently never
  fire for real navigation; this was an actual regression until fixed.
- **Section-difficulty data comes from `difficulty_ladder`'s
  `difficulty:sections-updated` / `difficulty:sections-updated-v3` events, not
  independent `highway` reads (issue #63).** This plugin used to independently
  read `highway.getPhrases()` / `hasPhraseData()` / `getMastery()` for
  section-difficulty data — that changed when the rendering was rewritten to
  consume `difficulty_ladder`'s emitted events instead. Issue #14 then replaced
  the old glass-fill rendering (which consumed the v2 `fillPercentage` /
  `glassSize` fields) with a semantic tier rail: `_smOnSectionsUpdatedV3` /
  `_smNormalizeSectionTiers` / `_smGetSectionTier` carry each section's
  `current_tier` / `top_tier` / `max_tier` / `has_chart_content`, and
  `_smTierModel` / `_smRenderTierRail` / `_smUpdateTierRails` render it. This
  plugin still works standalone with no ladder plugin installed — the rails are
  its only dependent feature, and `_smIsDynamicDifficultyAvailable()` gates the
  subscription, so absent means no rails rather than an error — but when a
  ladder plugin *is* installed, this is the API, not a coincidence of both
  sides reading the same Host state. See `difficulty_ladder`'s `INTEGRATION.md`
  for the full contract (tier semantics, fallback/timing behavior). The short
  version is pinned as a comment block above `_smIsDynamicDifficultyAvailable()`
  in `screen.js`; keep the two in sync if either changes.
- **v3 is preferred; v2 is a bounded-transition fallback.** When
  `_smPeerSpeaksV3()` sees `window._ddCapabilities.sectionsSchema ===
  'difficulty_ladder.sections.v3'`, the subscription is to
  `difficulty:sections-updated-v3` and `_smNormalizeSectionTiers` reads its
  `sections` array directly. A peer that predates v3 (marker present, no
  `sectionsSchema`) still gets `difficulty:sections-updated`, and
  `_smNormalizeSectionTiersV2` reconstructs a coarse rail from `fillPercentage`
  (`topTier = maxTier = maxDifficulty`, `currentTier = round(fill × topTier)`)
  while discarding `glassSize` entirely. v3 is feature-detected, never
  version-pinned — the marker carries no version. This is not the "don't sniff
  `schema`" rule: we key off the capability marker the peer publishes, not the
  payload's own `schema` field (which we deliberately ignore). The v2 fallback
  is kept only while the peer's transition policy keeps emitting it; when that
  policy drops v2, delete `_smNormalizeSectionTiersV2` / `_smOnSectionsUpdated`
  and the v2 branch of `_smEnsureDifficultySubscription`.
- **The peer handshake is re-checked, not decided once (issue #13).**
  `_smEnsureDifficultySubscription()` runs from `_smStartRealtimeHooks()` *and*
  from every `_smUpdate()` tick, so a Difficulty Ladder that loads or reloads
  after this plugin is still picked up mid-session. Don't reintroduce a
  one-shot check, and don't reintroduce the *wrong reason* for removing it
  either. The accurate version: when both plugins are 'ready' in one
  `/api/plugins` response, core's `static/js/plugin-loader.js` injects `screen.js`
  files one at a time in sorted order (`name || id`, ties broken by id), so
  `difficulty_ladder` does sort ahead of `section_map` and a one-shot check
  happened to work. That ordering is a property of that one response, not a
  promise — the loader skips any plugin whose status isn't `'ready'`, refetches
  on `plugin-registered` startup events, and the backend "clears its plugin
  registry at the start of `load_plugins()` and repopulates it incrementally
  while HTTP stays up, so every backend restart serves a window of partial (even
  empty) responses". A mid-install peer therefore lands on a later refetch, after
  our script body has run, and our script does not re-run either (the loader's
  `loadedScripts` guard), so the 200 ms tick is the only retry. The peer emits no
  readiness event to subscribe to — it just sets its marker at top-level script
  execution and declares no capability domain. `_smIsDynamicDifficultyAvailable()`
  requires `window._ddCapabilities.sectionDifficulty === true`, not merely that
  some `_ddCapabilities` global exists, so a foreign user of that global can't
  unlock a subscription we can't render. That function must stay
  reachable-before-bus: it returns early when `feedBack.on` isn't a function yet,
  and once it has registered a handler `_smDifficultySubscribed` stays true even
  if the bus returned no unsubscribe handle — otherwise the tick would
  re-register one handler per 200ms.
- **The peer compatibility floor is Difficulty Ladder v0.12.0, not v0.2.0.**
  v0.2.0 is when the *event* first shipped; v0.12.0 is where that plugin's
  CHANGELOG documents the `difficulty_ladder.sections.v2` payload shape this
  plugin renders. Issue #13 proposed publishing `v0.9.13` as the floor, but that
  version was never released — the peer's own README and CHANGELOG call
  `v0.12.0` the real floor, so that's the number this repo publishes. The floor
  is documentation, not enforcement, and shouldn't be restated as a check: the
  marker carries no version and predates v0.2.0, so a below-floor peer passes it
  and still paints rails. What actually changed below the floor is the
  arithmetic behind `fillPercentage` (v0.9.11 aligned it with the peer's own
  HUD), so an old peer's rails can *disagree* with Difficulty Ladder's HUD
  rather than fail to render. The v3 payload supersedes this arithmetic
  entirely, which is why it is preferred. Keep the README table and the
  `screen.js` comment block on the same number.
- **Payloads are normalized, not trusted (`_smNormalizeSectionTiers` /
  `_smNormalizeSectionTiersV2`).** v3 entries without finite numeric `index`,
  `max_tier` and `top_tier` are dropped, which keeps the peer's NaN arithmetic
  from reaching the style attribute. v2 entries without a finite numeric
  `fillPercentage` are dropped the same way. A container that isn't an object,
  or a v3 payload whose `sections` isn't an array, is ignored entirely so the
  last good state survives. `null` return means "ignore the event", `{}` means
  "clear the rails" — don't collapse those two. `current_tier` is allowed to be
  `null` (the peer's "no usable mastery" case): it renders an unlit rail, not a
  zero tier. In v2 `glassSize` is discarded, and in v3 the payload's own `schema`
  field is ignored (we key off the capability marker, not the payload).
- **The rail encodes difficulty semantically, never by size.** `_smTierModel`
  produces `{ maxTier, topTier, currentTier, full }`: `top_tier` 0 with
  `has_chart_content` is the easy-but-playable "full at every position" case
  (`full: true`), `top_tier` 0 without content is silent (`null`, no rail), and
  `current_tier` is clamped to `top_tier`. `_smRenderTierRail` draws
  `maxTier + 1` fixed-size segments, lights the first `currentTier + 1`, and
  outlines the `topTier` segment; `_smShouldCollapse` falls back to a single
  marker on a block too narrow for the segments (a non-positive measured width
  means "not laid out yet", where segments are kept). Colors are the literals
  the peer's own guide uses (`SM_TIER_LIT` `#e8c040`, `SM_TIER_UNLIT`
  `rgba(200,200,200,0.25)`, `SM_TIER_TOP` `#f4d35e`) — deliberately shared by
  meaning, not Host CSS variables. The readable detail `Section name · tier X of
  Y · full detail at Z` (`_smTierSuffix`) is the same wording in the block's
  `title` and its `aria-label`; only tier-bearing blocks get a `tabindex`.
  `_smUpdateTierRails` repaints in place, and a per-section signature
  (`_smTierSignatures`) skips the rails whose data didn't change — no full
  `_smRender()` per peer event. Because the signature tracks tier data, not
  width, a `resize` listener (inside the hooks guard) calls `_smHandleResize`,
  which clears the signatures and repaints so the width-dependent
  segments-vs-marker choice is re-decided.
- **Seeking must go through the Host's canonical funnel**
  (`window.feedBack.seek` / `window.slopsmith.seek`, wrapped by `_smSeek`),
  not by poking `audio.currentTime` directly — see the comment on `_smSeek`
  for why that breaks under native/streaming playback backends. The direct
  `audio.currentTime` path only exists as a last-resort fallback for a Host
  old enough to lack the seek API.
- **No `MutationObserver`, no DOM polling for section data** — `_smUpdate`
  reads `highway.getSections()`/`getSongInfo()`/`getTime()` directly and
  only re-renders the bar when the sections reference actually changes.

## Versioning

Bump `version` in `plugin.json` whenever a change is user-visible — a
rendering fix, a new interaction (click/wheel/hover), a changed setting
(best-practices rule 4: bump on every release — the version is used for
cache-busting the served JS/CSS URL, so an unbumped version means users
keep getting stale cached files after an update). Patch (`1.x.y`) for
fixes, minor (`1.x.0`) for new features, matching normal semver
conventions.
