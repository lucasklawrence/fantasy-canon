import { describe, expect, it } from 'vitest';
import {
  domToPicks,
  parseOnTheClock,
  parseOverall,
  PlaywrightEspnDraftSource,
  type DraftRoomReader,
  type RawDraftDom,
} from '../playwrightSource.js';

/** A reader that yields a queued sequence of DOM reads (last one repeats once exhausted). */
function fakeReader(sequence: RawDraftDom[]): DraftRoomReader {
  let i = 0;
  return {
    read(): Promise<RawDraftDom> {
      const dom = sequence[Math.min(i, sequence.length - 1)];
      i += 1;
      return Promise.resolve(dom);
    },
  };
}

describe('parseOverall', () => {
  it('reads a plain overall number', () => {
    expect(parseOverall('12')).toBe(12);
    expect(parseOverall('Pick 7')).toBe(7);
    expect(parseOverall('#3')).toBe(3);
  });

  it('derives overall from round + pick-in-round when league size is known', () => {
    expect(parseOverall('R2, P3', 12)).toBe(15); // (2-1)*12 + 3
    expect(parseOverall('Round 1 Pick 1', 12)).toBe(1);
    expect(parseOverall('2.12', 12)).toBe(24); // (2-1)*12 + 12
    expect(parseOverall('1.01', 12)).toBe(1);
  });

  it('returns undefined for empty/garbage', () => {
    expect(parseOverall('')).toBeUndefined();
    expect(parseOverall('   ')).toBeUndefined();
    expect(parseOverall('no digits here')).toBeUndefined();
  });
});

describe('parseOnTheClock', () => {
  it('pulls the pick number out of the banner text', () => {
    expect(parseOnTheClock('On the Clock: Pick 37')).toBe(37);
    expect(parseOnTheClock('Pick 1')).toBe(1);
  });

  it('is undefined without a number', () => {
    expect(parseOnTheClock(undefined)).toBeUndefined();
    expect(parseOnTheClock('On the Clock')).toBeUndefined();
  });
});

describe('domToPicks', () => {
  it('reads picks, strips an injury badge, sorts and de-dupes', () => {
    const dom: RawDraftDom = {
      rows: [
        { overall: 2, pickText: '2', playerText: 'Cam SkatteboQNYGRB' }, // Q badge + team + pos
        { overall: 1, pickText: '1', playerText: 'Bijan Robinson' }, // clean name from the link
        { overall: 2, pickText: '2', playerText: 'Cam Skattebo' }, // dupe overall, first wins
      ],
    };
    expect(domToPicks(dom)).toEqual([
      { overall: 1, teamId: 0, playerName: 'Bijan Robinson' },
      { overall: 2, teamId: 0, playerName: 'Cam Skattebo' },
    ]);
  });

  it('falls back to parsing pickText when the page could not read a numeric overall', () => {
    const dom: RawDraftDom = {
      rows: [{ overall: null, pickText: 'R2, P1', playerText: 'Jahmyr Gibbs' }],
    };
    expect(domToPicks(dom, 12)).toEqual([{ overall: 13, teamId: 0, playerName: 'Jahmyr Gibbs' }]);
  });

  it('drops rows with no usable overall or empty name', () => {
    const dom: RawDraftDom = {
      rows: [
        { overall: null, pickText: '', playerText: 'Nobody' },
        { overall: 5, pickText: '5', playerText: '' },
      ],
    };
    expect(domToPicks(dom)).toEqual([]);
  });
});

describe('PlaywrightEspnDraftSource', () => {
  it('accumulates picks across reads so a scrolled-away pick is never dropped', async () => {
    const source = new PlaywrightEspnDraftSource(
      fakeReader([
        { rows: [{ overall: 1, pickText: '1', playerText: 'Bijan Robinson' }] },
        // Second read: row 1 scrolled out of the virtualized table, row 2 appeared.
        {
          rows: [{ overall: 2, pickText: '2', playerText: 'Ja’Marr Chase' }],
          onTheClockText: 'On the Clock: Pick 3',
        },
      ]),
      12,
    );

    const first = await source.poll();
    expect(first.picks.map((p) => p.playerName)).toEqual(['Bijan Robinson']);

    const second = await source.poll();
    expect(second.picks.map((p) => p.playerName)).toEqual(['Bijan Robinson', 'Ja’Marr Chase']);
    expect(second.onTheClock).toBe(3);
  });

  it('latches complete once the page reports the draft finished', async () => {
    const source = new PlaywrightEspnDraftSource(
      fakeReader([
        { rows: [{ overall: 1, pickText: '1', playerText: 'Bijan Robinson' }] },
        { rows: [], complete: true },
      ]),
    );

    expect((await source.poll()).complete).toBeUndefined();
    expect((await source.poll()).complete).toBe(true);
  });
});
