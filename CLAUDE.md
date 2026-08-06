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
- **No bespoke API with `feedback-plugin-dynamic-difficulty`.** Both plugins
  independently read the same Host surface (`highway.getPhrases()` /
  `hasPhraseData()` / `getMastery()`) for section-difficulty data — this
  plugin works whether or not dynamic_difficulty is installed, as long as
  *something* populates that phrase data. Don't reach into
  dynamic_difficulty's own globals/localStorage directly; go through
  `window.highway`.
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
(best-practices rule 4: bump on every release; the plugin manager uses
this to detect updates). Patch (`1.x.y`) for fixes, minor (`1.x.0`) for
new features, matching normal semver conventions.
