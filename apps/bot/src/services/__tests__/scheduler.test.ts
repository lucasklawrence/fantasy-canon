import { msUntilNextWeekly } from '../scheduler.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TUE = 2;

describe('msUntilNextWeekly', () => {
  it('counts down to later the same target day', () => {
    // Tue 2024-01-02 15:00 UTC → Tue 16:00 UTC is 1 hour away.
    const now = new Date(Date.UTC(2024, 0, 2, 15, 0, 0));
    expect(msUntilNextWeekly(now, TUE, 16)).toBe(HOUR);
  });

  it('rolls to next week when the target time today has passed', () => {
    // Tue 17:00 → next Tue 16:00 is 7 days minus 1 hour.
    const now = new Date(Date.UTC(2024, 0, 2, 17, 0, 0));
    expect(msUntilNextWeekly(now, TUE, 16)).toBe(7 * DAY - HOUR);
  });

  it('finds the target later this week', () => {
    // Mon 2024-01-01 16:00 → Tue 16:00 is exactly 1 day.
    const now = new Date(Date.UTC(2024, 0, 1, 16, 0, 0));
    expect(msUntilNextWeekly(now, TUE, 16)).toBe(DAY);
  });

  it('wraps around when the target day already passed this week', () => {
    // Wed 2024-01-03 16:00 → next Tue 16:00 is 6 days.
    const now = new Date(Date.UTC(2024, 0, 3, 16, 0, 0));
    expect(msUntilNextWeekly(now, TUE, 16)).toBe(6 * DAY);
  });

  it('treats the exact target instant as a full week away (strictly future)', () => {
    const now = new Date(Date.UTC(2024, 0, 2, 16, 0, 0));
    expect(msUntilNextWeekly(now, TUE, 16)).toBe(7 * DAY);
  });

  it('honors the optional minute', () => {
    const now = new Date(Date.UTC(2024, 0, 2, 16, 0, 0));
    expect(msUntilNextWeekly(now, TUE, 16, 30)).toBe(30 * 60_000);
  });
});
