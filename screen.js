// Section Map plugin
// Shows a minimap bar of the full song structure with clickable sections.
// Includes optional glass-filling difficulty visualization when dynamic-difficulty is installed.

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

// Check if dynamic-difficulty plugin is installed and available
function _smIsDynamicDifficultyAvailable() {
    if (typeof window.feedBack === 'undefined') return false;
    // Check if dynamic-difficulty is in the active plugins list or has exposed a capability
    if (typeof window.feedBackViz_dynamic_difficulty !== 'undefined') return true;
    // Additional check: look for dynamic-difficulty's global scope if available
    if (typeof window._ddCapabilities !== 'undefined') return true;
    return false;
}

// Get difficulty data for a section from dynamic-difficulty plugin
function _smGetSectionDifficulty(sectionIndex) {
    if (!_smDynamicDifficultyAvailable) return null;
    // This would be populated by a capability or event from dynamic-difficulty
    // For now, return from cache if available
    return _smSectionDifficulty[sectionIndex] || null;
}

// Initialize difficulty data listener if dynamic-difficulty is available
function _smInitializeDifficultyListener() {
    _smDynamicDifficultyAvailable = _smIsDynamicDifficultyAvailable();
}

function _smSubscribeFeedBackEvent(eventName, handler) {
    if (typeof window.feedBack === 'undefined' || typeof window.feedBack.on !== 'function') return null;
    const unsubscribe = window.feedBack.on(eventName, handler);
    if (typeof unsubscribe === 'function') return unsubscribe;
    if (typeof window.feedBack.off === 'function') return () => window.feedBack.off(eventName, handler);
    return null;
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

    _smInitializeDifficultyListener();
    if (_smDynamicDifficultyAvailable && !_smDifficultySubscribed) {
        _smDifficultyUnsubscribe = _smSubscribeFeedBackEvent('difficulty:sections-updated', (event) => {
            const { sectionDifficulties } = event.detail || {};
            if (sectionDifficulties) {
                _smSectionDifficulty = sectionDifficulties;
                _smRender();
            }
        });
        _smDifficultySubscribed = typeof _smDifficultyUnsubscribe === 'function';
    }
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
        html += `<div class="sm-block" style="position:absolute;left:${startPct}%;width:${widthPct}%;top:0;bottom:0;background:${color};border-right:1px solid rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;overflow:hidden;transition:opacity 0.15s;"
            title="${safeTitle}">
            ${difficultyContent}
            <span style="font-size:9px;color:rgba(255,255,255,0.8);white-space:nowrap;text-overflow:ellipsis;overflow:hidden;padding:0 3px;">${safeLabel}</span>
        </div>`;
    }

    // Playback position marker
    html += '<div id="sm-marker" style="position:absolute;top:0;bottom:0;width:2px;background:white;z-index:1;pointer-events:none;transition:left 0.1s linear;"></div>';

    _smBar.innerHTML = html;
    _smBar.style.position = 'relative';
}

// Render glass-filling visualization for section difficulty
function _smRenderGlassFilling(difficulty) {
    if (!difficulty || typeof difficulty.fillPercentage !== 'number') return '';

    const fillPct = Math.max(0, Math.min(100, difficulty.fillPercentage));
    const glassSize = difficulty.glassSize || 'medium'; // small, medium, large

    // Size classes for the glass
    const sizeStyles = {
        small: 'width:12px;height:12px;',
        medium: 'width:16px;height:16px;',
        large: 'width:20px;height:20px;',
    };

    const glassStyle = sizeStyles[glassSize] || sizeStyles.medium;

    return `<div style="position:relative;${glassStyle}margin-right:4px;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);border-radius:2px;display:flex;align-items:flex-end;overflow:hidden;"
        title="Difficulty: ${fillPct.toFixed(0)}%">
        <div style="width:100%;height:${fillPct}%;background:rgba(255,200,100,0.7);transition:height 0.3s ease;"></div>
    </div>`;
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
// IIFE below (poller + playSong/showScreen wrapping).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        _smGetColor, _smFmt, _smCreate, _smRemove, _smUpdate, _smRender,
        _smOnClick, _smOnWheel, _smEscapeHtml,
        _smIsDynamicDifficultyAvailable, _smGetSectionDifficulty, _smRenderGlassFilling,
        _smInitializeDifficultyListener, _smStartRealtimeHooks, _smStopRealtimeHooks, _smSetPlayerVisible,
        _getState: () => ({ bar: _smBar, sections: _smSections, duration: _smDuration, sectionDifficulty: _smSectionDifficulty, ddAvailable: _smDynamicDifficultyAvailable }),
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

    // Clean up when leaving player
    const origShowScreen = window.showScreen;
    window.showScreen = function(id) {
        _smSetPlayerVisible(id === 'player');
        origShowScreen(id);
    };
})();

}
