import { describe, expect, it } from 'vitest';
import { normalizeDom } from '../playwrightReader.js';

// normalizeDom guards the untrusted `page.evaluate` return; the Playwright attach itself is a
// manual, live-draft step and isn't unit-tested here.
describe('normalizeDom', () => {
  it('coerces a well-formed page result', () => {
    expect(
      normalizeDom({
        rows: [{ overall: 1, pickText: '1', playerText: 'Bijan Robinson' }],
        onTheClockText: 'On the Clock: Pick 2',
        complete: false,
      }),
    ).toEqual({
      rows: [{ overall: 1, pickText: '1', playerText: 'Bijan Robinson' }],
      onTheClockText: 'On the Clock: Pick 2',
      complete: false,
    });
  });

  it('defends against garbage: non-array rows, wrong types, missing fields', () => {
    expect(normalizeDom(undefined)).toEqual({
      rows: [],
      onTheClockText: undefined,
      complete: false,
    });
    expect(normalizeDom({ rows: 'nope' })).toEqual({
      rows: [],
      onTheClockText: undefined,
      complete: false,
    });
    expect(
      normalizeDom({
        rows: [
          { overall: 'x', pickText: 3, playerText: null }, // all wrong types
          null,
          { overall: 4, playerText: 'Jahmyr Gibbs' }, // missing pickText
        ],
        complete: true,
      }),
    ).toEqual({
      rows: [
        { overall: null, pickText: '', playerText: '' },
        { overall: 4, pickText: '', playerText: 'Jahmyr Gibbs' },
      ],
      onTheClockText: undefined,
      complete: true,
    });
  });

  it('treats a non-finite overall as null', () => {
    const out = normalizeDom({ rows: [{ overall: Infinity, pickText: '1', playerText: 'X' }] });
    expect(out.rows[0].overall).toBeNull();
  });
});
