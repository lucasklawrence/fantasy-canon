import { getTransactionTeamId, isWaiverSpend, ensureTransactionsPayload } from '../transactions.js';
import { createMockContext } from './mockContext.js';

describe('getTransactionTeamId', () => {
  it('reads a direct teamId', () => {
    expect(getTransactionTeamId({ teamId: 7 })).toBe(7);
    expect(getTransactionTeamId({ teamId: '9' })).toBe(9);
  });

  it('finds a teamId nested in actions', () => {
    expect(getTransactionTeamId({ actions: [{ teamId: 4 }] })).toBe(4);
    expect(getTransactionTeamId({ actions: [null, { teamId: 12 }] })).toBe(12);
  });

  it('returns undefined when no teamId is present or input is not an object', () => {
    expect(getTransactionTeamId({ actions: [{ foo: 1 }] })).toBeUndefined();
    expect(getTransactionTeamId({})).toBeUndefined();
    expect(getTransactionTeamId(null)).toBeUndefined();
  });
});

describe('isWaiverSpend', () => {
  const base = { bidAmount: 5, type: 'WAIVER', status: 'EXECUTED' };

  it('is true for an executed waiver with a positive bid', () => {
    expect(isWaiverSpend(base)).toBe(true);
    expect(isWaiverSpend({ ...base, type: 'waiver_error' })).toBe(true); // case-insensitive
  });

  it('is false without a positive bid', () => {
    expect(isWaiverSpend({ ...base, bidAmount: 0 })).toBe(false);
    expect(isWaiverSpend({ ...base, bidAmount: undefined })).toBe(false);
  });

  it('is false for non-waiver types or non-executed status', () => {
    expect(isWaiverSpend({ ...base, type: 'TRADE' })).toBe(false);
    expect(isWaiverSpend({ ...base, status: 'CANCELED' })).toBe(false);
  });

  it('allows a missing status (treated as executed)', () => {
    expect(isWaiverSpend({ bidAmount: 3, type: 'WAIVER' })).toBe(true);
  });
});

describe('ensureTransactionsPayload', () => {
  it('returns the cached, normalized snapshot without fetching', async () => {
    const { context, fetchCalls } = createMockContext({
      snapshots: [
        {
          leagueId: 'L',
          season: 2024,
          view: 'mTransactions2',
          fetchedAt: new Date(0),
          payload: { transactions: [{ id: 1 }, { id: 1 }, { id: 2 }] },
        },
      ],
    });
    const result = await ensureTransactionsPayload(context, 'L', 2024);
    // De-duplicated by id.
    expect(result?.transactions).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchCalls).toHaveLength(0);
  });

  it('aggregates the weekly fetches, de-dupes, and persists when there is no cache', async () => {
    const { context, fetchCalls, saved } = createMockContext({
      fetchPayloads: { mTransactions2: { transactions: [{ id: 10 }, { id: 11 }] } },
    });
    const result = await ensureTransactionsPayload(context, 'L', 2024);
    // Same two ids come back for every probed week → deduped to two.
    expect(result?.transactions).toEqual([{ id: 10 }, { id: 11 }]);
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(saved).toHaveLength(1);
    expect(saved[0].view).toBe('mTransactions2');
  });

  it('returns undefined when nothing is cached and ESPN yields no transactions', async () => {
    const { context } = createMockContext({ fetchPayloads: { mTransactions2: {} } });
    expect(await ensureTransactionsPayload(context, 'L', 2024)).toBeUndefined();
  });
});
