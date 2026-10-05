'use strict';
// Coverage for pure/DOM-light helpers in screen.js: section color lookup,
// time formatting, render HTML shape, click/wheel seek math.
// Runs under the org reusable CI as `node tests/screen.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function freshPlugin() {
    global.window = {};
    global.document = { getElementById: () => null };
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

class FakeBar {
    constructor() {
        this.innerHTML = '';
        this.style = {};
        this._listeners = {};
        this.left = 0;
        this.width = 500;
    }
    addEventListener(type, fn) { this._listeners[type] = fn; }
    getBoundingClientRect() { return { left: this.left, width: this.width }; }
    querySelectorAll() { return []; }
}

class FakeAudio {
    constructor() {
        this.currentTime = 0;
        this.paused = true;
        this._listeners = {};
    }
    pause() { this.paused = true; }
    play() { this.paused = false; }
    addEventListener(type, fn) { this._listeners[type] = fn; }
    removeEventListener() {}
}

test('_smGetColor matches by substring, case-insensitively', () => {
    const mod = freshPlugin();
    assert.equal(mod._smGetColor('Verse 1'), '#22c55e');
    assert.equal(mod._smGetColor('CHORUS'), '#eab308');
    assert.equal(mod._smGetColor('Guitar Solo'), '#ef4444');
});

test('_smGetColor falls back to default for an unrecognized section name', () => {
    const mod = freshPlugin();
    assert.equal(mod._smGetColor('Mystery Section'), '#4b5563');
});

test('_smFmt formats seconds as m:ss with zero-padded seconds', () => {
    const mod = freshPlugin();
    assert.equal(mod._smFmt(0), '0:00');
    assert.equal(mod._smFmt(65), '1:05');
    assert.equal(mod._smFmt(600), '10:00');
});

test('_smEscapeHtml neutralizes section-name markup in text and attributes', () => {
    const mod = freshPlugin();
    assert.equal(
        mod._smEscapeHtml('<img src=x onerror="alert(1)">\'&'),
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;',
    );
});

test('_smRender builds one .sm-block-tagged div per section plus a position marker', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    mod._setState({
        bar,
        sections: [{ name: 'Intro', time: 0 }, { name: 'Verse 1', time: 10 }],
        duration: 20,
    });
    mod._smRender();
    assert.equal((bar.innerHTML.match(/sm-block/g) || []).length, 2);
    assert.ok(bar.innerHTML.includes('id="sm-marker"'));
    assert.ok(bar.innerHTML.includes('left:0%'));   // Intro starts at 0%
    assert.ok(bar.innerHTML.includes('left:50%'));  // Verse 1 starts at 10/20
});

test('_smRender strips a trailing numeric suffix and capitalizes the label', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    mod._setState({ bar, sections: [{ name: 'verse2', time: 0 }], duration: 10 });
    mod._smRender();
    assert.ok(bar.innerHTML.includes('>Verse<'));
});

// The seek must go through the host's canonical funnel (window.feedBack.seek),
// NOT raw audio.currentTime — the funnel is what repositions a native/streaming
// backend and emits song:seek so the stem worklet reseeks. Poking the <audio>
// element only moved regions buffered near the playhead (the far-section bug).

test('_smOnClick routes the clicked fraction through the host seek funnel', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    bar.width = 500;
    const seeks = [];
    global.window.feedBack = { seek: (t, reason) => seeks.push([t, reason]) };
    const audio = new FakeAudio();
    mod._setState({ bar, sections: [{ name: 'Intro', time: 0 }], duration: 100 });
    global.document = { getElementById: (id) => (id === 'audio' ? audio : null) };

    mod._smOnClick({ clientX: 250 }); // 50% across a 500px-wide bar
    assert.deepEqual(seeks, [[50, 'sectionmap-click']]);
    assert.equal(audio.currentTime, 0, 'must not poke the raw element when the funnel exists');
});

test('_smOnClick clamps a right-edge overshoot to the song duration', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    bar.width = 500;
    const seeks = [];
    global.window.feedBack = { seek: (t, reason) => seeks.push([t, reason]) };
    global.document = { getElementById: () => null };
    mod._setState({ bar, sections: [{ name: 'Intro', time: 0 }], duration: 100 });

    mod._smOnClick({ clientX: 505 }); // pct = 1.01 -> would be 101s without the clamp
    assert.deepEqual(seeks, [[100, 'sectionmap-click']]);
});

test('_smNow reads the host clock (getTime) so a wheel nudge starts from real position', () => {
    const mod = freshPlugin();
    global.highway = { getTime: () => 42 };
    const seeks = [];
    global.window.feedBack = { seek: (t, reason) => seeks.push([t, reason]) };
    global.document = { getElementById: () => null };
    mod._setState({ bar: new FakeBar(), sections: [{ name: 'Intro', time: 0 }], duration: 100 });
    try {
        mod._smOnWheel({ deltaY: -1, ctrlKey: true, preventDefault: () => {} });
        assert.deepEqual(seeks, [[42.1, 'sectionmap-wheel']]); // 42 (host clock) + 0.1 fine step
    } finally {
        delete global.highway;
    }
});

test('_smOnWheel routes the computed delta through the funnel and clamps to [0, duration]', () => {
    const mod = freshPlugin();
    const seeks = [];
    global.window.feedBack = { seek: (t, reason) => seeks.push([t, reason]) };
    const audio = new FakeAudio();
    audio.currentTime = 0; // no host clock in test -> falls back to audio position
    global.document = { getElementById: (id) => (id === 'audio' ? audio : null) };
    mod._setState({ bar: new FakeBar(), sections: [{ name: 'Intro', time: 0 }], duration: 100 });

    let prevented = false;
    mod._smOnWheel({ deltaY: 1, ctrlKey: false, preventDefault: () => { prevented = true; } }); // backward from 0
    assert.equal(prevented, true);
    assert.deepEqual(seeks, [[0, 'sectionmap-wheel']]); // clamped at 0, can't go negative
});

// Fallback: a host too old to expose window.feedBack.seek still seeks the raw
// <audio> element, pausing/resuming around it as before.

test('_smOnClick falls back to the raw <audio>, pausing/seeking/resuming while playing', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    const audio = new FakeAudio();
    audio.paused = false;
    mod._setState({ bar, sections: [{ name: 'Intro', time: 0 }], duration: 100 });
    global.document = { getElementById: (id) => (id === 'audio' ? audio : null) };

    mod._smOnClick({ clientX: 0 }); // no window.feedBack.seek -> fallback path
    assert.equal(audio.currentTime, 0);
    assert.equal(audio.paused, true); // paused before the seek
    audio._listeners.seeked(); // simulate the browser firing 'seeked'
    assert.equal(audio.paused, false); // resumed
});

test('_smOnWheel fallback pokes the raw <audio> when there is no seek API', () => {
    const mod = freshPlugin();
    const audio = new FakeAudio();
    audio.currentTime = 10;
    audio.paused = true;
    mod._setState({ bar: new FakeBar(), sections: [{ name: 'Intro', time: 0 }], duration: 100 });
    global.document = { getElementById: (id) => (id === 'audio' ? audio : null) };

    mod._smOnWheel({ deltaY: -1, ctrlKey: true, preventDefault: () => {} });
    assert.equal(audio.currentTime, 10.1); // scroll up -> forward by 0.1s (ctrl = fine)
});

test('_smOnWheel/_smOnClick are no-ops without a known duration', () => {
    const mod = freshPlugin();
    const audio = new FakeAudio();
    mod._setState({ bar: new FakeBar(), sections: [], duration: 0 });
    global.document = { getElementById: (id) => (id === 'audio' ? audio : null) };

    mod._smOnClick({ clientX: 100 });
    mod._smOnWheel({ deltaY: 1, preventDefault: () => {} });
    assert.equal(audio.currentTime, 0); // untouched
});

test('_smSetPlayerVisible keeps at most one poller/subscription across show/hide cycles', () => {
    const mod = freshPlugin();
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalHighway = global.highway;
    let nextId = 1;
    const activeIntervals = new Map();
    let setCalls = 0;
    let clearCalls = 0;
    let onCalls = 0;
    let unsubscribeCalls = 0;

    global.highway = {
        getSections: () => [],
        getSongInfo: () => ({ duration: 0 }),
        getTime: () => 0,
    };
    global.window.feedBack = {
        on: () => {
            onCalls++;
            return () => { unsubscribeCalls++; };
        },
    };
    global.setInterval = (fn) => {
        setCalls++;
        const id = nextId++;
        activeIntervals.set(id, fn);
        return id;
    };
    global.clearInterval = (id) => {
        clearCalls++;
        activeIntervals.delete(id);
    };

    try {
        mod._smSetPlayerVisible(true);
        mod._smSetPlayerVisible(true);
        assert.equal(setCalls, 1);
        assert.equal(onCalls, 1);
        assert.equal(activeIntervals.size, 1);

        mod._smSetPlayerVisible(false);
        assert.equal(clearCalls, 1);
        assert.equal(unsubscribeCalls, 1);
        assert.equal(activeIntervals.size, 0);

        mod._smSetPlayerVisible(true);
        assert.equal(setCalls, 2);
        assert.equal(onCalls, 2);
        assert.equal(activeIntervals.size, 1);

        mod._smSetPlayerVisible(false);
        assert.equal(clearCalls, 2);
        assert.equal(unsubscribeCalls, 2);
        assert.equal(activeIntervals.size, 0);
    } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});

test('_smSetPlayerVisible(false) stops polling so inactive screens do not tick _smUpdate', () => {
    const mod = freshPlugin();
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalHighway = global.highway;
    let nextId = 1;
    const activeIntervals = new Map();
    let ticks = 0;

    const tickAll = () => {
        for (const fn of activeIntervals.values()) {
            ticks++;
            fn();
        }
    };

    global.highway = {
        getSections: () => [],
        getSongInfo: () => ({ duration: 0 }),
        getTime: () => 0,
    };
    global.window.feedBack = { on: () => () => {} };
    global.setInterval = (fn) => {
        const id = nextId++;
        activeIntervals.set(id, fn);
        return id;
    };
    global.clearInterval = (id) => {
        activeIntervals.delete(id);
    };

    try {
        mod._smSetPlayerVisible(true);
        tickAll();
        tickAll();
        assert.equal(ticks, 2);

        mod._smSetPlayerVisible(false);
        tickAll();
        tickAll();
        assert.equal(ticks, 2);
    } finally {
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});


// _smRender bakes opacity:0.5 into every block up front so _smUpdate's
// per-tick highlight pass never needs a querySelectorAll/forEach sweep —
// it only ever touches the (at most two) blocks whose active state flipped.

test('_smRender bakes opacity:0.5 into every block', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    mod._setState({
        bar,
        sections: [{ name: 'Intro', time: 0 }, { name: 'Verse 1', time: 10 }, { name: 'Chorus', time: 20 }],
        duration: 30,
    });
    mod._smRender();
    assert.equal((bar.innerHTML.match(/opacity:0\.5/g) || []).length, 3);
});

test('_smUpdate only touches the blocks whose active state changed, leaving cached blockEls alone otherwise', () => {
    const mod = freshPlugin();
    const originalHighway = global.highway;
    const sections = [{ name: 'Intro', time: 0 }, { name: 'Verse 1', time: 10 }, { name: 'Chorus', time: 20 }];
    const blockEls = sections.map(() => ({ style: {} }));
    const markerEl = { style: {} };
    let t = 0;
    global.highway = {
        getSections: () => sections,
        getSongInfo: () => ({ duration: 30 }),
        getTime: () => t,
    };
    try {
        // Same `sections` reference as highway.getSections() returns, so
        // _smUpdate's "only rebuild if sections changed" check skips
        // _smRender() and our injected blockEls/markerEl survive untouched.
        mod._setState({ bar: new FakeBar(), sections, duration: 30, blockEls, markerEl, activeIdx: -1 });

        mod._smUpdate();
        assert.equal(blockEls[0].style.opacity, '1');
        assert.equal(blockEls[1].style.opacity, undefined);
        assert.equal(blockEls[2].style.opacity, undefined);
        assert.equal(markerEl.style.left, '0%');

        t = 15;
        mod._smUpdate();
        assert.equal(blockEls[0].style.opacity, '0.5', 'previous active block reverts to inactive');
        assert.equal(blockEls[1].style.opacity, '1', 'newly active block is highlighted');
        assert.equal(blockEls[2].style.opacity, undefined, 'never-active block is left untouched');
        assert.equal(markerEl.style.left, '50%');
    } finally {
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});

test('_smUpdate clears a stale bar/state once the current song has no section data', () => {
    const mod = freshPlugin();
    const originalHighway = global.highway;
    const bar = new FakeBar();
    const sections = [{ name: 'Intro', time: 0 }, { name: 'Chorus', time: 30 }];
    try {
        global.highway = {
            getSections: () => sections,
            getSongInfo: () => ({ duration: 120 }),
            getTime: () => 5,
        };
        mod._setState({ bar, sections: [], duration: 0 });
        mod._smUpdate();
        assert.ok(bar.innerHTML.includes('Intro'), 'sanity: first song rendered');

        // Switch to a song/arrangement with no section data WITHOUT going
        // through _smRemove() (mirrors a core re-stream that bypasses the
        // playSong wrapper, e.g. an in-player arrangement switch, or any
        // path that skips the wrapper's own state reset).
        global.highway.getSections = () => [];
        global.highway.getSongInfo = () => ({ duration: 200 });
        mod._smUpdate();

        const state = mod._getState();
        assert.deepEqual(state.sections, []);
        assert.equal(state.duration, 0);
        assert.equal(state.activeIdx, -1);
        assert.equal(bar.innerHTML, '', 'stale blocks from the previous song must not linger');

        // A further tick with still-no-sections is a no-op, not a rebuild.
        mod._smUpdate();
        assert.equal(bar.innerHTML, '');
    } finally {
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});

test('_smUpdate clears the bar even when song:ready already zeroed _smSections first', () => {
    // The song:ready handler (installed in _smStartRealtimeHooks) sets
    // _smSections = [] itself and THEN calls _smUpdate() directly -- so on
    // that path _smSections is already empty by the time _smUpdate's guard
    // runs. Gating the clear on `_smSections.length > 0` (the original fix)
    // made it a no-op on exactly this path: the bar's stale rendered blocks
    // and cached marker/block-el refs never got cleared. This test
    // reproduces that ordering directly (bypassing the real event
    // subscription) and asserts the bar clears anyway.
    const mod = freshPlugin();
    const originalHighway = global.highway;
    const bar = new FakeBar();
    bar.innerHTML = '<div class="sm-block">Intro</div>';
    const staleBlockEl = { style: {} };
    const staleMarkerEl = { style: {} };
    try {
        global.highway = {
            getSections: () => [],
            getSongInfo: () => ({ duration: 200 }),
            getTime: () => 0,
        };
        // Mirrors song:ready's own reset (sections already []) landing
        // just before _smUpdate() is called, while the bar DOM/cached
        // refs from the PREVIOUS song are still live.
        mod._setState({
            bar, sections: [], duration: 0,
            blockEls: [staleBlockEl], markerEl: staleMarkerEl, activeIdx: 0,
        });

        mod._smUpdate();

        const state = mod._getState();
        assert.equal(bar.innerHTML, '', 'stale blocks must clear even though _smSections was already []');
        assert.equal(state.markerEl, null);
        assert.deepEqual(state.blockEls, []);
        assert.equal(state.activeIdx, -1);
    } finally {
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});

// _smUpdateDifficultyFills updates an existing glass in place (no DOM
// rebuild) on a difficulty refresh, only rebuilding the one glass element
// when its size bucket changes, per its own doc comment.

class FakeGlassFill {
    constructor() { this.style = {}; }
}

class FakeGlass {
    constructor(size, fillPct) {
        this._size = size;
        this.title = `Difficulty: ${fillPct}%`;
        this.removed = false;
        this._fill = new FakeGlassFill();
        this._fill.style.height = fillPct + '%';
    }
    getAttribute(name) { return name === 'data-size' ? this._size : null; }
    querySelector(sel) { return sel === '.sm-glass-fill' ? this._fill : null; }
    remove() { this.removed = true; }
}

class FakeDifficultyBlock {
    constructor(glass) {
        this._glass = glass || null;
        this.insertedHTML = [];
    }
    querySelector(sel) { return sel === '.sm-glass' ? this._glass : null; }
    insertAdjacentHTML(_pos, html) {
        this.insertedHTML.push(html);
        const sizeMatch = html.match(/data-size="(\w+)"/);
        const fillMatch = html.match(/height:([\d.]+)%/);
        const titleMatch = html.match(/title="([^"]*)"/);
        const glass = new FakeGlass(sizeMatch ? sizeMatch[1] : 'medium', fillMatch ? fillMatch[1] : '0');
        if (titleMatch) glass.title = titleMatch[1];
        this._glass = glass;
    }
}

test('_smUpdateDifficultyFills updates an existing glass fill/title in place without rebuilding it', () => {
    const mod = freshPlugin();
    const glass = new FakeGlass('medium', 10);
    const block = new FakeDifficultyBlock(glass);
    mod._setState({
        bar: new FakeBar(),
        blockEls: [block],
        sectionDifficulty: [{ fillPercentage: 40, glassSize: 'medium' }],
        ddAvailable: true,
    });

    mod._smUpdateDifficultyFills();

    assert.equal(block._glass, glass, 'same glass element reused, not rebuilt');
    assert.equal(glass.removed, false);
    assert.equal(block.insertedHTML.length, 0);
    assert.equal(glass._fill.style.height, '40%');
    assert.equal(glass.title, 'Difficulty: 40%');
});

test('_smUpdateDifficultyFills rebuilds the glass when its size bucket changes', () => {
    const mod = freshPlugin();
    const glass = new FakeGlass('small', 10);
    const block = new FakeDifficultyBlock(glass);
    mod._setState({
        bar: new FakeBar(),
        blockEls: [block],
        sectionDifficulty: [{ fillPercentage: 75, glassSize: 'large' }],
        ddAvailable: true,
    });

    mod._smUpdateDifficultyFills();

    assert.equal(glass.removed, true, 'old size-mismatched glass is discarded');
    assert.equal(block.insertedHTML.length, 1);
    assert.notEqual(block._glass, glass, 'a fresh glass element replaces it');
    assert.equal(block._glass.title, 'Difficulty: 75%');
});

test('_smUpdateDifficultyFills removes a stale glass once difficulty data is no longer available', () => {
    const mod = freshPlugin();
    const glass = new FakeGlass('medium', 10);
    const block = new FakeDifficultyBlock(glass);
    mod._setState({
        bar: new FakeBar(),
        blockEls: [block],
        sectionDifficulty: [],
        ddAvailable: true,
    });

    mod._smUpdateDifficultyFills();

    assert.equal(glass.removed, true);
});

test('_smSetPlayerVisible retries event subscription after feedBack becomes available', () => {
    const mod = freshPlugin();
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalHighway = global.highway;
    const originalFeedBack = global.window.feedBack;
    let intervalId = 0;
    let onCalls = 0;
    let unsubscribeCalls = 0;

    global.highway = {
        getSections: () => [],
        getSongInfo: () => ({ duration: 0 }),
        getTime: () => 0,
    };
    delete global.window.feedBack;
    global.setInterval = () => ++intervalId;
    global.clearInterval = () => {};

    try {
        mod._smSetPlayerVisible(true);
        global.window.feedBack = {
            on: () => {
                onCalls++;
                return () => { unsubscribeCalls++; };
            },
        };

        mod._smSetPlayerVisible(true);
        assert.equal(onCalls, 1);

        mod._smSetPlayerVisible(false);
        assert.equal(unsubscribeCalls, 1);
    } finally {
        mod._smSetPlayerVisible(false);
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
        if (typeof originalFeedBack === 'undefined') delete global.window.feedBack;
        else global.window.feedBack = originalFeedBack;
    }
});


// Difficulty Ladder peer contract (issue #13): absent, late-loaded, minimum, and
// current providers, plus malformed and older payloads. The glasses are the only
// feature that depends on the peer, so every one of these has to leave base
// section navigation working.

// Minimal stand-in for a host event bus: records (event, handler) so a test can
// fire the peer's event exactly as the host would, and count subscriptions.
function fakeEventBus() {
    const handlers = new Map();
    return {
        calls: [],
        on(eventName, handler) {
            this.calls.push(eventName);
            // Replace the list rather than mutating it: fire() captures the list
            // when it starts, so a handler that subscribes or unsubscribes
            // mid-dispatch can't disturb the dispatch already in progress.
            handlers.set(eventName, (handlers.get(eventName) || []).concat(handler));
            return () => {
                handlers.set(eventName, (handlers.get(eventName) || []).filter((h) => h !== handler));
            };
        },
        count(eventName) { return (handlers.get(eventName) || []).length; },
        fire(eventName, event) {
            for (const handler of handlers.get(eventName) || []) handler(event);
        },
    };
}

// A difficulty_ladder.sections.v2 payload, as difficulty_ladder emits it: an
// object map keyed by section index, one entry per section that has an
// overlapping phrase (sections with none are simply absent).
function v2Payload(entries) {
    return {
        schema: 'difficulty_ladder.sections.v2',
        sectionDifficulties: entries,
        mastery: 0.5,
        maxDifficulty: 4,
    };
}

test('peer contract: no provider means no subscription and no glasses', () => {
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    assert.equal(mod._smIsDynamicDifficultyAvailable(), false);

    mod._smEnsureDifficultySubscription();
    mod._smEnsureDifficultySubscription();

    assert.equal(mod._getState().ddAvailable, false);
    assert.deepEqual(bus.calls, [], 'must not subscribe without the capability marker');
    mod._setState({ sectionDifficulty: { 0: { fillPercentage: 50 } } });
    assert.equal(mod._smGetSectionDifficulty(0), null, 'cached data stays unreachable while the peer is absent');
});

test('peer contract: a bare _ddCapabilities global is not a provider', () => {
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    // Some other plugin using the same global name, or a ladder build from
    // before the v2 contract existed. Either way, no sectionDifficulty marker.
    global.window._ddCapabilities = { somethingElse: true };
    try {
        assert.equal(mod._smIsDynamicDifficultyAvailable(), false);
        mod._smEnsureDifficultySubscription();
        assert.deepEqual(bus.calls, []);
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: a late-loading provider is picked up by the next _smUpdate tick', () => {
    // The original handshake decided once, at player-screen mount, which relied
    // on the Host loading plugins alphabetically (difficulty_ladder <
    // section_map). A deferred or reloaded plugin load left the feature
    // unsubscribed for the rest of the session; the retry is the poller.
    const mod = freshPlugin();
    const originalHighway = global.highway;
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    global.highway = {
        getSections: () => [],
        getSongInfo: () => ({ duration: 0 }),
        getTime: () => 0,
    };
    try {
        mod._setState({ bar: new FakeBar() });
        mod._smUpdate(); // player already visible, peer not loaded yet
        assert.equal(bus.count('difficulty:sections-updated'), 0);

        global.window._ddCapabilities = { sectionDifficulty: true };
        mod._smUpdate();
        assert.equal(bus.count('difficulty:sections-updated'), 1, 'subscribed on the next tick');

        mod._smUpdate();
        mod._smUpdate();
        assert.equal(bus.count('difficulty:sections-updated'), 1, 'subscribed exactly once');
    } finally {
        delete global.window._ddCapabilities;
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});

test('peer contract: a minimum (v0.12.0) provider payload renders glasses', () => {
    // v0.12.0 is the floor: the first release documenting the v2 payload shape.
    // It advertises sectionDifficulty and no sectionsSchema (v3 came later).
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    global.window._ddCapabilities = { sectionDifficulty: true };
    try {
        mod._smEnsureDifficultySubscription();
        assert.equal(mod._getState().ddAvailable, true);

        bus.fire('difficulty:sections-updated', { detail: v2Payload({
            0: { fillPercentage: 40, glassSize: 'small', avgDifficulty: 2, maxDifficulty: 2 },
            1: { fillPercentage: 100, glassSize: 'large', avgDifficulty: 4, maxDifficulty: 4 },
        }) });

        const state = mod._getState();
        assert.equal(state.sectionDifficulty[0].fillPercentage, 40);
        assert.equal(state.sectionDifficulty[1].glassSize, 'large');
        // A section the peer reported nothing for is "no glass", not a zero fill.
        assert.equal(mod._smGetSectionDifficulty(2), null);
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: a current provider payload renders in place without a full re-render', () => {
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    // Current builds also advertise sectionsSchema, and emit v2 alongside v3.
    global.window._ddCapabilities = {
        sectionDifficulty: true,
        sectionsSchema: 'difficulty_ladder.sections.v3',
    };
    try {
        mod._smEnsureDifficultySubscription();
        const bar = new FakeBar();
        const block = new FakeDifficultyBlock(new FakeGlass('medium', 10));
        mod._setState({
            bar,
            sections: [{ name: 'Intro', time: 0 }],
            duration: 10,
            blockEls: [block],
            sectionDifficulty: {},
        });

        bus.fire('difficulty:sections-updated', { detail: v2Payload({
            0: { fillPercentage: 60, glassSize: 'medium' },
        }) });

        assert.equal(block.insertedHTML.length, 0, 'existing glass updated in place');
        assert.equal(block._glass._fill.style.height, '60%');
        assert.equal(block._glass.title, 'Difficulty: 60%');
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: an event with no detail leaves the last good state alone', () => {
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    global.window._ddCapabilities = { sectionDifficulty: true };
    try {
        mod._smEnsureDifficultySubscription();
        bus.fire('difficulty:sections-updated', { detail: v2Payload({ 0: { fillPercentage: 25, glassSize: 'small' } }) });

        bus.fire('difficulty:sections-updated', undefined);
        bus.fire('difficulty:sections-updated', { detail: {} });
        bus.fire('difficulty:sections-updated', { detail: { sectionDifficulties: 'nope' } });

        assert.equal(mod._getState().sectionDifficulty[0].fillPercentage, 25, 'malformed payloads must not clear good data');
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: an unreadable payload entry paints no glass', () => {
    // The peer computes fillPercentage arithmetically, so it is NaN whenever
    // mastery or the phrase difficulty isn't a number -- and NaN is typeof
    // 'number', which used to sail through the renderer's own check and paint
    // `height:NaN%`. A payload that isn't the v2 shape at all is dropped the
    // same way: an entry we can't read renders no glass rather than a
    // misleading near-empty one.
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    global.window._ddCapabilities = { sectionDifficulty: true };
    try {
        mod._smEnsureDifficultySubscription();
        mod._setState({ sectionDifficulty: { 0: { fillPercentage: 25, glassSize: 'small' } } });

        bus.fire('difficulty:sections-updated', { detail: {
            sectionDifficulties: {
                0: { fillPercentage: NaN },  // peer arithmetic went NaN
                1: { fillPercentage: '50' }, // string, not a number
                2: { fillPercentage: null },
                3: null,                      // not even an object
                4: { glassSize: 'small' },    // no fill field at all
            },
        } });

        const state = mod._getState();
        assert.deepEqual(Object.keys(state.sectionDifficulty), []);
        assert.equal(mod._smGetSectionDifficulty(0), null, 'unreadable entries render no glass');
        assert.equal(mod._smRenderGlassFilling({ fillPercentage: NaN }), '', 'NaN fill renders nothing at all');
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('_smRenderGlassFilling only ever writes an allowlisted glassSize into markup', () => {
    // glassSize is the one payload field that reaches an HTML attribute
    // unescaped (data-size), so an unrecognized value must resolve to `medium`
    // rather than being interpolated verbatim.
    const mod = freshPlugin();
    for (const size of ['small', 'medium', 'large']) {
        assert.ok(
            mod._smRenderGlassFilling({ fillPercentage: 50, glassSize: size }).includes(`data-size="${size}"`),
            `${size} renders its own bucket`,
        );
    }
    for (const bogus of ['huge', '"><script>alert(1)</script>', undefined, null]) {
        const html = mod._smRenderGlassFilling({ fillPercentage: 50, glassSize: bogus });
        assert.ok(html.includes('data-size="medium"'), `${bogus} falls back to medium`);
        assert.ok(!html.includes('<script'), `${bogus} must not reach markup`);
    }
});

test('peer contract: hiding the player detaches the difficulty subscription and re-show re-attaches one', () => {
    // _smDifficultySubscribed is written from two places (the mount path and the
    // per-tick retry) and reset on hide; a double-subscribe here would double
    // every difficulty repaint for the rest of the session.
    const mod = freshPlugin();
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalHighway = global.highway;
    const bus = fakeEventBus();

    global.window.feedBack = bus;
    global.window._ddCapabilities = { sectionDifficulty: true };
    global.highway = {
        getSections: () => [],
        getSongInfo: () => ({ duration: 0 }),
        getTime: () => 0,
    };
    global.setInterval = () => 1;
    global.clearInterval = () => {};

    try {
        mod._smSetPlayerVisible(true);
        assert.equal(bus.count('difficulty:sections-updated'), 1);

        mod._smSetPlayerVisible(false);
        assert.equal(bus.count('difficulty:sections-updated'), 0, 'hide must detach');

        mod._smSetPlayerVisible(true);
        assert.equal(bus.count('difficulty:sections-updated'), 1, 're-show re-subscribes exactly once');

        // And a tick must not add a second handler on top.
        mod._smUpdate();
        mod._smUpdate();
        assert.equal(bus.count('difficulty:sections-updated'), 1);
    } finally {
        mod._smSetPlayerVisible(false);
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        delete global.window._ddCapabilities;
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});

test('peer contract: the per-tick retry never re-registers when the bus hands back no unsubscribe', () => {
    // The bus is not required to return an unsubscribe handle (a plain
    // EventTarget's on/off returns undefined). Registering once and keeping the
    // handler is the only correct outcome -- re-registering every 200ms would
    // leak a handler per tick.
    const mod = freshPlugin();
    const originalHighway = global.highway;
    let registrations = 0;
    global.window.feedBack = {
        on() { registrations++; return undefined; },
    };
    global.window._ddCapabilities = { sectionDifficulty: true };
    global.highway = {
        getSections: () => [],
        getSongInfo: () => ({ duration: 0 }),
        getTime: () => 0,
    };
    try {
        mod._setState({ bar: new FakeBar() });
        for (let i = 0; i < 5; i++) mod._smUpdate();
        assert.equal(registrations, 1);
    } finally {
        delete global.window._ddCapabilities;
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});

test('peer contract: the retry waits for the host bus when the peer is already up', () => {
    // Peer present, host event bus not: nothing to subscribe to yet, so keep
    // retrying rather than marking the subscription done.
    const mod = freshPlugin();
    const originalHighway = global.highway;
    global.window._ddCapabilities = { sectionDifficulty: true };
    global.highway = {
        getSections: () => [],
        getSongInfo: () => ({ duration: 0 }),
        getTime: () => 0,
    };
    try {
        mod._setState({ bar: new FakeBar() });
        mod._smUpdate();
        assert.equal(mod._getState().difficultySubscribed, false);

        const bus = fakeEventBus();
        global.window.feedBack = bus;
        mod._smUpdate();
        assert.equal(bus.count('difficulty:sections-updated'), 1);
    } finally {
        delete global.window._ddCapabilities;
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});

test('_smNormalizeSectionDifficulties separates an unusable payload from an empty one', () => {
    const mod = freshPlugin();
    // null: not an object at all -> "ignore the event", keep current state.
    assert.equal(mod._smNormalizeSectionDifficulties(undefined), null);
    assert.equal(mod._smNormalizeSectionDifficulties(null), null);
    assert.equal(mod._smNormalizeSectionDifficulties(7), null);
    // {}: a well-formed map with nothing renderable -> "clear the glasses".
    assert.deepEqual(mod._smNormalizeSectionDifficulties({}), {});
    assert.deepEqual(mod._smNormalizeSectionDifficulties({ 0: 'nope' }), {});
    // A 0% fill is real data (a section with no chart content), not a missing one.
    const zeroFill = mod._smNormalizeSectionDifficulties({ 0: { fillPercentage: 0, glassSize: 'small' } });
    assert.equal(zeroFill[0].fillPercentage, 0);
    // Surrounding keys are not the contract: the producer keys by section index,
    // and only the entries we can render survive.
    assert.deepEqual(
        Object.keys(mod._smNormalizeSectionDifficulties({ 0: { fillPercentage: 1 }, schema: 'x' })),
        ['0'],
    );
});

