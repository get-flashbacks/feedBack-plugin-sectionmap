# Slopsmith Plugin: Section Map

A plugin for [Slopsmith](https://github.com/got-feedback/feedback) that shows a minimap bar of the full song structure at the top of the player. Click any section to jump to it.

## Features

- **Color-coded sections** — intro (blue), verse (green), chorus (yellow), bridge (purple), solo (red), breakdown (orange), outro (gray)
- **Clickable navigation** — click anywhere on the bar to jump to that point in the song
- **Playback position** — white marker shows current position, active section highlighted
- **Always visible** — sits between the HUD and the highway, doesn't obstruct notes
- **Automatic** — appears when you play a song, disappears when you leave the player
- **Glass-filling difficulty indicator** — each section renders a small glass in its bottom-right
  corner. Glass **size** reflects that section's own peak authored difficulty relative to the
  song's hardest section (a harder section gets a taller glass); glass **fill level** reflects how
  much of that section's difficulty range the current master-difficulty setting reaches. A section
  with no phrase-level difficulty data for its time range (or a song with none at all) simply shows
  no glass — this degrades silently, it never errors.

  This reads section-difficulty data directly off the Host's own `window.highway` object
  (`getPhrases()` / `hasPhraseData()` / `getMastery()`) — the same surface
  [`feedback-plugin-dynamic-difficulty`](https://github.com/get-flashbacks/feedback-plugin-dynamic-difficulty)'s
  own in-player glass HUD consumes. There is no bespoke API between the two plugins: this plugin
  works with any producer of phrase data (dynamic_difficulty's generator, or a hand-authored
  ladder), and dynamic_difficulty doesn't need to be installed for the rest of this plugin's minimap
  to work. See `feedback-plugin-dynamic-difficulty`'s `COMPLIANCE.md` for the full contract writeup.

  As of this writing, feedBack has no separate "difficulty maker" screen distinct from the player —
  the glass rendering lives in one shared function (`_smComputeGlass`/`_smGlassHtml`) precisely so
  that if/when such a screen exists and mounts this same minimap, it renders identically without
  further work.

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/got-feedback/feedback-plugin-sectionmap.git section_map
docker compose restart
```

The section map automatically appears at the top of the player when you play a song.

## License

MIT
