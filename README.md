# feedBack Plugin: Section Map

A plugin for [feedBack](https://github.com/got-feedBack/feedBack) that shows a minimap bar of the full song structure at the top of the player. Click any section to jump to it.

## Features

- **Color-coded sections** — intro (blue), verse (green), chorus (yellow), bridge (purple), solo (red), breakdown (orange), outro (gray)
- **Clickable navigation** — click anywhere on the bar to jump to that point in the song
- **Playback position** — white marker shows current position, active section highlighted
- **Always visible** — sits between the HUD and the highway, doesn't obstruct notes
- **Automatic** — appears when you play a song, disappears when you leave the player
- **Difficulty tier rail (optional)** — each section shows a small rail of lit segments for its current difficulty tier, with an outline marking the tier it plays in full, when [Difficulty Ladder](https://github.com/get-flashbacks/feedback-plugin-difficulty-ladder) is installed. See below.

## Installation

```bash
cd /path/to/feedBack/plugins
git clone https://github.com/got-feedBack/feedBack-plugin-sectionmap.git section_map
docker compose restart
```

The section map automatically appears at the top of the player when you play a song.

## Difficulty tier rail (optional)

Section Map is standalone: section colors, labels, click-to-seek and wheel nudging
all work with no other plugin installed.

The per-section **difficulty tier rail** is the one optional feature, and it needs
[Difficulty Ladder](https://github.com/get-flashbacks/feedback-plugin-difficulty-ladder)
installed alongside it. Difficulty Ladder works out how hard each section is and
publishes each section's current tier and the tier it plays in full; Section Map
renders that as a rail of segments — one per tier, the first `current + 1` lit, and
the full-detail tier outlined. A block too narrow for segments collapses to a
single lit marker. Without the peer, the section map looks the same minus the rails
— no errors, no placeholder.

| Requirement | Value |
|---|---|
| Peer plugin | [Difficulty Ladder](https://github.com/get-flashbacks/feedback-plugin-difficulty-ladder), optional |
| Preferred event | `difficulty:sections-updated-v3` (schema `difficulty_ladder.sections.v3`) |
| Fallback event | `difficulty:sections-updated` (schema `difficulty_ladder.sections.v2`), floor **v0.12.0** |
| Feature-detected via | `window._ddCapabilities.sectionDifficulty` (v3 additionally via `window._ddCapabilities.sectionsSchema === 'difficulty_ladder.sections.v3'`) |

Notes on compatibility:

- "Difficulty Ladder is installed" is not on its own a compatibility statement.
  Section Map subscribes only once the peer advertises the capability marker
  above; a build that doesn't is treated as not providing rails.
- **v3 is preferred.** When the peer advertises the render-neutral
  `difficulty_ladder.sections.v3` payload, Section Map consumes it and renders the
  tiers directly. This is a feature detection (`sectionsSchema`), not a
  version-pin; the peer emits no version on its marker.
- **v2 is the bounded-transition fallback.** A peer that predates v3 still emits
  `difficulty:sections-updated`; Section Map reconstructs a coarse rail from its
  `fillPercentage` so un-upgraded peers keep painting. v2 cannot show ladder depth
  above the full-detail threshold the way v3 can, which is why v3 is preferred.
  The v2 payload floor is **v0.12.0**, the first release documenting that shape —
  and it is documentation, not enforcement (see below).
- Older v2 builds did emit the event (it shipped in v0.2.0), and Section Map
  cannot read a peer's version, so they still render rails — computed with the
  formula that plugin used before v0.9.11, which can disagree with Difficulty
  Ladder's own HUD. That, not a rendering failure, is what the v0.12.0 floor is
  about. If your rail and Difficulty Ladder's HUD disagree, update it.
- Any payload entry Section Map can't read is dropped rather than painted, so a
  malformed or unexpected payload shows no rail instead of a wrong one.
- The rail is a focus stop: hovering or focusing a section with tier data reports
  `Section name · tier X of Y · full detail at Z` in the same wording Difficulty
  Ladder's own guide uses.

## License

MIT
