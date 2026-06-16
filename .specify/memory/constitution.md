# Section Map Plugin Constitution

The Section Map plugin (id: `section_map`) overlays a horizontal
minimap of the song's structure (intro/verse/chorus/etc.) at the top
of the player. Each block is clickable to seek; the playhead is
tracked live.

## Core Principles

### I. Frontend-Only, Zero Backend
There is no `routes.py`, no database, no API. All data is read from
the host's `highway` global (`getSections()`, `getSongInfo()`,
`getTime()`). New plugin behaviors that require server-side state are
out of scope here.

### II. DOM Surgery, Not Highway Modification
The plugin inserts `#section-map` as the first child of the host's
`#player` div (`screen.js:39-40`). It does not modify the highway
canvas, the audio element, or any other player surface. Removal on
exit is symmetric — the plugin owns its node and only its node.

### III. Single Idempotent Setup
A single guard `__slopsmithSectionMapHooksInstalled`
(`screen.js:176-178`) covers BOTH the 200ms poller AND the
`playSong` / `showScreen` wrappers. Re-evaluation MUST NOT start a
second poller or grow either wrapper chain.

### IV. Defensive Seek
Seeking during playback fails on unbuffered regions in some browsers,
so click/wheel handlers pause-then-seek-then-resume on the `seeked`
event (`screen.js:67-73`, `screen.js:91-100`). `lastAudioTime` is
also updated to suppress the host's jump detector
(`screen.js:62`, `screen.js:88`).

### V. Color Heuristic, Not Authority
Section colors are chosen by case-insensitive substring match against
a fixed palette (`SM_COLORS`, `screen.js:8-20`). When core ships a
proper section taxonomy, this plugin should follow — until then the
heuristic is the contract.

## Inheritance from Slopsmith Core

Reads `window.highway.{getSections, getSongInfo, getTime}`,
`document.getElementById('player')`, `document.getElementById('audio')`,
and the global `lastAudioTime` (typeof-checked).
Wraps `window.playSong` (async) and `window.showScreen`. Assumes
core re-emits sections with stable identity per song so `sections !==
_smSections` is a valid change-detection trigger (`screen.js:113-117`).

## Governance

The visual band (height 20px, opacity 0.5/1.0) is part of the public
look-and-feel; changes affect overlap with the highway and any
overlay plugins. Color palette additions are non-breaking; renames
are breaking.

**Version**: 1.0.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-05-09
