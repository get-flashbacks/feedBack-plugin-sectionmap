// Section Map plugin
// Shows a minimap bar of the full song structure with clickable sections.
// Includes an optional per-section difficulty tier rail when the Difficulty
// Ladder plugin (difficulty_ladder) is installed.

let _smBar = null;
let _smSections = [];
let _smDuration = 0;
let _smSectionTiers = {}; // Map of section index to a normalized semantic tier entry
let _smDynamicDifficultyAvailable = false;
let _smPoller = null;
let _smPlayerVisible = false;
let _smSongReadyUnsubscribe = null;
let _smDifficultyUnsubscribe = null;
let _smSongReadySubscribed = false;
let _smDifficultySubscribed = false;

// Cached DOM refs for the 5Hz poller, populated by _smRender() (which runs
// only when the section list itself changes) and invalidated by _smRemove().
// Lets _smUpdate() avoid a fresh querySelectorAll('.sm-block')/getElementById
// pass on every single tick.
let _smMarkerEl = null;
let _smBlockEls = [];
// Index of the block last marked "active" (opacity 1), or -1 when unknown
// (forces the next tick to (re)apply opacity instead of assuming default).
let _smActiveIdx = -1;
// Per-section signature of the last rail paint, so a difficulty refresh only
// rebuilds the rails whose tier data actually changed. Aligned with
// _smSections by index; '' means "no tier rail for this section".
let _smTierSignatures = [];

// Most-specific-first: 'pre' must come before 'chorus'/'verse' so a
// "pre-chorus"/"pre-verse" section name (which contains both substrings)
// matches its own color instead of falling through to the base section's.
const SM_COLORS = {
    'pre': '#84cc16',
    'noguitar': '#374151',
    'breakdown': '#f97316',
    'riff': '#06b6d4',
    'intro': '#3b82f6',
    'verse': '#22c55e',
    'chorus': '#eab308',
    'bridge': '#a855f7',
    'solo': '#ef4444',
    'outro': '#6b7280',
    'default': '#4b5563',
};

function _smGetColor(name) {
    const low = name.toLowerCase();
    for (const [key, color] of Object.entries(SM_COLORS)) {
        if (low.includes(key)) return color;
    }
    return SM_COLORS.default;
}

// The tier-rail tokens, shared by meaning with Difficulty Ladder's standalone
// guide (#157): gold is a lit tier, faint grey an unlit one, and the lighter
// gold outline marks `topTier`, the tier from which the entry plays in full.
// Deliberately the same literals the peer uses rather than Host CSS variables —
// the meaning is the peer's contract, and the two renderers must move together
// if either changes.
const SM_TIER_LIT = '#e8c040';
const SM_TIER_UNLIT = 'rgba(200,200,200,0.25)';
const SM_TIER_TOP = '#f4d35e';
// A segment is a fixed size: difficulty is encoded by how many are lit, never
// by changing a segment's size (the flaw the glass metaphor had).
const SM_RAIL_SEGMENT_PX = 5;
const SM_RAIL_GAP_PX = 1;
// Space a segment rail needs beyond the segments themselves (rails are inset
// 2px per side). Below this a block collapses to a single marker instead of a
// fixed-width ornament crowding out its label.
const SM_RAIL_PAD_PX = 4;

function _smSubscribeFeedBackEvent(eventName, handler) {
    if (typeof window.feedBack === 'undefined' || typeof window.feedBack.on !== 'function') return null;
    const unsubscribe = window.feedBack.on(eventName, handler);
    if (typeof unsubscribe === 'function') return unsubscribe;
    if (typeof window.feedBack.off === 'function') return () => window.feedBack.off(eventName, handler);
    return null;
}

// The Difficulty Ladder peer contract. Section Map is standalone: everything
// except the per-section difficulty rail works with no peer plugin at all.
// Only the rail depends on `difficulty_ladder` (formerly "dynamic-difficulty"),
// which owns the events this plugin renders. The full contract lives in that
// plugin's INTEGRATION.md; the parts this file depends on are:
//
//   capability  window._ddCapabilities.sectionDifficulty === true, set at that
//               plugin's top-level script execution. A build that also speaks
//               the render-neutral payload additionally advertises
//               window._ddCapabilities.sectionsSchema ===
//               'difficulty_ladder.sections.v3'.
//   event v3    'difficulty:sections-updated-v3' (schema
//               difficulty_ladder.sections.v3). Preferred when advertised.
//   event v2    'difficulty:sections-updated' (schema
//               difficulty_ladder.sections.v2). Kept only as the bounded-
//               transition fallback for a peer that does not advertise v3 yet.
//               It carries the glass presentation fields (fillPercentage,
//               glassSize); this plugin reads fillPercentage to reconstruct a
//               coarse rail and ignores glassSize entirely.
//   payload v3  event.detail = { schema, player_context, mastery, max_tier,
//               current_phrase_index, sections: [ { id, index, start_time,
//               end_time, is_current, current_tier, top_tier, max_tier,
//               avg_top_tier, has_chart_content, phrases } ] }. Sections are
//               present in `highway.getSections()` order, one entry per section
//               that has an overlapping phrase; the facts rendered here are
//               current_tier, top_tier, max_tier and has_chart_content.
//   floor       v3 is feature-detected via `sectionsSchema`, not version-pinned.
//               v2's documented floor is Difficulty Ladder v0.12.0, the release
//               whose CHANGELOG documents that payload shape.
const _SM_DD_SECTIONS_EVENT = 'difficulty:sections-updated';
const _SM_DD_SECTIONS_V3_EVENT = 'difficulty:sections-updated-v3';
const _SM_DD_SECTIONS_SCHEMA_V3 = 'difficulty_ladder.sections.v3';

// Check whether the Difficulty Ladder peer is installed AND speaking the
// contract above. A bare `_ddCapabilities` global is not enough -- require the
// named marker, so a foreign plugin that happens to use that global (or a stub
// left behind by an earlier session) leaves the rail off rather than
// subscribing to an event whose payload shape we cannot render.
function _smIsDynamicDifficultyAvailable() {
    if (typeof window.feedBack === 'undefined') return false;
    const caps = window._ddCapabilities;
    return !!caps && typeof caps === 'object' && caps.sectionDifficulty === true;
}

// Whether the peer advertises the render-neutral v3 payload. Read at subscribe
// time (and re-read on every retry tick until subscribed), never cached
// forever: the marker appears at the peer's script execution, so a peer that
// loads after this plugin is picked up on a later tick.
function _smPeerSpeaksV3() {
    const caps = window._ddCapabilities;
    return !!caps && typeof caps === 'object' && caps.sectionsSchema === _SM_DD_SECTIONS_SCHEMA_V3;
}

// Validate a `difficulty_ladder.sections.v3` payload's section array.
//
//   null  the payload, or its `sections`, is not the shape we can read. The
//         caller keeps the last good state rather than repainting from noise.
//   {}    a well-formed payload with no renderable section in it, which clears
//         the rails (the "no rail, not a stale one" convention).
//
// Entries are dropped unless they carry finite numeric `index`, `max_tier` and
// `top_tier`. `current_tier` is allowed to be null (the peer emits null when the
// host reports no usable mastery, or the entry has no ladder) -- that renders an
// unlit rail with only the full-detail outline, which is honest, not a zero
// tier. A NaN from the peer's own arithmetic never reaches the markup.
function _smNormalizeSectionTiers(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const sections = payload.sections;
    if (!Array.isArray(sections)) return null;
    const normalized = {};
    for (const entry of sections) {
        if (!entry || typeof entry !== 'object') continue;
        if (!Number.isFinite(entry.index)) continue;
        if (!Number.isFinite(entry.max_tier) || entry.max_tier < 0) continue;
        if (!Number.isFinite(entry.top_tier) || entry.top_tier < 0) continue;
        normalized[entry.index] = {
            index: entry.index,
            max_tier: Math.floor(entry.max_tier),
            top_tier: Math.floor(entry.top_tier),
            current_tier: Number.isFinite(entry.current_tier) ? Math.floor(entry.current_tier) : null,
            has_chart_content: entry.has_chart_content === true,
        };
    }
    return normalized;
}

// Validate a frozen `difficulty_ladder.sections.v2` section map (the bounded-
// transition fallback). Same null/{}/entry contract as the v3 normalizer.
//
// v2 carries presentation decisions, not tiers: `fillPercentage` is the lit
// fraction of a glass and `maxDifficulty` is the entry's top-difficulty (the
// tier it plays in full from). To keep one renderer, reconstruct a coarse rail:
// `topTier = maxTier = maxDifficulty`, `currentTier = round(fill * topTier)`.
// That cannot show ladder depth above the full-detail threshold the way v3 can,
// which is exactly why v3 is preferred; `glassSize` is discarded entirely.
function _smNormalizeSectionTiersV2(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const normalized = {};
    for (const key of Object.keys(raw)) {
        const entry = raw[key];
        if (!entry || typeof entry !== 'object') continue;
        if (!Number.isFinite(entry.fillPercentage)) continue;
        const fill = Math.max(0, Math.min(100, entry.fillPercentage));
        const topTier = Number.isFinite(entry.maxDifficulty)
            ? Math.max(0, Math.floor(entry.maxDifficulty))
            : 0;
        normalized[key] = {
            index: Number(key),
            max_tier: topTier,
            top_tier: topTier,
            current_tier: topTier === 0
                ? (fill >= 100 ? 0 : null)
                : Math.max(0, Math.min(topTier, Math.round((fill / 100) * topTier))),
            has_chart_content: topTier > 0 || fill > 0,
        };
    }
    return normalized;
}

// Get tier data for a section from the Difficulty Ladder peer
function _smGetSectionTier(sectionIndex) {
    if (!_smDynamicDifficultyAvailable) return null;
    // Populated by the peer's difficulty:sections-updated[-v3] event.
    return _smSectionTiers[sectionIndex] || null;
}

// Collapse a normalized entry into the values the rail paints. Returns null
// when there is nothing to show: no entry at all, or a section whose phrases
// report no ladder and no chart content (silent, not "easy"). A `top_tier` of 0
// with content is the easy-but-playable case -- played in full at every slider
// position -- rendered as a single lit, outlined segment.
function _smTierModel(entry) {
    if (!entry) return null;
    const maxTier = Math.max(0, Math.floor(entry.max_tier) || 0);
    const topTier = Math.min(Math.max(0, Math.floor(entry.top_tier) || 0), maxTier);
    if (topTier === 0) {
        if (!entry.has_chart_content) return null;
        return { maxTier: 0, topTier: 0, currentTier: 0, full: true };
    }
    const currentTier = entry.current_tier == null
        ? null
        : Math.max(0, Math.min(topTier, Math.floor(entry.current_tier)));
    return { maxTier, topTier, currentTier, full: currentTier != null && currentTier >= topTier };
}

// Initialize the difficulty availability flags if the peer is present.
function _smInitializeDifficultyListener() {
    _smDynamicDifficultyAvailable = _smIsDynamicDifficultyAvailable();
}

// Shared tail of both event handlers: repaint the rails in place when the bar
// already matches the current sections, otherwise rebuild the bar.
function _smApplyTierData() {
    if (_smBar && _smSections.length > 0 && _smBlockEls.length === _smSections.length) {
        _smUpdateTierRails();
    } else {
        _smRender();
    }
}

// difficulty:sections-updated-v3 handler.
function _smOnSectionsUpdatedV3(event) {
    const normalized = _smNormalizeSectionTiers(event && event.detail);
    if (normalized === null) return;
    _smSectionTiers = normalized;
    _smApplyTierData();
}

// difficulty:sections-updated (v2) handler -- bounded-transition fallback only.
function _smOnSectionsUpdated(event) {
    const normalized = _smNormalizeSectionTiersV2(event && event.detail && event.detail.sectionDifficulties);
    if (normalized === null) return;
    _smSectionTiers = normalized;
    _smApplyTierData();
}

// Subscribe to the peer's section event if it is available yet.
//
// This re-runs rather than deciding once per mount on purpose. When both
// plugins come back 'ready' in one /api/plugins response, core injects screen.js
// files one at a time in sorted order (`name || id`, ties broken by id), so
// difficulty_ladder sorts ahead of section_map and the old one-shot check
// happened to work. That ordering is a property of that one response, not a
// guarantee: static/js/plugin-loader.js skips any plugin whose status isn't
// 'ready', and the backend "clears its plugin registry at the start of
// load_plugins() and repopulates it incrementally while HTTP stays up, so every
// backend restart serves a window of partial (even empty) responses". A peer
// that is mid-install then arrives on a later refetch (the loader refetches on
// `plugin-registered` startup events) — after our script body has already run,
// and our script does not run again either, so nothing else would ever retry.
// The peer emits no readiness event to subscribe to either; it just sets its
// marker at top-level script execution. So _smUpdate() calls this on every
// 200ms tick while the player is visible: one property read per tick,
// short-circuiting on a single boolean once registered.
//
// One-directional on purpose: a peer that vanishes mid-song leaves its last
// rails in place rather than tearing down mid-render, and the contract is that
// an absent peer means no rails, never an error.
function _smEnsureDifficultySubscription() {
    if (_smDifficultySubscribed) return;
    _smInitializeDifficultyListener();
    if (!_smDynamicDifficultyAvailable) return;
    const bus = window.feedBack;
    if (!bus || typeof bus.on !== 'function') return; // host bus not up yet -- retry next tick
    // From here a handler IS registered, so _smDifficultySubscribed means
    // "registered", not "removable": the bus isn't required to return an
    // unsubscribe handle, and re-registering every 200ms because it didn't
    // would leak a handler per tick.
    _smDifficultySubscribed = true;
    if (_smPeerSpeaksV3()) {
        _smDifficultyUnsubscribe = _smSubscribeFeedBackEvent(_SM_DD_SECTIONS_V3_EVENT, _smOnSectionsUpdatedV3);
    } else {
        _smDifficultyUnsubscribe = _smSubscribeFeedBackEvent(_SM_DD_SECTIONS_EVENT, _smOnSectionsUpdated);
    }
}

function _smStartRealtimeHooks() {
    if (!_smPoller) _smPoller = setInterval(_smUpdate, 200);

    if (!_smSongReadySubscribed) {
        _smSongReadyUnsubscribe = _smSubscribeFeedBackEvent('song:ready', () => {
            _smSections = [];
            _smDuration = 0;
            _smSectionTiers = {};
            _smUpdate();
        });
        _smSongReadySubscribed = typeof _smSongReadyUnsubscribe === 'function';
    }

    _smEnsureDifficultySubscription();
}

function _smStopRealtimeHooks() {
    if (_smPoller) {
        clearInterval(_smPoller);
        _smPoller = null;
    }

    if (typeof _smSongReadyUnsubscribe === 'function') {
        _smSongReadyUnsubscribe();
    }
    _smSongReadyUnsubscribe = null;
    _smSongReadySubscribed = false;

    if (typeof _smDifficultyUnsubscribe === 'function') {
        _smDifficultyUnsubscribe();
        _smDifficultyUnsubscribe = null;
        _smDifficultySubscribed = false;
    }
    // If there's no disposer, keep _smDifficultySubscribed true to prevent
    // accumulating handlers on hide/show cycles (bus returned no unsubscribe handle).
}

function _smSetPlayerVisible(isVisible) {
    _smPlayerVisible = !!isVisible;
    if (_smPlayerVisible) {
        _smStartRealtimeHooks();
        _smCreate();
        return;
    }

    _smStopRealtimeHooks();
    _smRemove();
}

function _smCreate() {
    if (_smBar) return;
    const player = document.getElementById('player');
    if (!player) return;

    _smBar = document.createElement('div');
    _smBar.id = 'section-map';
    _smBar.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:5;height:20px;background:rgba(8,8,16,0.7);cursor:pointer;';

    // Insert as first child of player (very top)
    player.insertBefore(_smBar, player.firstChild);

    _smBar.addEventListener('click', _smOnClick);
    _smBar.addEventListener('wheel', _smOnWheel, { passive: false });
}

function _smRemove() {
    if (_smBar) {
        _smBar.remove();
        _smBar = null;
    }
    _smMarkerEl = null;
    _smBlockEls = [];
    _smActiveIdx = -1;
    _smTierSignatures = [];
}

// The playback clock, across whichever backend is driving audio. getTime() is
// the audio-aligned clock the host exposes to plugins; the raw <audio> element
// is only a fallback (and is stale when a native/streaming backend is playing).
function _smNow() {
    if (typeof highway !== 'undefined' && highway && typeof highway.getTime === 'function') {
        const t = highway.getTime();
        if (Number.isFinite(t)) return t;
    }
    const audio = document.getElementById('audio');
    return audio && Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
}

// Reposition through the host's canonical seek funnel (window.feedBack.seek ->
// _audioSeek). It moves whichever backend is ACTUALLY playing — JUCE native
// output, or the bounded-memory stem-streaming worklet, which only reseeks in
// response to the song:seek event the funnel emits — and keeps the highway
// clock in sync. Poking audio.currentTime directly only relocates regions the
// <audio> element has already buffered near the playhead, so once playback
// moved off that element (native routing + stem streaming) far sections stopped
// seeking — they land in an unbuffered/unstreamed region and snap back. The raw
// path stays only as a fallback for a host old enough to lack the seek API.
function _smSeek(time, reason) {
    // Clamp centrally so every caller (click passes a raw pct*duration; a pct
    // just over 1 at the bar's right edge would otherwise seek past the end).
    const max = (typeof _smDuration === 'number' && _smDuration > 0) ? _smDuration : Infinity;
    const t = Math.max(0, Math.min(max, time));
    const host = (typeof window !== 'undefined') && (window.feedBack || window.slopsmith);
    if (host && typeof host.seek === 'function') {
        host.seek(t, reason);
        return;
    }
    const audio = document.getElementById('audio');
    if (!audio) return;
    // Legacy fallback: keep the jump detector from reverting the seek, and
    // pause/seek/resume because seeking during playback fails on unbuffered regions.
    if (typeof lastAudioTime !== 'undefined') lastAudioTime = t;
    const wasPlaying = !audio.paused;
    if (wasPlaying) audio.pause();
    audio.currentTime = t;
    if (wasPlaying) {
        audio.addEventListener('seeked', function resume() {
            audio.removeEventListener('seeked', resume);
            audio.play();
        }, { once: true });
    }
}

function _smOnClick(e) {
    if (!_smDuration) return;
    const rect = _smBar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    _smSeek(pct * _smDuration, 'sectionmap-click');
}

function _smOnWheel(e) {
    if (!_smDuration) return;
    e.preventDefault();
    // up (negative deltaY) = forward, down (positive deltaY) = backward
    const increment = e.ctrlKey ? 0.1 : 1; // Fine control with Ctrl modifier
    const deltaTime = -(e.deltaY > 0 ? 1 : -1) * increment;
    const newTime = Math.max(0, Math.min(_smDuration, _smNow() + deltaTime));
    _smSeek(newTime, 'sectionmap-wheel');
}

function _smUpdate() {
    // Retry the Difficulty Ladder handshake before anything else: the peer may
    // have loaded (or reloaded) after this plugin did, and the rail is the one
    // thing that can't wait for the next song. No-op once subscribed.
    _smEnsureDifficultySubscription();

    if (!_smBar) return;
    const sections = highway.getSections();
    const info = highway.getSongInfo();
    const t = highway.getTime();

    if (!sections || sections.length === 0 || !info.duration) {
        // The previous song's bar must not linger once the CURRENT song has
        // no section data. This early-return used to bail before touching
        // any state, so switching to a song/arrangement with no sections
        // (a GP import, or a core re-stream that bypasses the playSong
        // wrapper's own reset -- e.g. an in-player arrangement switch) left
        // the old blocks painted and the marker/active-highlight frozen at
        // wherever the last real song left them.
        //
        // Gate on the bar's actual painted content, NOT _smSections: the
        // song:ready handler above already sets _smSections = [] itself
        // before calling _smUpdate() directly, so by the time this runs
        // _smSections.length is already 0 on exactly the transition this
        // guard exists to catch -- gating on it made the clear a no-op on
        // that path, since a bar with stale rendered blocks would report
        // "nothing to clear". _smBar.innerHTML is only ever set by
        // _smRender() and only ever emptied by _smRemove() or this same
        // block, so it accurately tracks whether the bar still shows
        // painted content regardless of which path zeroed _smSections
        // first. Clearing is idempotent, so this still bails immediately
        // on every later tick once already cleared, rather than rebuilding
        // an already-empty bar every 200ms while no song/sections are loaded.
        if (_smBar.innerHTML !== '') {
            _smSections = [];
            _smDuration = 0;
            _smSectionTiers = {};
            _smBar.innerHTML = '';
            _smMarkerEl = null;
            _smBlockEls = [];
            _smActiveIdx = -1;
            _smTierSignatures = [];
        }
        return;
    }

    _smDuration = info.duration;

    // Only rebuild if sections changed
    if (sections !== _smSections) {
        _smSections = sections;
        _smRender();
    }

    // Update playback position indicator. _smMarkerEl is cached by _smRender()
    // so this is a style write, not a fresh getElementById lookup every 200ms.
    if (_smMarkerEl && _smDuration > 0) {
        const pct = (t / _smDuration) * 100;
        _smMarkerEl.style.left = pct + '%';
    }

    // Highlight active section. _smBlockEls is cached by _smRender() (rebuilt
    // only when the section list changes), and blocks start at opacity 0.5
    // (baked into the render template), so a tick only needs to touch the
    // two blocks whose highlight state actually flipped instead of doing a
    // querySelectorAll + full forEach opacity rewrite every 200ms regardless
    // of whether the active section changed since the last tick.
    let activeIdx = 0;
    for (let i = 0; i < _smSections.length; i++) {
        if (_smSections[i].time <= t) activeIdx = i;
        else break;
    }
    if (activeIdx !== _smActiveIdx) {
        if (_smActiveIdx >= 0 && _smBlockEls[_smActiveIdx]) {
            _smBlockEls[_smActiveIdx].style.opacity = '0.5';
        }
        if (_smBlockEls[activeIdx]) {
            _smBlockEls[activeIdx].style.opacity = '1';
        }
        _smActiveIdx = activeIdx;
    }
}

// The on-bar label drops a trailing digit (no room for "Verse 2" in a
// ~9px-tall strip), but the hover title keeps it — otherwise two "Verse"
// blocks are indistinguishable on mouseover.
function _smSectionLabel(sec) {
    const ordinalMatch = sec.name.match(/(\d+)$/);
    let label = sec.name.replace(/\d+$/, '').trim();
    label = label.charAt(0).toUpperCase() + label.slice(1);
    return { label, titleLabel: ordinalMatch ? `${label} ${ordinalMatch[1]}` : label };
}

// The readable tier detail shared by the hover title and the accessible name:
// `tier X of Y · full detail at Z`. `Y` is maxTier, `Z` is topTier; the
// full-detail clause is omitted when there is no ladder to climb (maxTier 0).
// currentTier null is "tier unknown", not a zero tier.
function _smTierSuffix(model) {
    if (!model) return '';
    if (model.currentTier == null) {
        return model.maxTier > 0 ? `tier unknown · full detail at ${model.topTier}` : 'tier unknown';
    }
    const tierText = `tier ${model.currentTier} of ${model.maxTier}`;
    return model.maxTier > 0 ? `${tierText} · full detail at ${model.topTier}` : tierText;
}

// A rail cell that fits: one fixed-size segment per tier (maxTier + 1), the
// first currentTier + 1 lit, and the segment at topTier outlined.
function _smRailSegmentsMarkup(model) {
    let html = '';
    for (let tier = 0; tier <= model.maxTier; tier++) {
        const lit = model.currentTier != null && tier <= model.currentTier;
        const top = tier === model.topTier;
        html += `<span class="sm-rail-seg" style="width:${SM_RAIL_SEGMENT_PX}px;height:5px;border-radius:1px;background:${lit ? SM_TIER_LIT : SM_TIER_UNLIT};${top ? `outline:1px solid ${SM_TIER_TOP};outline-offset:1px;` : ''}"></span>`;
    }
    return html;
}

// Degraded form for a block too narrow for segments: a single marker that is
// lit once a tier is known and outlined when the entry is already played in
// full. The readable detail still travels on the block's label.
function _smRailCollapsedMarkup(model) {
    const lit = model.currentTier != null;
    return `<span class="sm-rail-seg sm-rail-marker" style="width:${SM_RAIL_SEGMENT_PX}px;height:5px;border-radius:1px;background:${lit ? SM_TIER_LIT : SM_TIER_UNLIT};${model.full ? `outline:1px solid ${SM_TIER_TOP};outline-offset:1px;` : ''}"></span>`;
}

// Whether the segment rail would not fit in `blockPx`. A non-positive width
// means "could not measure" (the bar isn't laid out yet), where the segments are
// kept: the rail is overflow-hidden, so it degrades gracefully instead of us
// guessing wrong.
function _smShouldCollapse(blockPx, model) {
    if (!(blockPx > 0)) return false;
    const segCount = model.maxTier + 1;
    const needed = segCount * SM_RAIL_SEGMENT_PX + (segCount - 1) * SM_RAIL_GAP_PX;
    return blockPx < needed + SM_RAIL_PAD_PX;
}

function _smRailInner(model, blockPx) {
    return _smShouldCollapse(blockPx, model)
        ? _smRailCollapsedMarkup(model)
        : _smRailSegmentsMarkup(model);
}

// The rail container: anchored to the bottom edge of the section block so it
// never competes with the centered label. aria-hidden because the block's own
// aria-label carries the readable detail; the segments are its visual encoding.
function _smRenderTierRail(model, blockPx) {
    const style = `position:absolute;left:2px;right:2px;bottom:1px;display:flex;gap:${SM_RAIL_GAP_PX}px;justify-content:center;align-items:flex-end;pointer-events:none;overflow:hidden;`;
    return `<div class="sm-rail" aria-hidden="true" style="${style}">${_smRailInner(model, blockPx)}</div>`;
}

function _smTierSignature(model) {
    return model ? `${model.maxTier}|${model.topTier}|${model.currentTier}|${model.full ? 1 : 0}` : '';
}

function _smRender() {
    if (!_smBar || !_smSections.length || !_smDuration) return;

    let html = '';
    const barWidth = _smBar.getBoundingClientRect ? _smBar.getBoundingClientRect().width : 0;

    for (let i = 0; i < _smSections.length; i++) {
        const sec = _smSections[i];
        const nextTime = i < _smSections.length - 1 ? _smSections[i + 1].time : _smDuration;
        const startPct = (sec.time / _smDuration) * 100;
        const widthPct = ((nextTime - sec.time) / _smDuration) * 100;
        const color = _smGetColor(sec.name);

        const { label, titleLabel } = _smSectionLabel(sec);
        const safeLabel = _smEscapeHtml(label);
        const safeTitle = _smEscapeHtml(`${titleLabel} (${_smFmt(sec.time)})`);

        // Semantic tier data, when the peer is present. blockPx is an estimate
        // from the bar's laid-out width; it only decides whether the rail draws
        // segments or collapses to a marker.
        const model = _smTierModel(_smGetSectionTier(i));
        const blockPx = barWidth > 0 ? (widthPct / 100) * barWidth : 0;
        const railContent = model ? _smRenderTierRail(model, blockPx) : '';
        const tierSuffix = _smTierSuffix(model);
        const fullTitle = tierSuffix
            ? `${safeTitle} · ${_smEscapeHtml(tierSuffix)}`
            : safeTitle;
        // One focus stop per section with tier data, carrying the readable
        // detail so keyboard/AT users are not limited to the hover title.
        const ariaAttr = model
            ? ` tabindex="0" aria-label="${_smEscapeHtml(`${titleLabel} · ${tierSuffix}`)}"`
            : '';

        // opacity starts at 0.5 (the "inactive" state) so _smUpdate's per-tick
        // highlight pass only ever needs to touch the blocks whose active
        // state actually changed, instead of rewriting every block's opacity
        // on every poll.
        html += `<div class="sm-block" style="position:absolute;left:${startPct}%;width:${widthPct}%;top:0;bottom:0;background:${color};border-right:1px solid rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;overflow:hidden;transition:opacity 0.15s;opacity:0.5;"
            title="${fullTitle}"${ariaAttr}>
            ${railContent}
            <span style="font-size:9px;color:rgba(255,255,255,0.8);white-space:nowrap;text-overflow:ellipsis;overflow:hidden;padding:0 3px;">${safeLabel}</span>
        </div>`;
    }

    // Playback position marker
    html += '<div id="sm-marker" style="position:absolute;top:0;bottom:0;width:2px;background:white;z-index:1;pointer-events:none;transition:left 0.1s linear;"></div>';

    _smBar.innerHTML = html;
    _smBar.style.position = 'relative';

    // Re-cache the DOM refs _smUpdate()'s per-tick highlight/marker pass
    // reads, since the innerHTML rebuild just invalidated the old ones.
    _smMarkerEl = _smBar.querySelector ? _smBar.querySelector('#sm-marker') : null;
    _smBlockEls = _smBar.querySelectorAll ? Array.from(_smBar.querySelectorAll('.sm-block')) : [];
    _smActiveIdx = -1;
    _smTierSignatures = _smSections.map((_, i) => _smTierSignature(_smTierModel(_smGetSectionTier(i))));
}

// Refresh only the per-section tier rails in place (segments + readable label)
// instead of rebuilding the whole section-map bar. Called from the peer's
// section-difficulty events, which can fire repeatedly while a song plays as
// difficulty_ladder re-derives each section's tiers — none of that data changes
// section colors/labels/positions, so a full _smRender() on every event would
// tear down and rebuild every block's DOM just to repaint a few small rails.
// A per-section signature skips the rails whose tier data did not change.
function _smUpdateTierRails() {
    if (!_smBar || !_smBlockEls.length) return;
    const barWidth = _smBar.getBoundingClientRect ? _smBar.getBoundingClientRect().width : 0;
    for (let i = 0; i < _smSections.length; i++) {
        const model = _smTierModel(_smGetSectionTier(i));
        const signature = _smTierSignature(model);
        if (_smTierSignatures[i] === signature) continue;
        _smTierSignatures[i] = signature;

        const block = _smBlockEls[i];
        if (!block || typeof block.querySelector !== 'function') continue;

        const sec = _smSections[i];
        const nextTime = i < _smSections.length - 1 ? _smSections[i + 1].time : _smDuration;
        const widthPct = _smDuration > 0 ? ((nextTime - sec.time) / _smDuration) * 100 : 0;
        const blockPx = barWidth > 0 ? (widthPct / 100) * barWidth : 0;

        const rail = block.querySelector('.sm-rail');
        if (model) {
            if (rail) rail.innerHTML = _smRailInner(model, blockPx);
            else block.insertAdjacentHTML('afterbegin', _smRenderTierRail(model, blockPx));
        } else if (rail) {
            rail.remove();
        }

        const { titleLabel } = _smSectionLabel(sec);
        const tierSuffix = _smTierSuffix(model);
        const baseTitle = `${titleLabel} (${_smFmt(sec.time)})`;
        block.title = tierSuffix ? `${baseTitle} · ${tierSuffix}` : baseTitle;
        // Mirror _smRender's attributes exactly, in both directions: a block
        // that gains tier data becomes a focus stop, and one that loses it
        // stops being one (otherwise tabindex lingers on a bare, unnamed div).
        if (typeof block.setAttribute === 'function' && typeof block.removeAttribute === 'function') {
            if (model) {
                block.setAttribute('aria-label', `${titleLabel} · ${tierSuffix}`);
                block.setAttribute('tabindex', '0');
            } else {
                block.removeAttribute('aria-label');
                block.removeAttribute('tabindex');
            }
        }
    }
}

// A window/bar resize changes how many pixels each block has, which is what
// decides between the segment rail and the collapsed marker. The signature
// deliberately excludes width (tier data is what it tracks), so a resize has to
// invalidate the signatures and repaint for that width-dependent form to be
// re-decided. Without this, a block that crossed the collapse threshold on
// resize would keep the other form until its tier data or the section list next
// changed. Cheap: one repaint per resize, none per _smUpdate tick.
function _smHandleResize() {
    if (!_smBar) return;
    _smTierSignatures = [];
    _smUpdateTierRails();
}

function _smFmt(s) {
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}
function _smEscapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Node-only export hook for tests; browsers fall through to the side-effect
// IIFE below (poller + playSong wrapping + screen:changed listener).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        _smGetColor, _smFmt, _smCreate, _smRemove, _smUpdate, _smRender,
        _smOnClick, _smOnWheel, _smEscapeHtml,
        _smIsDynamicDifficultyAvailable, _smPeerSpeaksV3, _smGetSectionTier,
        _smTierModel, _smTierSuffix, _smRenderTierRail, _smUpdateTierRails, _smHandleResize,
        _smNormalizeSectionTiers, _smNormalizeSectionTiersV2,
        _smOnSectionsUpdated, _smOnSectionsUpdatedV3, _smEnsureDifficultySubscription,
        _smInitializeDifficultyListener, _smStartRealtimeHooks, _smStopRealtimeHooks, _smSetPlayerVisible,
        _getState: () => ({
            bar: _smBar, sections: _smSections, duration: _smDuration, sectionTiers: _smSectionTiers,
            ddAvailable: _smDynamicDifficultyAvailable, markerEl: _smMarkerEl, blockEls: _smBlockEls, activeIdx: _smActiveIdx,
            tierSignatures: _smTierSignatures,
            songReadySubscribed: _smSongReadySubscribed, difficultySubscribed: _smDifficultySubscribed,
        }),
        _setState(next) {
            if ('sections' in next) _smSections = next.sections;
            if ('duration' in next) _smDuration = next.duration;
            if ('bar' in next) _smBar = next.bar;
            if ('sectionTiers' in next) _smSectionTiers = next.sectionTiers;
            if ('ddAvailable' in next) _smDynamicDifficultyAvailable = next.ddAvailable;
            if ('poller' in next) _smPoller = next.poller;
            if ('playerVisible' in next) _smPlayerVisible = next.playerVisible;
            if ('songReadyUnsubscribe' in next) _smSongReadyUnsubscribe = next.songReadyUnsubscribe;
            if ('difficultyUnsubscribe' in next) _smDifficultyUnsubscribe = next.difficultyUnsubscribe;
            if ('songReadySubscribed' in next) _smSongReadySubscribed = next.songReadySubscribed;
            if ('difficultySubscribed' in next) _smDifficultySubscribed = next.difficultySubscribed;
            if ('markerEl' in next) _smMarkerEl = next.markerEl;
            if ('blockEls' in next) _smBlockEls = next.blockEls;
            if ('activeIdx' in next) _smActiveIdx = next.activeIdx;
            if ('tierSignatures' in next) _smTierSignatures = next.tierSignatures;
        },
    };
} else {

// Side effects: poller + playSong wrapper + screen:changed listener.
// Consolidated under one idempotency guard so re-evaluation (loader cache
// miss, hot reload, older core builds without the load-side guard) doesn't
// start a second 5Hz poller and doesn't grow the wrapper chain or add a
// second event listener.
(function() {
    const HOOK_KEY = '__slopsmithSectionMapHooksInstalled';
    if (window[HOOK_KEY]) return;
    window[HOOK_KEY] = true;

    // Hook into playSong
    const origPlaySong = window.playSong;
    window.playSong = async function(filename, arrangement) {
        _smRemove();
        _smSections = [];
        _smDuration = 0;
        _smSectionTiers = {};
        await origPlaySong(filename, arrangement);
        if (_smPlayerVisible) _smCreate();
    };

    // Mount/unmount as the player screen activates/deactivates. Core's internal
    // navigation (playSong, closeCurrentSong, …) calls its own imported
    // showScreen() directly rather than window.showScreen — monkey-patching
    // window.showScreen here would silently never fire (feedBack#923/#924: the
    // same fragility across three different callers is why core moved to
    // firing screen:changed/screen:changing on window.feedBack instead of
    // letting plugins patch the global). Listen for the event core actually
    // emits rather than a global it no longer calls through.
    _smSubscribeFeedBackEvent('screen:changed', (event) => {
        _smSetPlayerVisible((event.detail && event.detail.id) === 'player');
    });

    // Re-decide the width-dependent rail form on resize. Installed inside the
    // same idempotency guard as every other top-level listener/timer.
    window.addEventListener('resize', () => {
        if (_smPlayerVisible) _smHandleResize();
    });
})();

}
