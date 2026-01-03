import { EnvConfig } from "@fantasy-canon/shared";

export interface DbClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export class NoopDbClient implements DbClient {
  constructor(private readonly _config?: EnvConfig) {}

  async connect(): Promise<void> {
    // placeholder for real DB wiring
  }

  async disconnect(): Promise<void> {
    // placeholder
  }
}
