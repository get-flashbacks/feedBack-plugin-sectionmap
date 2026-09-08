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
  works standalone with no ladder plugin installed — `_smIsDynamicDifficultyAvailable()`
  gates the subscription on `window._ddCapabilities`, absent means no
  glasses are shown, not an error — but when a ladder plugin *is* installed,
  this is the API, not a coincidence of both sides reading the same Host
  state. See `difficulty_ladder`'s `INTEGRATION.md` for the full contract
  (fill formula, fallback/timing behavior). Load order matters: plugins load
  alphabetically, so `difficulty_ladder` (< `section_map`) sets
  `window._ddCapabilities` before this plugin's one-time availability check
  runs.
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
