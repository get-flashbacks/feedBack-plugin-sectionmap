// Section Map plugin
// Shows a minimap bar of the full song structure with clickable sections.
// Includes optional glass-filling difficulty visualization when the
// Difficulty Ladder plugin (difficulty_ladder) is installed.

let _smBar = null;
let _smSections = [];
let _smDuration = 0;
let _smSectionDifficulty = {}; // Map of section index to difficulty data
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

function _smSubscribeFeedBackEvent(eventName, handler) {
    if (typeof window.feedBack === 'undefined' || typeof window.feedBack.on !== 'function') return null;
    const unsubscribe = window.feedBack.on(eventName, handler);
    if (typeof unsubscribe === 'function') return unsubscribe;
    if (typeof window.feedBack.off === 'function') return () => window.feedBack.off(eventName, handler);
    return null;
}

// The Difficulty Ladder peer contract. Section Map is standalone: everything
// except the per-section "glass fill" indicator works with no peer plugin at
// all. Only the glasses depend on `difficulty_ladder` (formerly
// "dynamic-difficulty"), which owns the difficulty:sections-updated event this
// plugin renders. The full contract lives in that plugin's INTEGRATION.md; the
// parts this file depends on are:
//
//   capability  window._ddCapabilities.sectionDifficulty === true, set at that
//               plugin's top-level script execution. (`_ddCapabilities` predates
//               its rename from `dynamic_difficulty` to `difficulty_ladder` and
//               is kept as-is: it is the established marker between the two
//               plugins.)
//   event       'difficulty:sections-updated' (schema difficulty_ladder.sections.v2)
//   payload     event.detail.sectionDifficulties -- an object map keyed by section
//               index, each entry { fillPercentage, glassSize, avgDifficulty,
//               maxDifficulty }. A section with no overlapping phrase is simply
//               absent from the map, which renders as "no glass".
//   floor       Difficulty Ladder v0.12.0, the release whose CHANGELOG documents
//               the v2 payload shape above. The event itself shipped in v0.2.0,
//               but "Difficulty Ladder is installed" is not a compatibility
//               statement on its own. Note what the floor is and isn't: the
//               marker below has existed since well before v0.2.0 and carries no
//               version, so a below-floor peer still passes it and still paints
//               glasses. What changed below the floor is the arithmetic behind
//               fillPercentage (v0.9.11 aligned it with the peer's own HUD), so
//               an old peer renders a glass that can disagree with Difficulty
//               Ladder's HUD — not one this plugin can detect. Hence a
//               documented floor rather than an enforced version check.
//
// v3 (`difficulty:sections-updated-v3`, a render-neutral payload) is emitted
// alongside v2 on a separate event name and is deliberately NOT consumed yet:
// _smRenderGlassFilling/_smUpdateDifficultyFills render glass metaphors, which is
// exactly what v3 stops prescribing. That is also why the peer's
// `sectionsSchema` advertisement is not a gate below — it exists for a consumer
// choosing between v2 and v3, and the peer keeps emitting v2 unchanged
// alongside v3 either way.
const _SM_DD_SECTIONS_EVENT = 'difficulty:sections-updated';

// Check whether the Difficulty Ladder peer is installed AND speaking the
// contract above. A bare `_ddCapabilities` global is not enough -- require the
// named marker, so a foreign plugin that happens to use that global (or a stub
// left behind by an earlier session) leaves the glasses off rather than
// subscribing to an event whose payload shape we cannot render.
function _smIsDynamicDifficultyAvailable() {
    if (typeof window.feedBack === 'undefined') return false;
    const caps = window._ddCapabilities;
    return !!caps && typeof caps === 'object' && caps.sectionDifficulty === true;
}

// Validate one `difficulty_ladder.sections.v2` payload's section map.
//
//   null  the container is not an object -- an unusable payload. Callers must
//         keep whatever they already have rather than repaint from noise.
//   {}    a well-formed container with nothing renderable in it, which clears
//         the glasses (the "no glass, not a stale one" convention).
//
// Entries are dropped unless they carry a finite numeric `fillPercentage`. The
// peer computes it arithmetically, so it is NaN whenever mastery or the phrase
// difficulty isn't a number — and a NaN sails through the `typeof === 'number'`
// check the renderer used to do, painting `height:NaN%` and a "Difficulty: NaN%"
// title. The same check drops anything from a payload that isn't the v2 shape at
// all, so an entry we can't read renders no glass instead of a misleading
// near-empty one.
function _smNormalizeSectionDifficulties(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const normalized = {};
    for (const key of Object.keys(raw)) {
        const entry = raw[key];
        if (!entry || typeof entry !== 'object') continue;
        if (!Number.isFinite(entry.fillPercentage)) continue;
        normalized[key] = entry;
    }
    return normalized;
}

// Get difficulty data for a section from the Difficulty Ladder peer
function _smGetSectionDifficulty(sectionIndex) {
    if (!_smDynamicDifficultyAvailable) return null;
    // Populated by difficulty_ladder's difficulty:sections-updated event.
    return _smSectionDifficulty[sectionIndex] || null;
}

// Initialize difficulty data listener if the Difficulty Ladder peer is available
function _smInitializeDifficultyListener() {
    _smDynamicDifficultyAvailable = _smIsDynamicDifficultyAvailable();
}

// difficulty:sections-updated handler.
function _smOnSectionsUpdated(event) {
    const normalized = _smNormalizeSectionDifficulties(event && event.detail && event.detail.sectionDifficulties);
    if (normalized === null) return;
    _smSectionDifficulty = normalized;
    // Difficulty refreshes change only the per-section glass fill, not
    // colors/labels/positions — update those in place rather than paying for a
    // full _smRender() (which tears down and rebuilds every block's DOM) on
    // every event, which can fire repeatedly over the course of a song. Falls
    // back to a full render if the cached blocks don't match the current
    // section list (bar not built for these sections yet).
    if (_smBar && _smSections.length > 0 && _smBlockEls.length === _smSections.length) {
        _smUpdateDifficultyFills();
    } else {
        _smRender();
    }
}

// Subscribe to the peer's section-difficulty event if it is available yet.
//
// This re-runs rather than deciding once per mount on purpose. The peer sets
// its marker at top-level script execution and emits no readiness event, and
// the Host does not order plugin loads — core's session.js is explicit that
// "plugins load ASYNCHRONOUSLY, so [a wrapper chain] links up in whatever order
// the race settles". _smUpdate() calls this on every 200ms tick while the player
// is visible: one property read per tick, short-circuiting on a single boolean
// once registered.
//
// One-directional on purpose: a peer that vanishes mid-song leaves its last
// glasses in place rather than tearing down mid-render, and the contract is
// that an absent peer means no glasses, never an error.
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
    _smDifficultyUnsubscribe = _smSubscribeFeedBackEvent(_SM_DD_SECTIONS_EVENT, _smOnSectionsUpdated);
}

function _smStartRealtimeHooks() {
    if (!_smPoller) _smPoller = setInterval(_smUpdate, 200);

    if (!_smSongReadySubscribed) {
        _smSongReadyUnsubscribe = _smSubscribeFeedBackEvent('song:ready', () => {
            _smSections = [];
            _smDuration = 0;
            _smSectionDifficulty = {};
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
    }
    _smDifficultyUnsubscribe = null;
    _smDifficultySubscribed = false;
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
    // have loaded (or reloaded) after this plugin did, and glasses are the one
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
            _smSectionDifficulty = {};
            _smBar.innerHTML = '';
            _smMarkerEl = null;
            _smBlockEls = [];
            _smActiveIdx = -1;
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

function _smRender() {
    if (!_smBar || !_smSections.length || !_smDuration) return;

    let html = '';

    for (let i = 0; i < _smSections.length; i++) {
        const sec = _smSections[i];
        const nextTime = i < _smSections.length - 1 ? _smSections[i + 1].time : _smDuration;
        const startPct = (sec.time / _smDuration) * 100;
        const widthPct = ((nextTime - sec.time) / _smDuration) * 100;
        const color = _smGetColor(sec.name);

        // Clean up section name for display
        const ordinalMatch = sec.name.match(/(\d+)$/);
        let label = sec.name.replace(/\d+$/, '').trim();
        label = label.charAt(0).toUpperCase() + label.slice(1);
        // The on-bar label drops the trailing digit (no room for "Verse 2" in
        // a ~9px-tall strip), but the hover title keeps it — otherwise two
        // "Verse" blocks are indistinguishable on mouseover.
        const titleLabel = ordinalMatch ? `${label} ${ordinalMatch[1]}` : label;

        // Get difficulty data if available
        const difficulty = _smGetSectionDifficulty(i);
        const difficultyContent = _smDynamicDifficultyAvailable && difficulty
            ? _smRenderGlassFilling(difficulty)
            : '';

        const safeLabel = _smEscapeHtml(label);
        const safeTitle = _smEscapeHtml(`${titleLabel} (${_smFmt(sec.time)})`);
        // opacity starts at 0.5 (the "inactive" state) so _smUpdate's per-tick
        // highlight pass only ever needs to touch the blocks whose active
        // state actually changed, instead of rewriting every block's opacity
        // on every poll.
        html += `<div class="sm-block" style="position:absolute;left:${startPct}%;width:${widthPct}%;top:0;bottom:0;background:${color};border-right:1px solid rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;overflow:hidden;transition:opacity 0.15s;opacity:0.5;"
            title="${safeTitle}">
            ${difficultyContent}
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
}

// Size buckets for the glass, keyed by the difficulty_ladder.sections.v2
// `glassSize` value. Module-level because two call sites need it: the renderer
// below and _smUpdateDifficultyFills()'s size-change comparison.
const SM_GLASS_SIZES = {
    small: 'width:12px;height:12px;',
    medium: 'width:16px;height:16px;',
    large: 'width:20px;height:20px;',
};

// The one place a peer's `glassSize` enters our markup: it lands unescaped in
// the `data-size` attribute, so resolve it against the allowlist first rather
// than trusting the string. Anything unrecognized (including markup) becomes
// `medium`, matching the style fallback.
function _smGlassSize(difficulty) {
    const size = difficulty && difficulty.glassSize;
    return Object.prototype.hasOwnProperty.call(SM_GLASS_SIZES, size) ? size : 'medium';
}

// Render glass-filling visualization for section difficulty
function _smRenderGlassFilling(difficulty) {
    // isFinite, not typeof: the peer derives this arithmetically and a NaN
    // mastery or phrase difficulty yields NaN, which is typeof 'number' and
    // would otherwise reach the style attribute as `height:NaN%`.
    if (!difficulty || !Number.isFinite(difficulty.fillPercentage)) return '';

    const fillPct = Math.max(0, Math.min(100, difficulty.fillPercentage));
    const glassSize = _smGlassSize(difficulty);
    const glassStyle = SM_GLASS_SIZES[glassSize];

    // Classed (and size-tagged) so _smUpdateDifficultyFills() can update an
    // existing glass's fill height/title in place on a difficulty refresh,
    // instead of the caller having to rebuild the whole section-map bar just
    // to redraw it.
    return `<div class="sm-glass" data-size="${glassSize}" style="position:relative;${glassStyle}margin-right:4px;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);border-radius:2px;display:flex;align-items:flex-end;overflow:hidden;"
        title="Difficulty: ${fillPct.toFixed(0)}%">
        <div class="sm-glass-fill" style="width:100%;height:${fillPct}%;background:rgba(255,200,100,0.7);transition:height 0.3s ease;"></div>
    </div>`;
}

// Refresh only the per-section difficulty "glass fill" indicators in place
// (fill height + title) instead of rebuilding the whole section-map bar.
// Called from the 'difficulty:sections-updated' event, which can fire
// repeatedly while a song plays as difficulty_ladder re-derives each section's
// difficulty — none of that data changes section colors/labels/positions, so a
// full _smRender() on every event would tear down and rebuild every block's DOM
// just to repaint a handful of small fill bars.
function _smUpdateDifficultyFills() {
    if (!_smBar || !_smBlockEls.length) return;
    for (let i = 0; i < _smBlockEls.length; i++) {
        const block = _smBlockEls[i];
        if (!block || typeof block.querySelector !== 'function') continue;
        const difficulty = _smGetSectionDifficulty(i);
        const glass = block.querySelector('.sm-glass');
        if (_smDynamicDifficultyAvailable && difficulty && Number.isFinite(difficulty.fillPercentage)) {
            const fillPct = Math.max(0, Math.min(100, difficulty.fillPercentage));
            const glassSize = _smGlassSize(difficulty);
            const sizeChanged = glass && glass.getAttribute && glass.getAttribute('data-size') !== glassSize;
            if (glass && !sizeChanged) {
                // Same glass already present (the common case while a song
                // plays) — just update its fill height and title.
                glass.title = `Difficulty: ${fillPct.toFixed(0)}%`;
                const fillEl = glass.querySelector('.sm-glass-fill');
                if (fillEl) fillEl.style.height = fillPct + '%';
            } else {
                // No glass yet, or its size bucket changed — (re)build just
                // this one glass element rather than the whole bar.
                if (glass) glass.remove();
                block.insertAdjacentHTML('afterbegin', _smRenderGlassFilling(difficulty));
            }
        } else if (glass) {
            glass.remove();
        }
    }
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
        _smIsDynamicDifficultyAvailable, _smGetSectionDifficulty, _smRenderGlassFilling,
        _smUpdateDifficultyFills,
        _smNormalizeSectionDifficulties, _smOnSectionsUpdated, _smEnsureDifficultySubscription,
        _smInitializeDifficultyListener, _smStartRealtimeHooks, _smStopRealtimeHooks, _smSetPlayerVisible,
        _getState: () => ({
            bar: _smBar, sections: _smSections, duration: _smDuration, sectionDifficulty: _smSectionDifficulty,
            ddAvailable: _smDynamicDifficultyAvailable, markerEl: _smMarkerEl, blockEls: _smBlockEls, activeIdx: _smActiveIdx,
            songReadySubscribed: _smSongReadySubscribed, difficultySubscribed: _smDifficultySubscribed,
        }),
        _setState(next) {
            if ('sections' in next) _smSections = next.sections;
            if ('duration' in next) _smDuration = next.duration;
            if ('bar' in next) _smBar = next.bar;
            if ('sectionDifficulty' in next) _smSectionDifficulty = next.sectionDifficulty;
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
        _smSectionDifficulty = {};
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
})();

}
