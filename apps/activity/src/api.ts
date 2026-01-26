export interface DraftOrderAttemptRequest {
  sessionId: string;
  teamId: string;
  status: "valid" | "early" | "invalid";
  reactionMs?: number;
  attemptAt: number;
}

export interface DraftOrderAttemptResponse {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

export interface DraftOrderSessionRequest {
  seed?: string;
  baseBallCount?: number;
  teams?: { teamId: string; displayName?: string }[];
}

export interface DraftOrderSessionResponse {
  sessionId: string;
  seed: string;
  baseBallCount: number;
}

export interface DraftOrderStatusResponse {
  session: {
    id: string;
    seed: string;
    state: string;
    baseBallCount: number;
  };
  draws: { pick: number; ballId: string; teamId: string }[];
  teams: { teamId: string; baseBalls: number; bonusBalls: number; totalBalls: number }[];
  awards: { teamId: string; rank: number; bonusBalls: number; reactionMs: number }[];
}

export async function createSession(baseUrl: string, payload: DraftOrderSessionRequest): Promise<DraftOrderSessionResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/draft-order/session`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    throw new Error(`Failed to create session (${res.status})`);
  }
  return res.json();
}

export async function fetchStatus(baseUrl: string, sessionId: string): Promise<DraftOrderStatusResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/draft-order/status/${sessionId}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch status (${res.status})`);
  }
  return res.json();
}

export async function submitAttempt(baseUrl: string, payload: DraftOrderAttemptRequest): Promise<DraftOrderAttemptResponse> {
  const url = `${baseUrl.replace(/\/$/, "")}/draft-order/attempt`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    const body = text ? safeParse(text) : undefined;
    return { ok: res.ok, status: res.status, body, error: res.ok ? undefined : text };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
