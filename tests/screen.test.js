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

// ── Glass-filling difficulty visualization (sectionmap#1) ──────────────────
// The section-difficulty data these tests feed in is exactly the shape
// window.highway.getPhrases() returns per feedBack core (and per
// feedback-plugin-dynamic-difficulty's own COMPLIANCE.md writeup of the
// same contract): [{ index, start_time, end_time, max_difficulty }].

test('_smSectionDifficulty returns null when no phrase overlaps the section window', () => {
    const mod = freshPlugin();
    const phrases = [{ start_time: 20, end_time: 30, max_difficulty: 3 }];
    assert.equal(mod._smSectionDifficulty(0, 10, phrases), null);
});

test('_smSectionDifficulty returns null with no phrase data at all', () => {
    const mod = freshPlugin();
    assert.equal(mod._smSectionDifficulty(0, 10, null), null);
    assert.equal(mod._smSectionDifficulty(0, 10, []), null);
});

test('_smSectionDifficulty takes the max max_difficulty across overlapping phrases', () => {
    const mod = freshPlugin();
    const phrases = [
        { start_time: 0, end_time: 5, max_difficulty: 1 },
        { start_time: 5, end_time: 10, max_difficulty: 3 },
        { start_time: 10, end_time: 15, max_difficulty: 2 }, // outside [0,10)
    ];
    assert.deepEqual(mod._smSectionDifficulty(0, 10, phrases), { max_difficulty: 3 });
});

test('_smComputeGlass yields null per section when the song has no phrase data', () => {
    const mod = freshPlugin();
    const sections = [{ name: 'Intro', time: 0 }, { name: 'Verse', time: 10 }];
    assert.deepEqual(mod._smComputeGlass(sections, 20, null, 0.5), [null, null]);
});

test('_smComputeGlass sizes a harder section larger and scales fill by current mastery', () => {
    const mod = freshPlugin();
    const sections = [{ name: 'Easy bit', time: 0 }, { name: 'Hard bit', time: 10 }];
    const phrases = [
        { start_time: 0, end_time: 10, max_difficulty: 1 },
        { start_time: 10, end_time: 20, max_difficulty: 3 },
    ];
    const glasses = mod._smComputeGlass(sections, 20, phrases, 1.0); // full mastery
    assert.ok(glasses[1].sizeFrac > glasses[0].sizeFrac, 'harder section gets a taller glass');
    assert.equal(glasses[0].fillFrac, 1, 'full mastery fills every glass completely');
    assert.equal(glasses[1].fillFrac, 1);
});

test('_smComputeGlass at zero mastery leaves every glass empty', () => {
    const mod = freshPlugin();
    const sections = [{ name: 'A', time: 0 }];
    const phrases = [{ start_time: 0, end_time: 10, max_difficulty: 3 }];
    const glasses = mod._smComputeGlass(sections, 10, phrases, 0);
    assert.equal(glasses[0].fillFrac, 0);
});

test('_smComputeGlass gives a zero-difficulty section a full glass (nothing to fill toward)', () => {
    const mod = freshPlugin();
    const sections = [{ name: 'A', time: 0 }];
    const phrases = [{ start_time: 0, end_time: 10, max_difficulty: 0 }];
    const glasses = mod._smComputeGlass(sections, 10, phrases, 0.1);
    assert.equal(glasses[0].fillFrac, 1);
});

test('_smComputeGlass marks a section null when it has no overlapping phrase, even if others do', () => {
    const mod = freshPlugin();
    const sections = [{ name: 'Has data', time: 0 }, { name: 'No data', time: 100 }];
    const phrases = [{ start_time: 0, end_time: 10, max_difficulty: 2 }];
    const glasses = mod._smComputeGlass(sections, 200, phrases, 0.5);
    assert.ok(glasses[0] !== null);
    assert.equal(glasses[1], null);
});

test('_smGlassHtml renders nothing for a null glass (missing/delayed data degrades silently)', () => {
    const mod = freshPlugin();
    assert.equal(mod._smGlassHtml(null), '');
});

test('_smGlassHtml renders a fill bar sized proportionally to fillFrac', () => {
    const mod = freshPlugin();
    const html = mod._smGlassHtml({ sizeFrac: 1, fillFrac: 0.5 });
    assert.ok(html.includes('sm-glass'));
    assert.ok(html.includes('height:7px')); // sizeFrac=1 -> glass h=14px; fillFrac=0.5 -> fill h=7px
});

test('_smReadPhraseState degrades to no phrases/zero mastery without a highway global', () => {
    const mod = freshPlugin();
    assert.deepEqual(mod._smReadPhraseState(), { phrases: null, mastery: 0 });
});

test('_smReadPhraseState reads phrases only when hasPhraseData() is true', () => {
    const mod = freshPlugin();
    global.highway = {
        hasPhraseData: () => false,
        getPhrases: () => { throw new Error('must not be called when hasPhraseData() is false'); },
        getMastery: () => 0.42,
    };
    try {
        assert.deepEqual(mod._smReadPhraseState(), { phrases: null, mastery: 0.42 });
    } finally {
        delete global.highway;
    }
});

test('_smUpdate refreshes each block\'s glass-slot markup from live phrase/mastery state', () => {
    const mod = freshPlugin();
    const bar = new FakeBar();
    const slotA = { innerHTML: '' };
    const slotB = { innerHTML: '' };
    bar.querySelectorAll = (sel) => (sel === '.sm-glass-slot' ? [slotA, slotB] : []);
    const sections = [{ name: 'A', time: 0 }, { name: 'B', time: 10 }];
    mod._setState({ bar, sections, duration: 20 });
    global.highway = {
        getSections: () => sections,
        getSongInfo: () => ({ duration: 20 }),
        getTime: () => 0,
        hasPhraseData: () => true,
        getPhrases: () => [
            { start_time: 0, end_time: 10, max_difficulty: 1 },
            { start_time: 10, end_time: 20, max_difficulty: 3 },
        ],
        getMastery: () => 1.0,
    };
    try {
        mod._smUpdate();
        assert.ok(slotA.innerHTML.includes('sm-glass'));
        assert.ok(slotB.innerHTML.includes('sm-glass'));
    } finally {
        delete global.highway;
    }
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
