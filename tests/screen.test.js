'use strict';
// Coverage for pure/DOM-light helpers in screen.js: section color lookup,
// time formatting, render HTML shape, click/wheel seek math, and the
// Difficulty Ladder tier-rail contract (v3 preferred, v2 during transition).
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

// Tier semantics (issue #14): the rail is driven by v3's semantic fields
// (current_tier / top_tier / max_tier / has_chart_content), never by a size.

test('_smTierModel reads current/top/max tiers and treats top_tier 0 with content as full detail', () => {
    const mod = freshPlugin();
    assert.equal(mod._smTierModel(null), null);

    const normal = mod._smTierModel({ max_tier: 4, top_tier: 3, current_tier: 2, has_chart_content: true });
    assert.deepEqual(normal, { maxTier: 4, topTier: 3, currentTier: 2, full: false });

    // current_tier is clamped to top_tier: above that tier the entry is already
    // played in full, so there is no larger tier to report.
    const over = mod._smTierModel({ max_tier: 4, top_tier: 2, current_tier: 4, has_chart_content: true });
    assert.equal(over.currentTier, 2);
    assert.equal(over.full, true);

    // top_tier 0 with content: easy but playable, full at every position.
    const easy = mod._smTierModel({ max_tier: 0, top_tier: 0, current_tier: 0, has_chart_content: true });
    assert.deepEqual(easy, { maxTier: 0, topTier: 0, currentTier: 0, full: true });

    // top_tier 0 without content: silent, not "easy" -- no rail at all.
    assert.equal(mod._smTierModel({ max_tier: 0, top_tier: 0, current_tier: null, has_chart_content: false }), null);

    // A null current_tier keeps the rail (with the outline) but lights nothing.
    const unknown = mod._smTierModel({ max_tier: 3, top_tier: 3, current_tier: null, has_chart_content: true });
    assert.equal(unknown.currentTier, null);
    assert.equal(unknown.full, false);
});

test('_smTierSuffix renders the shared readable detail, omitting the full-detail clause with no ladder', () => {
    const mod = freshPlugin();
    assert.equal(mod._smTierSuffix(null), '');
    assert.equal(
        mod._smTierSuffix({ maxTier: 4, topTier: 3, currentTier: 2, full: false }),
        'tier 2 of 4 · full detail at 3',
    );
    assert.equal(
        mod._smTierSuffix({ maxTier: 0, topTier: 0, currentTier: 0, full: true }),
        'tier 0 of 0',
    );
    assert.equal(
        mod._smTierSuffix({ maxTier: 3, topTier: 3, currentTier: null, full: false }),
        'tier unknown · full detail at 3',
    );
});

test('_smRenderTierRail lights current+1 segments and outlines the full-detail threshold', () => {
    const mod = freshPlugin();
    const html = mod._smRenderTierRail({ maxTier: 3, topTier: 3, currentTier: 1, full: false }, 500);
    assert.equal((html.match(/class="sm-rail-seg"/g) || []).length, 4, 'maxTier + 1 segments');
    assert.equal((html.match(/#e8c040/g) || []).length, 2, 'tiers 0 and 1 are lit');
    assert.equal((html.match(/rgba\(200,200,200,0\.25\)/g) || []).length, 2, 'tiers 2 and 3 are unlit');
    assert.equal((html.match(/#f4d35e/g) || []).length, 1, 'exactly one outline marks topTier');
    assert.ok(!html.includes('sm-rail-marker'), 'a wide block draws segments, not a marker');

    // The easy-but-playable case (maxTier 0) is a single segment, still
    // outlined — the same semantic the collapsed form draws.
    const easy = mod._smRenderTierRail({ maxTier: 0, topTier: 0, currentTier: 0, full: true }, 500);
    assert.equal((easy.match(/class="sm-rail-seg/g) || []).length, 1);
    assert.equal((easy.match(/#e8c040/g) || []).length, 1, 'the single segment is lit');
    assert.equal((easy.match(/#f4d35e/g) || []).length, 1, 'and outlined');
});

test('_smRenderTierRail collapses to a single marker when the block cannot fit segments', () => {
    const mod = freshPlugin();
    // maxTier 3 -> 4 segments * 5px + 3 gaps = 23px needed; 10px cannot fit.
    const narrow = mod._smRenderTierRail({ maxTier: 3, topTier: 3, currentTier: 1, full: false }, 10);
    assert.equal((narrow.match(/sm-rail-marker/g) || []).length, 1);
    assert.equal((narrow.match(/class="sm-rail-seg/g) || []).length, 1, 'only the marker is drawn');

    // An unmeasurable width (bar not laid out) keeps the segments.
    const unmeasured = mod._smRenderTierRail({ maxTier: 3, topTier: 3, currentTier: 1, full: false }, 0);
    assert.ok(!unmeasured.includes('sm-rail-marker'));
    assert.equal((unmeasured.match(/class="sm-rail-seg"/g) || []).length, 4);
});

test('_smRender attaches a rail plus a focusable, readable detail to a section with tier data', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    mod._setState({
        bar,
        sections: [{ name: 'verse2', time: 0 }, { name: 'Chorus', time: 1 }],
        duration: 100,
        ddAvailable: true,
        sectionTiers: {
            0: { index: 0, max_tier: 4, top_tier: 3, current_tier: 2, has_chart_content: true },
            1: { index: 1, max_tier: 2, top_tier: 2, current_tier: 2, has_chart_content: true },
        },
    });
    mod._smRender();
    assert.ok(bar.innerHTML.includes('class="sm-rail"'), 'rail container rendered');
    assert.ok(bar.innerHTML.includes('tabindex="0"'), 'tier-bearing block is focusable');
    assert.ok(
        bar.innerHTML.includes('aria-label="Verse 2 · tier 2 of 4 · full detail at 3"'),
        'accessible name carries the shared detail',
    );
    assert.ok(
        bar.innerHTML.includes('title="Verse 2 (0:00) · tier 2 of 4 · full detail at 3"'),
        'hover title carries the same detail',
    );
});

test('_smRender collapses a very narrow section to a single marker without dropping its label', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    bar.width = 500;
    // Intro is 1% of a 500px bar = 5px -> a 4-segment rail cannot fit.
    mod._setState({
        bar,
        sections: [{ name: 'Intro', time: 0 }, { name: 'Verse 1', time: 1 }],
        duration: 100,
        ddAvailable: true,
        sectionTiers: {
            0: { index: 0, max_tier: 3, top_tier: 3, current_tier: 1, has_chart_content: true },
            1: { index: 1, max_tier: 3, top_tier: 3, current_tier: 1, has_chart_content: true },
        },
    });
    mod._smRender();
    assert.equal((bar.innerHTML.match(/sm-rail-marker/g) || []).length, 1, 'narrow Intro collapses');
    assert.ok(bar.innerHTML.includes('>Intro<'), 'label survives the collapse');
});

test('_smRender leaves a section without tier data without a rail or tab stop', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    mod._setState({
        bar,
        sections: [{ name: 'Intro', time: 0 }],
        duration: 10,
        ddAvailable: true,
        sectionTiers: {}, // no overlapping phrase -> absent entry
    });
    mod._smRender();
    assert.ok(!bar.innerHTML.includes('class="sm-rail"'));
    assert.ok(!bar.innerHTML.includes('tabindex'));
});

// _smUpdateTierRails updates an existing rail in place (no DOM rebuild) on a
// difficulty refresh, and only for the sections whose tier data changed.

class FakeRail {
    constructor(html) { this._innerHTML = html || ''; this.writes = 0; this.removed = false; }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) { this._innerHTML = v; this.writes++; }
    remove() { this.removed = true; }
}

class FakeRailBlock {
    constructor(rail) { this._rail = rail || null; this.title = ''; this._attrs = {}; this.inserted = []; }
    querySelector(sel) { return sel === '.sm-rail' ? this._rail : null; }
    insertAdjacentHTML(_pos, html) {
        this.inserted.push(html);
        const inner = html.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '');
        this._rail = new FakeRail(inner);
    }
    setAttribute(name, value) { this._attrs[name] = value; }
    removeAttribute(name) { delete this._attrs[name]; }
}

test('_smUpdateTierRails rebuilds only the rails whose tier data changed', () => {
    const mod = freshPlugin();
    const sections = [{ name: 'Intro', time: 0 }, { name: 'Verse 1', time: 50 }];
    const block0 = new FakeRailBlock(new FakeRail('old'));
    const block1 = new FakeRailBlock(new FakeRail('old'));
    const bar = new FakeBar();
    mod._setState({
        bar,
        sections,
        duration: 100,
        blockEls: [block0, block1],
        ddAvailable: true,
        tierSignatures: ['3|3|1|0', '3|3|1|0'],
        sectionTiers: {
            0: { index: 0, max_tier: 3, top_tier: 3, current_tier: 1, has_chart_content: true },
            1: { index: 1, max_tier: 3, top_tier: 3, current_tier: 1, has_chart_content: true },
        },
    });

    mod._smUpdateTierRails();
    assert.equal(block0._rail.writes, 0, 'unchanged section is not repainted');
    assert.equal(block1._rail.writes, 0);

    // Only section 0's tier advances.
    mod._setState({ sectionTiers: {
        0: { index: 0, max_tier: 3, top_tier: 3, current_tier: 2, has_chart_content: true },
        1: { index: 1, max_tier: 3, top_tier: 3, current_tier: 1, has_chart_content: true },
    } });
    mod._smUpdateTierRails();
    assert.equal(block0._rail.writes, 1, 'changed section repaints in place');
    assert.equal(block1._rail.writes, 0, 'unrelated section is left alone');
    assert.ok(block0._rail.innerHTML.includes('sm-rail-seg'));
    assert.equal(block0._attrs['aria-label'], 'Intro · tier 2 of 3 · full detail at 3');
});

test('_smUpdateTierRails creates a rail when tier data appears and removes it when it goes away', () => {
    const mod = freshPlugin();
    const sections = [{ name: 'Intro', time: 0 }];
    const block = new FakeRailBlock(null);
    mod._setState({
        bar: new FakeBar(),
        sections,
        duration: 10,
        blockEls: [block],
        ddAvailable: true,
        sectionTiers: {},
    });

    mod._smUpdateTierRails();
    assert.equal(block.inserted.length, 0, 'no rail while there is no data');
    assert.equal(block._attrs.tabindex, undefined, 'no focus stop without tier data');

    mod._setState({ sectionTiers: { 0: { index: 0, max_tier: 2, top_tier: 2, current_tier: 1, has_chart_content: true } } });
    mod._smUpdateTierRails();
    assert.equal(block.inserted.length, 1, 'rail inserted when data arrives');
    assert.ok(block.inserted[0].includes('class="sm-rail"'));
    assert.equal(block._attrs.tabindex, '0', 'block becomes a focus stop when data arrives');
    assert.equal(block._attrs['aria-label'], 'Intro · tier 1 of 2 · full detail at 2');

    mod._setState({ sectionTiers: {}, tierSignatures: ['2|2|1|0'] });
    mod._smUpdateTierRails();
    assert.equal(block._rail.removed, true, 'stale rail removed when data disappears');
    assert.equal(block._attrs.tabindex, undefined, 'phantom focus stop must not linger');
    assert.equal(block._attrs['aria-label'], undefined);
});

test('_smHandleResize re-decides the width-dependent rail form', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    const block = new FakeRailBlock(new FakeRail('stale'));
    mod._setState({
        bar,
        sections: [{ name: 'Intro', time: 0 }],
        duration: 100,
        blockEls: [block],
        sectionTiers: { 0: { index: 0, max_tier: 3, top_tier: 3, current_tier: 1, has_chart_content: true } },
        ddAvailable: true,
        tierSignatures: ['3|3|1|0'],
    });

    bar.width = 10; // 100% of 10px -> a 4-segment rail cannot fit
    mod._smHandleResize();
    assert.ok(block._rail.innerHTML.includes('sm-rail-marker'), 'collapses on a narrow bar');

    bar.width = 500; // now it fits
    mod._smHandleResize();
    assert.ok(!block._rail.innerHTML.includes('sm-rail-marker'), 'expands back to segments');
    assert.ok(block._rail.innerHTML.includes('sm-rail-seg'));
});

// Difficulty Ladder peer contract (issue #14): absent, late-loaded, v3 and
// legacy-v2 providers, plus malformed payloads. The rail is the only feature
// that depends on the peer, so every one of these has to leave base section
// navigation working.

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

// A difficulty_ladder.sections.v3 section entry, as difficulty_ladder emits it.
function v3Section(index, overrides) {
    return Object.assign({
        id: 'section:' + index,
        index,
        start_time: index * 10,
        end_time: index * 10 + 10,
        is_current: false,
        current_tier: 1,
        top_tier: 3,
        max_tier: 3,
        avg_top_tier: 3,
        has_chart_content: true,
        phrases: [],
    }, overrides || {});
}

function v3Payload(sections, overrides) {
    return Object.assign({
        schema: 'difficulty_ladder.sections.v3',
        player_context: null,
        mastery: 0.5,
        max_tier: 4,
        current_phrase_index: 0,
        sections,
    }, overrides || {});
}

// A legacy difficulty_ladder.sections.v2 payload: an object map keyed by
// section index, one entry per section with an overlapping phrase.
function v2Payload(entries) {
    return {
        schema: 'difficulty_ladder.sections.v2',
        sectionDifficulties: entries,
        mastery: 0.5,
        maxDifficulty: 4,
    };
}

test('peer contract: no provider means no subscription and no rails', () => {
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    assert.equal(mod._smIsDynamicDifficultyAvailable(), false);

    mod._smEnsureDifficultySubscription();
    mod._smEnsureDifficultySubscription();

    assert.equal(mod._getState().ddAvailable, false);
    assert.deepEqual(bus.calls, [], 'must not subscribe without the capability marker');
    mod._setState({ sectionTiers: { 0: { max_tier: 3, top_tier: 3, current_tier: 1, has_chart_content: true } } });
    assert.equal(mod._smGetSectionTier(0), null, 'cached data stays unreachable while the peer is absent');
});

test('peer contract: a bare _ddCapabilities global is not a provider', () => {
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    // Some other plugin using the same global name, or a ladder build from
    // before the sectionDifficulty contract existed. Either way, no marker.
    global.window._ddCapabilities = { somethingElse: true };
    try {
        assert.equal(mod._smIsDynamicDifficultyAvailable(), false);
        mod._smEnsureDifficultySubscription();
        assert.deepEqual(bus.calls, []);
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: a v3-capable provider subscribes to the render-neutral event', () => {
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    global.window._ddCapabilities = {
        sectionDifficulty: true,
        sectionsSchema: 'difficulty_ladder.sections.v3',
    };
    try {
        assert.equal(mod._smPeerSpeaksV3(), true);
        mod._smEnsureDifficultySubscription();
        assert.equal(bus.count('difficulty:sections-updated-v3'), 1);
        assert.equal(bus.count('difficulty:sections-updated'), 0, 'v2 is not also subscribed');
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: a v3 payload populates tier state per section', () => {
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    global.window._ddCapabilities = {
        sectionDifficulty: true,
        sectionsSchema: 'difficulty_ladder.sections.v3',
    };
    try {
        mod._smEnsureDifficultySubscription();
        assert.equal(mod._getState().ddAvailable, true);

        bus.fire('difficulty:sections-updated-v3', { detail: v3Payload([
            v3Section(0, { current_tier: 2, top_tier: 3, max_tier: 3 }),
            v3Section(1, { current_tier: 3, top_tier: 3, max_tier: 3 }),
        ]) });

        assert.equal(mod._smGetSectionTier(0).current_tier, 2);
        assert.equal(mod._smGetSectionTier(1).current_tier, 3);
        // A section the peer reported nothing for is "no rail", not a zero tier.
        assert.equal(mod._smGetSectionTier(2), null);
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: a v3 payload updates rails in place without a full re-render', () => {
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    global.window._ddCapabilities = {
        sectionDifficulty: true,
        sectionsSchema: 'difficulty_ladder.sections.v3',
    };
    try {
        mod._smEnsureDifficultySubscription();
        const block = new FakeRailBlock(new FakeRail('old'));
        mod._setState({
            bar: new FakeBar(),
            sections: [{ name: 'Intro', time: 0 }],
            duration: 10,
            blockEls: [block],
            sectionTiers: {},
        });

        bus.fire('difficulty:sections-updated-v3', { detail: v3Payload([
            v3Section(0, { current_tier: 2 }),
        ]) });

        assert.equal(block.inserted.length, 0, 'existing rail updated in place');
        assert.ok(block._rail.innerHTML.includes('#e8c040'));
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: a late-loading provider is picked up by the next _smUpdate tick', () => {
    // The handshake re-runs every tick, so a peer that loads (or reloads) after
    // this plugin does is still picked up mid-session.
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
        assert.equal(bus.count('difficulty:sections-updated-v3'), 0);

        global.window._ddCapabilities = {
            sectionDifficulty: true,
            sectionsSchema: 'difficulty_ladder.sections.v3',
        };
        mod._smUpdate();
        assert.equal(bus.count('difficulty:sections-updated-v3'), 1, 'subscribed on the next tick');

        mod._smUpdate();
        mod._smUpdate();
        assert.equal(bus.count('difficulty:sections-updated-v3'), 1, 'subscribed exactly once');
    } finally {
        delete global.window._ddCapabilities;
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});

test('peer contract: a legacy v2-only provider is still supported during the transition', () => {
    // No sectionsSchema -> the peer predates v3. Keep consuming its frozen v2
    // event and reconstruct a coarse rail from fillPercentage, ignoring
    // glassSize entirely.
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    global.window._ddCapabilities = { sectionDifficulty: true };
    try {
        mod._smEnsureDifficultySubscription();
        assert.equal(bus.count('difficulty:sections-updated'), 1);
        assert.equal(bus.count('difficulty:sections-updated-v3'), 0);

        bus.fire('difficulty:sections-updated', { detail: v2Payload({
            0: { fillPercentage: 50, glassSize: 'large', avgDifficulty: 2, maxDifficulty: 4 },
        }) });

        const entry = mod._smGetSectionTier(0);
        assert.equal(entry.max_tier, 4);
        assert.equal(entry.top_tier, 4);
        assert.equal(entry.current_tier, 2, 'fill 50% of a 4-tier ladder lights 2');
        assert.equal(entry.has_chart_content, true);
        assert.equal('glassSize' in entry, false, 'glassSize is discarded, not carried through');
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: an event with no detail leaves the last good state alone', () => {
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    global.window._ddCapabilities = {
        sectionDifficulty: true,
        sectionsSchema: 'difficulty_ladder.sections.v3',
    };
    try {
        mod._smEnsureDifficultySubscription();
        bus.fire('difficulty:sections-updated-v3', { detail: v3Payload([v3Section(0, { current_tier: 1 })]) });

        bus.fire('difficulty:sections-updated-v3', undefined);
        bus.fire('difficulty:sections-updated-v3', { detail: {} });
        bus.fire('difficulty:sections-updated-v3', { detail: { sections: 'nope' } });

        assert.equal(mod._smGetSectionTier(0).current_tier, 1, 'malformed payloads must not clear good data');
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: an unreadable v3 entry paints no rail', () => {
    // The peer derives tiers arithmetically, so current_tier can be null and
    // max/top tiers can go NaN. An entry we can't read is dropped; a payload
    // whose sections array is unusable is ignored, keeping the last good state.
    const mod = freshPlugin();
    const bus = fakeEventBus();
    global.window.feedBack = bus;
    global.window._ddCapabilities = {
        sectionDifficulty: true,
        sectionsSchema: 'difficulty_ladder.sections.v3',
    };
    try {
        mod._smEnsureDifficultySubscription();
        mod._setState({ sectionTiers: { 0: { max_tier: 3, top_tier: 3, current_tier: 1, has_chart_content: true } } });

        bus.fire('difficulty:sections-updated-v3', { detail: v3Payload([
            v3Section(1, { max_tier: NaN }),        // peer arithmetic went NaN
            v3Section(2, { top_tier: '3' }),        // string, not a number
            { index: 3 },                            // no tier fields at all
            null,                                    // not even an object
        ]) });

        const state = mod._getState();
        assert.deepEqual(Object.keys(state.sectionTiers), []);
        assert.equal(mod._smGetSectionTier(1), null, 'unreadable entries render no rail');
    } finally {
        delete global.window._ddCapabilities;
    }
});

test('peer contract: hiding the player detaches the difficulty subscription and re-show re-attaches one', () => {
    // _smDifficultySubscribed is written from two places (the mount path and the
    // per-tick retry) and reset on hide; a double-subscribe here would double
    // every rail repaint for the rest of the session.
    const mod = freshPlugin();
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalHighway = global.highway;
    const bus = fakeEventBus();

    global.window.feedBack = bus;
    global.window._ddCapabilities = {
        sectionDifficulty: true,
        sectionsSchema: 'difficulty_ladder.sections.v3',
    };
    global.highway = {
        getSections: () => [],
        getSongInfo: () => ({ duration: 0 }),
        getTime: () => 0,
    };
    global.setInterval = () => 1;
    global.clearInterval = () => {};

    try {
        mod._smSetPlayerVisible(true);
        assert.equal(bus.count('difficulty:sections-updated-v3'), 1);

        mod._smSetPlayerVisible(false);
        assert.equal(bus.count('difficulty:sections-updated-v3'), 0, 'hide must detach');

        mod._smSetPlayerVisible(true);
        assert.equal(bus.count('difficulty:sections-updated-v3'), 1, 're-show re-subscribes exactly once');

        // And a tick must not add a second handler on top.
        mod._smUpdate();
        mod._smUpdate();
        assert.equal(bus.count('difficulty:sections-updated-v3'), 1);
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
    global.window._ddCapabilities = {
        sectionDifficulty: true,
        sectionsSchema: 'difficulty_ladder.sections.v3',
    };
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
    global.window._ddCapabilities = {
        sectionDifficulty: true,
        sectionsSchema: 'difficulty_ladder.sections.v3',
    };
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
        assert.equal(bus.count('difficulty:sections-updated-v3'), 1);
    } finally {
        delete global.window._ddCapabilities;
        if (typeof originalHighway === 'undefined') delete global.highway;
        else global.highway = originalHighway;
    }
});

test('_smSetPlayerVisible retries the song:ready subscription after feedBack becomes available', () => {
    // The host bus may not exist when the player first mounts; _smSongReadySubscribed
    // stays false so the next _smSetPlayerVisible(true) retries it.
    const mod = freshPlugin();
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const originalHighway = global.highway;
    const originalFeedBack = global.window.feedBack;
    global.setInterval = () => 1;
    global.clearInterval = () => {};
    global.highway = {
        getSections: () => [],
        getSongInfo: () => ({ duration: 0 }),
        getTime: () => 0,
    };
    try {
        delete global.window.feedBack;
        mod._smSetPlayerVisible(true);
        assert.equal(mod._getState().songReadySubscribed, false);

        const bus = fakeEventBus();
        global.window.feedBack = bus;
        mod._smSetPlayerVisible(true);
        assert.equal(bus.count('song:ready'), 1);
        assert.equal(mod._getState().songReadySubscribed, true);
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

test('_smNormalizeSectionTiers separates an unusable payload from an empty one', () => {
    const mod = freshPlugin();
    // null: not an object, or no usable sections array -> "ignore the event".
    assert.equal(mod._smNormalizeSectionTiers(undefined), null);
    assert.equal(mod._smNormalizeSectionTiers(null), null);
    assert.equal(mod._smNormalizeSectionTiers(7), null);
    assert.equal(mod._smNormalizeSectionTiers({ sections: 'nope' }), null);
    // {}: a well-formed payload with nothing renderable -> "clear the rails".
    assert.deepEqual(mod._smNormalizeSectionTiers({ sections: [] }), {});
    assert.deepEqual(mod._smNormalizeSectionTiers(v3Payload([{ index: 0 }])), {});
    // A null current_tier is real data (unknown, not zero) and survives.
    const unknown = mod._smNormalizeSectionTiers(v3Payload([v3Section(0, { current_tier: null })]));
    assert.equal(unknown[0].current_tier, null);
    // Surrounding keys are not the contract: the producer keys by section index.
    assert.deepEqual(
        Object.keys(mod._smNormalizeSectionTiers(v3Payload([v3Section(0)], { schema: 'x' }))),
        ['0'],
    );
});

test('_smNormalizeSectionTiersV2 separates an unusable payload from an empty one', () => {
    const mod = freshPlugin();
    assert.equal(mod._smNormalizeSectionTiersV2(undefined), null);
    assert.equal(mod._smNormalizeSectionTiersV2(null), null);
    assert.equal(mod._smNormalizeSectionTiersV2(7), null);
    assert.deepEqual(mod._smNormalizeSectionTiersV2({}), {});
    assert.deepEqual(mod._smNormalizeSectionTiersV2({ 0: 'nope' }), {});
    // A 0% fill with no ladder and no content is a silent section: no rail.
    assert.equal(mod._smNormalizeSectionTiersV2({ 0: { fillPercentage: 0, maxDifficulty: 0 } })[0].has_chart_content, false);
    // A 100% fill with no ladder is the easy-but-playable case: a full rail.
    const easy = mod._smNormalizeSectionTiersV2({ 0: { fillPercentage: 100, maxDifficulty: 0 } })[0];
    assert.equal(easy.has_chart_content, true);
    assert.equal(easy.current_tier, 0);
});
