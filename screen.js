// Section Map plugin
// Shows a minimap bar of the full song structure with clickable sections.

let _smBar = null;
let _smSections = [];
let _smDuration = 0;

const SM_COLORS = {
    'intro': '#3b82f6',
    'verse': '#22c55e',
    'chorus': '#eab308',
    'bridge': '#a855f7',
    'solo': '#ef4444',
    'outro': '#6b7280',
    'breakdown': '#f97316',
    'riff': '#06b6d4',
    'pre': '#84cc16',
    'noguitar': '#374151',
    'default': '#4b5563',
};

function _smGetColor(name) {
    const low = name.toLowerCase();
    for (const [key, color] of Object.entries(SM_COLORS)) {
        if (low.includes(key)) return color;
    }
    return SM_COLORS.default;
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

// Reads the Host's phrase-difficulty surface defensively — feature-detected
// exactly like dynamic_difficulty's own HUD, so a Host/version without it
// (or simply no phrase data for the current song) degrades to "no glasses,"
// never an error (sectionmap#1 / this repo's contract with #8's "handle
// missing/delayed section-difficulty data gracefully").
function _smReadPhraseState() {
    if (typeof highway === 'undefined' || !highway) return { phrases: null, mastery: 0 };
    const has = typeof highway.hasPhraseData === 'function' && highway.hasPhraseData();
    const phrases = has && typeof highway.getPhrases === 'function' ? highway.getPhrases() : null;
    const mastery = typeof highway.getMastery === 'function' ? highway.getMastery() : 0;
    return { phrases, mastery };
}

function _smUpdate() {
    if (!_smBar) return;
    const sections = highway.getSections();
    const info = highway.getSongInfo();
    const t = highway.getTime();

    if (!sections || sections.length === 0 || !info.duration) return;

    _smDuration = info.duration;

    // Only rebuild if sections changed
    if (sections !== _smSections) {
        _smSections = sections;
        _smRender();
    }

    // Update playback position indicator
    const marker = document.getElementById('sm-marker');
    if (marker && _smDuration > 0) {
        const pct = (t / _smDuration) * 100;
        marker.style.left = pct + '%';
    }

    // Highlight active section
    const blocks = _smBar.querySelectorAll('.sm-block');
    let activeIdx = 0;
    for (let i = 0; i < _smSections.length; i++) {
        if (_smSections[i].time <= t) activeIdx = i;
        else break;
    }
    blocks.forEach((block, i) => {
        block.style.opacity = i === activeIdx ? '1' : '0.5';
    });

    // Refresh glass fill levels every tick — mastery (and thus fillFrac) can
    // change mid-song (manual slider move, or dynamic_difficulty's own
    // auto-adjust) without the section list itself changing, so this can't
    // be folded into the "sections changed -> _smRender()" rebuild above.
    const { phrases, mastery } = _smReadPhraseState();
    const glasses = _smComputeGlass(_smSections, _smDuration, phrases, mastery);
    const glassEls = _smBar.querySelectorAll('.sm-glass-slot');
    glassEls.forEach((slot, i) => {
        slot.innerHTML = _smGlassHtml(glasses[i]);
    });
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
        let label = sec.name.replace(/\d+$/, '').trim();
        label = label.charAt(0).toUpperCase() + label.slice(1);

        html += `<div class="sm-block" style="position:absolute;left:${startPct}%;width:${widthPct}%;top:0;bottom:0;background:${color};border-right:1px solid rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;overflow:hidden;transition:opacity 0.15s;"
            title="${label} (${_smFmt(sec.time)})">
            <span style="font-size:9px;color:rgba(255,255,255,0.8);white-space:nowrap;text-overflow:ellipsis;overflow:hidden;padding:0 3px;">${label}</span>
            <div class="sm-glass-slot" style="position:absolute;inset:0;pointer-events:none;"></div>
        </div>`;
    }

    // Playback position marker
    html += '<div id="sm-marker" style="position:absolute;top:0;bottom:0;width:2px;background:white;z-index:1;pointer-events:none;transition:left 0.1s linear;"></div>';

    _smBar.innerHTML = html;
    _smBar.style.position = 'relative';
}

function _smFmt(s) {
    return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

// ── Glass-filling difficulty visualization (sectionmap#1) ──────────────────
//
// Section-level difficulty is NOT this plugin's own data — it's read straight
// off the Host's own window.highway object (getPhrases()/hasPhraseData()/
// getMastery()), the exact same surface feedback-plugin-dynamic-difficulty's
// own glass HUD (screen.js's drawHud()) consumes. There is no bespoke API or
// event between the two plugins: both are independent readers of Host state,
// so this works whether or not dynamic_difficulty is even installed (it just
// needs SOME producer of phrase data — dynamic_difficulty's /generate route,
// or a hand-authored ladder, either populates the same window.highway state).
// See feedback-plugin-dynamic-difficulty's COMPLIANCE.md for the full writeup
// (issue #9 / #8 of that repo).
//
// Glass metaphor: glass SIZE reflects a section's own peak authored
// difficulty relative to the song's hardest section (a harder section gets a
// taller glass); glass FILL reflects how much of that section's difficulty
// range the current master-difficulty setting reaches — mirroring
// dynamic_difficulty's own per-phrase HUD math exactly, just aggregated to
// section (not phrase) boundaries, since this plugin's minimap is
// section-shaped, not phrase-shaped.

// Returns { max_difficulty } for the phrase(s) overlapping [t0, t1), or null
// if no phrase overlaps that range at all (a song can have phrase data for
// only part of its runtime, or none). Pure function — no DOM, no Host globals
// — so it's directly unit-testable.
function _smSectionDifficulty(t0, t1, phrases) {
    if (!phrases || !phrases.length) return null;
    let maxDiff = null;
    for (let i = 0; i < phrases.length; i++) {
        const p = phrases[i];
        if (p.end_time <= t0 || p.start_time >= t1) continue; // no overlap
        if (maxDiff === null || p.max_difficulty > maxDiff) maxDiff = p.max_difficulty;
    }
    return maxDiff === null ? null : { max_difficulty: maxDiff };
}

// Computes { sizeFrac, fillFrac } for every section, given the full phrase
// list and the current 0..1 mastery value. A section with no overlapping
// phrase data yields `null` at its index — callers must degrade that entry
// to "no glass" rather than drawing a zero-size one (missing data reads as
// absent, not as "difficulty zero").
function _smComputeGlass(sections, duration, phrases, mastery) {
    if (!sections || !sections.length || !duration) return [];
    if (!phrases || !phrases.length) return sections.map(() => null);

    let songMaxDiff = 0;
    for (let i = 0; i < phrases.length; i++) {
        if (phrases[i].max_difficulty > songMaxDiff) songMaxDiff = phrases[i].max_difficulty;
    }

    const m = (typeof mastery === 'number' && isFinite(mastery)) ? Math.max(0, Math.min(1, mastery)) : 0;

    return sections.map((sec, i) => {
        const t0 = sec.time;
        const t1 = (i + 1 < sections.length) ? sections[i + 1].time : duration;
        const diff = _smSectionDifficulty(t0, t1, phrases);
        if (diff === null) return null;

        const maxD = diff.max_difficulty;
        const sizeFrac = songMaxDiff > 0 ? Math.max(0.3, maxD / songMaxDiff) : 0.3;
        let fillFrac = 1;
        if (maxD > 0) {
            const idxLevel = Math.min(maxD, Math.floor(m * (maxD + 1)));
            fillFrac = idxLevel / maxD;
        }
        return { sizeFrac, fillFrac };
    });
}

// Builds the glass's inner markup (outline + fill), sized within a
// GLASS_W x GLASS_MAX_H box. Kept as its own small template so both the
// player and (should a maker screen ever mount this same bar — see
// COMPLIANCE.md's note that no such screen exists in feedBack today) render
// byte-identical glasses from the same function, per sectionmap#1's
// "consistent across maker and player" requirement.
const GLASS_W = 10, GLASS_MAX_H = 14, GLASS_MIN_H = 5;

function _smGlassHtml(glass) {
    if (!glass) return '';
    const h = GLASS_MIN_H + (GLASS_MAX_H - GLASS_MIN_H) * glass.sizeFrac;
    const fillH = Math.max(0, h * glass.fillFrac);
    const fillColor = glass.fillFrac > 0.8 ? 'rgba(224,80,80,0.85)'
        : glass.fillFrac > 0.4 ? 'rgba(232,192,64,0.85)'
            : 'rgba(64,160,224,0.85)';
    return '<div class="sm-glass" style="position:absolute;bottom:2px;right:2px;' +
        'width:' + GLASS_W + 'px;height:' + GLASS_MAX_H + 'px;pointer-events:none;">' +
        '<div style="position:absolute;left:0;right:0;bottom:0;height:' + h + 'px;' +
        'border:1px solid rgba(255,255,255,0.6);border-radius:2px;box-sizing:border-box;">' +
        '<div style="position:absolute;left:1px;right:1px;bottom:1px;height:' + fillH + 'px;' +
        'background:' + fillColor + ';"></div>' +
        '</div></div>';
}

// Node-only export hook for tests; browsers fall through to the side-effect
// IIFE below (poller + playSong/showScreen wrapping).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        _smGetColor, _smFmt, _smCreate, _smRemove, _smUpdate, _smRender,
        _smOnClick, _smOnWheel,
        _smSectionDifficulty, _smComputeGlass, _smGlassHtml, _smReadPhraseState,
        _getState: () => ({ bar: _smBar, sections: _smSections, duration: _smDuration }),
        _setState(next) {
            if ('sections' in next) _smSections = next.sections;
            if ('duration' in next) _smDuration = next.duration;
            if ('bar' in next) _smBar = next.bar;
        },
    };
} else {

// Side effects: poller + playSong/showScreen wrappers. Consolidated under
// one idempotency guard so re-evaluation (loader cache miss, hot reload,
// older core builds without the load-side guard) doesn't start a second
// 5Hz poller and doesn't grow either wrapper chain.
(function() {
    const HOOK_KEY = '__slopsmithSectionMapHooksInstalled';
    if (window[HOOK_KEY]) return;
    window[HOOK_KEY] = true;

    // Poll for updates
    setInterval(_smUpdate, 200);

    // Hook into playSong
    const origPlaySong = window.playSong;
    window.playSong = async function(filename, arrangement) {
        _smRemove();
        _smSections = [];
        _smDuration = 0;
        await origPlaySong(filename, arrangement);
        _smCreate();
    };

    // Clean up when leaving player
    const origShowScreen = window.showScreen;
    window.showScreen = function(id) {
        if (id !== 'player') _smRemove();
        origShowScreen(id);
    };
})();

}
