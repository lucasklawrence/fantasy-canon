import { BotContext } from '../config.js';

interface TransactionsPayload {
  transactions?: unknown[];
  [key: string]: unknown;
}

/**
 * Fetch transactions across scoring periods using mTransactions2 with scoringPeriodId.
 * Falls back to cached snapshots if present with transactions[].
 */
export async function ensureTransactionsPayload(
  context: BotContext,
  leagueId: string,
  season: number,
): Promise<TransactionsPayload | undefined> {
  const existing = await context.snapshotsRepo.listBySeason(leagueId, season);
  const cached =
    existing.find((s) => s.view === 'mTransactions2' && hasTransactions(s.payload)) ??
    existing.find((s) => s.view === 'mTransactions' && hasTransactions(s.payload));
  if (cached) {
    const txs = (cached.payload as TransactionsPayload).transactions;
    return txs
      ? { transactions: normalizeTransactions(txs) }
      : (cached.payload as TransactionsPayload);
  }

  const aggregated: unknown[] = [];
  const seenIds = new Set<string>();

  for (let week = 1; week <= 18; week += 1) {
    try {
      const res = await context.espnClient.fetchLeague({
        leagueId,
        season,
        view: 'mTransactions2',
        scoringPeriodId: week,
        filter: buildTransactionFilter(),
      });
      const payload = res.payload as TransactionsPayload;
      if (Array.isArray(payload.transactions) && payload.transactions.length > 0) {
        for (const tx of payload.transactions) {
          addTransaction(aggregated, seenIds, tx);
        }
      }
    } catch {
      // ignore week failures
    }
  }

  if (aggregated.length > 0) {
    const payload: TransactionsPayload = { transactions: normalizeTransactions(aggregated) };
    await context.snapshotsRepo.save({
      leagueId,
      season,
      view: 'mTransactions2',
      fetchedAt: new Date(),
      payload,
    });
    return payload;
  }

  // Fallback single-call mTransactions2 without week
  try {
    const single = await context.espnClient.fetchLeague({
      leagueId,
      season,
      view: 'mTransactions2',
      filter: buildTransactionFilter(),
    });
    await context.snapshotsRepo.save({
      leagueId,
      season,
      view: 'mTransactions2',
      fetchedAt: new Date(),
      payload: single.payload,
    });
    if (hasTransactions(single.payload)) {
      const txs = (single.payload as { transactions?: unknown[] }).transactions ?? [];
      const unique: TransactionsPayload = { transactions: [] };
      for (const tx of txs) {
        addTransaction(unique.transactions as unknown[], seenIds, tx);
      }
      return { transactions: normalizeTransactions(unique.transactions as unknown[]) };
    }
  } catch {
    // Swallow and fall through when the fallback request fails.
  }

  return undefined;
}

function hasTransactions(payload: unknown): payload is TransactionsPayload {
  return Boolean(
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { transactions?: unknown }).transactions),
  );
}

function buildTransactionFilter(): unknown {
  return {
    transactions: {
      filterType: {
        value: ['FREEAGENT', 'WAIVER', 'WAIVER_ERROR'],
      },
    },
  };
}

function extractTransactionKey(tx: unknown): string | undefined {
  if (!tx || typeof tx !== 'object') return undefined;
  const id = (tx as { id?: unknown }).id;
  if (typeof id === 'number' || typeof id === 'string') {
    return String(id);
  }
  return undefined;
}

function addTransaction(target: unknown[], seen: Set<string>, tx: unknown): void {
  const key = extractTransactionKey(tx);
  if (key) {
    if (seen.has(key)) return;
    seen.add(key);
  }
  target.push(tx);
}

export function getTransactionTeamId(tx: unknown): number | undefined {
  if (!tx || typeof tx !== 'object') return undefined;

  const direct = (tx as { teamId?: unknown }).teamId;
  if (Number.isFinite(Number(direct))) {
    return Number(direct);
  }

  const actions = (tx as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return undefined;

  for (const action of actions) {
    if (!action) continue;
    if (typeof action === 'object') {
      const maybeTeamId = (action as { teamId?: unknown }).teamId;
      if (Number.isFinite(Number(maybeTeamId))) {
        return Number(maybeTeamId);
      }
      if (Array.isArray(action)) {
        for (const part of action) {
          if (part && typeof part === 'object') {
            const nestedId = (part as { teamId?: unknown }).teamId;
            if (Number.isFinite(Number(nestedId))) {
              return Number(nestedId);
            }
          }
        }
      }
    }
  }

  return undefined;
}

export function isWaiverSpend(tx: unknown): boolean {
  if (!tx || typeof tx !== 'object') return false;
  const bid = (tx as { bidAmount?: unknown }).bidAmount;
  const bidNum = typeof bid === 'number' ? bid : Number(bid);
  if (!Number.isFinite(bidNum) || bidNum <= 0) return false;

  const type = (tx as { type?: unknown }).type;
  const typeStr = typeof type === 'string' ? type.toUpperCase() : '';
  if (!['WAIVER', 'WAIVER_ERROR', 'WAIVER_ADJUSTMENT'].includes(typeStr)) return false;

  const status = (tx as { status?: unknown }).status;
  const statusStr = typeof status === 'string' ? status.toUpperCase() : '';
  if (statusStr && statusStr !== 'EXECUTED') return false;

  return true;
}

function normalizeTransactions(txs: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const tx of txs) {
    const key = extractTransactionKey(tx);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    result.push(tx);
  }
  return result;
}
