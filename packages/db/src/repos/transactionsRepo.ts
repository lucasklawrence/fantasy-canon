import { SeasonYear } from "@fantasy-canon/shared";

export interface TransactionRecord {
  season: SeasonYear;
  teamId: number;
  type: "add" | "drop" | "trade" | "waiver";
  detail?: Record<string, unknown>;
}

export class TransactionsRepo {
  private readonly transactions: TransactionRecord[] = [];

  saveTransactions(transactions: TransactionRecord[]): Promise<void> {
    this.transactions.push(...transactions);
    return Promise.resolve();
  }
}
