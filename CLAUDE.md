# Section Map — AI Agent Guide

Draws a minimap bar of the current song's structure over the player, with
click/wheel seeking and a per-section "glass fill" difficulty indicator.
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
  `difficulty:sections-updated` event, not independent `highway` reads
  (issue #63).** This plugin used to independently read `highway.getPhrases()`
  / `hasPhraseData()` / `getMastery()` for section-difficulty data — that
  changed when the glass-fill rendering was rewritten to consume
  `difficulty_ladder`'s emitted event instead (`_smUpdateDifficultyFills` /
  `_smGetSectionDifficulty` just render whatever `fillPercentage` /
  `glassSize` the event's payload carries per section). This plugin still
  works standalone with no ladder plugin installed — the glasses are its only
  dependent feature, and `_smIsDynamicDifficultyAvailable()` gates the
  subscription, so absent means no glasses rather than an error — but when a
  ladder plugin *is* installed, this is the API, not a coincidence of both
  sides reading the same Host state. See `difficulty_ladder`'s `INTEGRATION.md`
  for the full contract (fill formula, fallback/timing behavior). The short
  version is pinned as a comment block above `_smIsDynamicDifficultyAvailable()`
  in `screen.js`; keep the two in sync if either changes.
- **The peer handshake is re-checked, not decided once (issue #13).**
  `_smEnsureDifficultySubscription()` runs from `_smStartRealtimeHooks()` *and*
  from every `_smUpdate()` tick, so a Difficulty Ladder that loads or reloads
  after this plugin is still picked up mid-session. Don't reintroduce a
  one-shot check: the old one leaned on alphabetical plugin loading
  (`difficulty_ladder` < `section_map`), which core does not actually promise —
  `feedBack/static/js/session.js` is explicit that "plugins load ASYNCHRONOUSLY,
  so the chain links up in whatever order the race settles". There is no
  readiness event to subscribe to either — the peer sets its marker at top-level
  script execution and declares no capability domain — so the 200 ms tick is the
  retry. `_smIsDynamicDifficultyAvailable()` requires
  `window._ddCapabilities.sectionDifficulty === true`, not merely that some
  `_ddCapabilities` global exists, so a foreign user of that global can't unlock
  a subscription we can't render. That function must stay reachable-before-bus:
  it returns early when `feedBack.on` isn't a function yet, and once it has
  registered a handler `_smDifficultySubscribed` stays true even if the bus
  returned no unsubscribe handle — otherwise the tick would re-register one
  handler per 200ms.
- **The peer compatibility floor is Difficulty Ladder v0.12.0, not v0.2.0.**
  v0.2.0 is when the *event* first shipped; v0.12.0 is where that plugin's
  CHANGELOG documents the `difficulty_ladder.sections.v2` payload shape this
  plugin renders. Issue #13 proposed publishing `v0.9.13` as the floor, but that
  version was never released — the peer's own README and CHANGELOG call
  `v0.12.0` the real floor, so that's the number this repo publishes. The floor
  is documentation, not enforcement, and shouldn't be restated as a check: the
  marker carries no version and predates v0.2.0, so a below-floor peer passes it
  and still paints glasses. What actually changed below the floor is the
  arithmetic behind `fillPercentage` (v0.9.11 aligned it with the peer's own
  HUD), so an old peer's glasses can *disagree* with Difficulty Ladder's HUD
  rather than fail to render. Keep the README table and the `screen.js` comment
  block on the same number.
- **Payloads are normalized, not trusted (`_smNormalizeSectionDifficulties`).**
  Entries without a finite numeric `fillPercentage` are dropped, which is what
  keeps a malformed payload from painting a misleading near-empty glass — and
  what stops the peer's NaN arithmetic (a NaN `mastery` or phrase difficulty)
  from reaching the style attribute as `height:NaN%`. A container that isn't an
  object is ignored entirely so the last good state survives. `null` return
  means "ignore the event", `{}` means "clear the glasses" — don't collapse those
  two. `glassSize` is the one payload field that reaches markup unescaped (as
  `data-size`), so `_smGlassSize()` resolves it against `SM_GLASS_SIZES` before
  either render path interpolates it.
- **v3 of the peer contract is deliberately not consumed.**
  `difficulty:sections-updated-v3` is a render-neutral payload that
  `difficulty_ladder` emits *alongside* v2. Consuming it means reworking the
  glass rendering (v3 carries the facts, not the metaphor) — that's this repo's
  issue #14, and the peer's own transition policy exists so an un-upgraded
  Section Map keeps working on the frozen v2 event meanwhile. Don't sniff
  `schema` to "upgrade" this plugin to v3 in passing.
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
