# feedBack Plugin: Section Map

A plugin for [feedBack](https://github.com/got-feedBack/feedBack) that shows a minimap bar of the full song structure at the top of the player. Click any section to jump to it.

## Features

- **Color-coded sections** — intro (blue), verse (green), chorus (yellow), bridge (purple), solo (red), breakdown (orange), outro (gray)
- **Clickable navigation** — click anywhere on the bar to jump to that point in the song
- **Playback position** — white marker shows current position, active section highlighted
- **Always visible** — sits between the HUD and the highway, doesn't obstruct notes
- **Automatic** — appears when you play a song, disappears when you leave the player
- **Difficulty glasses (optional)** — each section fills a small glass with its current difficulty, when [Difficulty Ladder](https://github.com/get-flashbacks/feedback-plugin-difficulty-ladder) is installed. See below.

## Installation

```bash
cd /path/to/feedBack/plugins
git clone https://github.com/got-feedBack/feedBack-plugin-sectionmap.git section_map
docker compose restart
```

The section map automatically appears at the top of the player when you play a song.

## Difficulty glasses (optional)

Section Map is standalone: section colors, labels, click-to-seek and wheel nudging
all work with no other plugin installed.

The per-section **difficulty glass** is the one optional feature, and it needs
[Difficulty Ladder](https://github.com/get-flashbacks/feedback-plugin-difficulty-ladder)
installed alongside it. Difficulty Ladder works out how hard each section is and
publishes that as a fill level and a glass size; Section Map renders whatever it
hands over. Without it, the section map looks the same minus the glasses — no
errors, no placeholder.

| Requirement | Value |
|---|---|
| Peer plugin | [Difficulty Ladder](https://github.com/get-flashbacks/feedback-plugin-difficulty-ladder), optional |
| Payload floor | **v0.12.0** — the first release documenting the payload shape below |
| Event consumed | `difficulty:sections-updated` (schema `difficulty_ladder.sections.v2`) |
| Feature-detected via | `window._ddCapabilities.sectionDifficulty` |

Notes on compatibility:

- "Difficulty Ladder is installed" is not on its own a compatibility statement.
  Section Map subscribes only once the peer advertises the capability marker
  above; a build that doesn't is treated as not providing glasses.
- Older builds did emit the event (it shipped in v0.2.0), and Section Map cannot
  read a peer's version, so they still render glasses — computed with the
  formula that plugin used before v0.9.11, which can disagree with Difficulty
  Ladder's own HUD. That, not a rendering failure, is what the v0.12.0 floor is
  about. If your glasses and Difficulty Ladder's HUD disagree, update it.
- Any payload entry Section Map can't read is dropped rather than painted, so a
  malformed or unexpected payload shows no glass instead of a wrong one.
- Difficulty Ladder also emits a newer, render-neutral
  `difficulty:sections-updated-v3` payload. Section Map does not consume it yet —
  it renders whatever v2 carries, which that plugin keeps emitting unchanged.

## License

MIT
