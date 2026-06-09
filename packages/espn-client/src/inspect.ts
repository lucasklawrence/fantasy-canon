export interface PayloadSummary {
  topLevelKeys: string[];
  byteSize: number;
}

export function summarizePayload(payload: unknown): PayloadSummary {
  const topLevelKeys =
    payload && typeof payload === "object"
      ? Object.keys(payload)
      : [];

  const json = safeStringify(payload);
  const byteSize = Buffer.byteLength(json, "utf8");

  return { topLevelKeys, byteSize };
}

function safeStringify(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? "";
  } catch {
    return "";
  }
}
