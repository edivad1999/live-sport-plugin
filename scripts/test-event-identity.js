const assert = require('assert');
const { canonicalEventId, isSameEvent } = require('../src/services/EventIdentityService');
const MatchEntity = require('../src/domain/MatchEntity');

const ID_RE = /^ls_[0-9a-f]{16}$/;

function run() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log('  PASS ' + name);
      passed++;
    } catch (err) {
      console.error('  FAIL ' + name + ' -> ' + err.message);
      failed++;
    }
  }

  const day = Date.UTC(2026, 8, 10, 15, 0, 0);
  const nextDay = Date.UTC(2026, 8, 11, 15, 0, 0);

  test('Inter vs Juventus and Inter - Juventus share an id on the same UTC day, independent of key order', () => {
    const a = new MatchEntity({ title: 'Inter vs Juventus', category: 'football', date: day });
    const b = { date: day, category: 'football', title: 'Inter - Juventus' };
    const idA = canonicalEventId(a);
    const idB = canonicalEventId(b);
    assert.strictEqual(idA, idB);
    assert.match(idA, ID_RE);
  });

  test('Inter Milan vs Juventus and AC Milan vs Juventus get different ids', () => {
    const inter = { title: 'Inter Milan vs Juventus', category: 'football', date: day };
    const milan = { title: 'AC Milan vs Juventus', category: 'football', date: day };
    assert.notStrictEqual(canonicalEventId(inter), canonicalEventId(milan));
  });

  test('Court 7 and Court 13 tennis get different ids', () => {
    const c7 = { title: 'Court 7', category: 'tennis', date: day };
    const c13 = { title: 'Court 13', category: 'tennis', date: day };
    assert.notStrictEqual(canonicalEventId(c7), canonicalEventId(c13));
  });

  test('same teams two UTC calendar days apart get different ids', () => {
    const d1 = { title: 'Inter vs Juventus', category: 'football', date: day };
    const d2 = { title: 'Inter vs Juventus', category: 'football', date: nextDay };
    assert.notStrictEqual(canonicalEventId(d1), canonicalEventId(d2));
  });

  test('id/sources/provider order do not change the id', () => {
    const a = {
      id: 'sf_1',
      title: 'Inter vs Juventus',
      category: 'football',
      date: day,
      sources: [{ source: 'streamfree', id: 'a' }, { source: 'watchfooty', id: 'b' }]
    };
    const b = {
      sources: [{ source: 'watchfooty', id: 'b' }, { source: 'streamfree', id: 'a' }],
      date: day,
      category: 'football',
      title: 'Inter vs Juventus',
      id: 'wf_9'
    };
    assert.strictEqual(canonicalEventId(a), canonicalEventId(b));
  });

  test('swapped home/away on the same day share an id', () => {
    const home = { title: 'Juventus vs Inter', category: 'football', date: day };
    const away = { title: 'Inter vs Juventus', category: 'football', date: day };
    assert.strictEqual(canonicalEventId(home), canonicalEventId(away));
  });

  test('Fenerbahçe vs Roma and Fenerbahce vs. AS Roma share an id on the same UTC day', () => {
    const live = { title: 'Fenerbahçe vs Roma', category: 'football', date: day };
    const listing = { title: 'Fenerbahce vs. AS Roma', category: 'football', date: day + (5 * 3600 * 1000) };
    assert.strictEqual(canonicalEventId(live), canonicalEventId(listing));
    assert.strictEqual(isSameEvent(live, listing), true);
  });

  test('id is opaque ls_ + 16 hex with no team names', () => {
    const id = canonicalEventId({ title: 'Inter vs Juventus', category: 'football', date: day });
    assert.match(id, ID_RE);
    assert.strictEqual(id.length, 19);
    const lower = id.toLowerCase();
    assert.ok(!lower.includes('inter'));
    assert.ok(!lower.includes('juventus'));
    assert.ok(!lower.includes('football'));
  });

  test('missing date fixture uses undated bucket and stays deterministic', () => {
    const missing = { title: 'Inter vs Juventus', category: 'football' };
    const empty = { title: 'Inter vs Juventus', category: 'football', date: '' };
    const zero = { title: 'Inter vs Juventus', category: 'football', date: 0 };
    const entity = new MatchEntity({ title: 'Inter vs Juventus', category: 'football' });
    const id = canonicalEventId(missing);
    assert.match(id, ID_RE);
    assert.strictEqual(id, canonicalEventId(empty));
    assert.strictEqual(id, canonicalEventId(zero));
    assert.strictEqual(id, canonicalEventId(entity));
    assert.notStrictEqual(id, canonicalEventId({ title: 'Inter vs Juventus', category: 'football', date: day }));
  });

  console.log(`event-identity: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
