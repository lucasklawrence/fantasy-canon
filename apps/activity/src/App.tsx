import React, { useMemo, useState } from "react";
import { createSession, fetchStatus, submitAttempt } from "./api.js";
import { ReactionAttemptPayload, ReactionGame } from "./components/ReactionGame.js";
import { LotteryRenderer } from "./renderer/LotteryRenderer.js";

type AttemptRow = ReactionAttemptPayload & {
  teamId: string;
  teamName?: string;
};

export default function App(): JSX.Element {
  const [teamId, setTeamId] = useState("alpha");
  const [teamName, setTeamName] = useState("Alpha");
  const [sessionId, setSessionId] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [seed, setSeed] = useState(`seed-${Date.now()}`);
  const [baseBalls, setBaseBalls] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [draws, setDraws] = useState<{ pick: number; ballId: string; teamId: string }[]>([]);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const rendererRef = React.useRef<LotteryRenderer | null>(null);

  const lastAttempt = attempts[0];

  const bestValid = useMemo(() => {
    return attempts
      .filter((a) => a.status === "valid" && typeof a.reactionMs === "number")
      .sort((a, b) => (a.reactionMs ?? Number.MAX_SAFE_INTEGER) - (b.reactionMs ?? Number.MAX_SAFE_INTEGER))[0];
  }, [attempts]);

  const handleAttempt = (attempt: ReactionAttemptPayload): void => {
    const record: AttemptRow = { ...attempt, teamId, teamName };
    setAttempts((prev) => [record, ...prev].slice(0, 6));

    if (apiBase && sessionId) {
      void (async () => {
        const resp = await submitAttempt(apiBase, {
          sessionId,
          teamId,
          status: attempt.status,
          reactionMs: attempt.reactionMs,
          attemptAt: attempt.attemptAt
        });
        setSubmitStatus(resp.ok ? `Submitted (${resp.status})` : `Failed (${resp.status}): ${resp.error ?? "unknown error"}`);
      })();
    } else {
      setSubmitStatus("Local only (no API base or session ID set)");
    }
  };

  const handleCreateSession = async (): Promise<void> => {
    if (!apiBase) {
      setStatus("Set API base URL first.");
      return;
    }
    try {
      const session = await createSession(apiBase, { seed, baseBallCount: baseBalls });
      setSessionId(session.sessionId);
      setSeed(session.seed);
      setStatus(`Session created: ${session.sessionId}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to create session");
    }
  };

  const handleRefreshStatus = async (): Promise<void> => {
    if (!apiBase || !sessionId) {
      setStatus("Set API base and session ID.");
      return;
    }
    try {
      const data = await fetchStatus(apiBase, sessionId);
      setStatus(`State: ${data.session.state}, Seed: ${data.session.seed}, Draws: ${data.draws.length}`);
      setDraws(data.draws);
      if (data.draws.length && rendererRef.current) {
        await rendererRef.current.drawBall(data.draws[data.draws.length - 1].ballId);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to fetch status");
    }
  };

  React.useEffect(() => {
    if (canvasRef.current) {
      rendererRef.current = new LotteryRenderer(canvasRef.current, { width: 640, height: 360 });
    }
    return () => rendererRef.current?.destroy();
  }, []);

  return (
    <div className="page">
      <header>
        <h1>Draft Order Reaction Game</h1>
        <p>One attempt per team. Wait for GO, then click or press space. Early clicks are ignored.</p>
      </header>

      <div className="card">
        <h3>Session & Team</h3>
        <div className="grid">
          <div className="field">
            <label htmlFor="team">Team ID</label>
            <input id="team" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="team-123" />
          </div>
          <div className="field">
            <label htmlFor="team-name">Team name</label>
            <input id="team-name" value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Team Name" />
          </div>
          <div className="field">
            <label htmlFor="session">Session ID</label>
            <input id="session" value={sessionId} onChange={(e) => setSessionId(e.target.value)} placeholder="session-uuid" />
          </div>
          <div className="field">
            <label htmlFor="api">API base URL</label>
            <input id="api" value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://example.com/api" />
          </div>
          <div className="field">
            <label htmlFor="seed">Seed</label>
            <input id="seed" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="seed-123" />
          </div>
          <div className="field">
            <label htmlFor="balls">Base balls per team</label>
            <input
              id="balls"
              type="number"
              min={1}
              max={10}
              value={baseBalls}
              onChange={(e) => setBaseBalls(parseInt(e.target.value, 10) || 1)}
            />
          </div>
        </div>
        <div className="button-row" style={{ marginTop: 10 }}>
          <button onClick={handleCreateSession} disabled={!apiBase}>
            Create session
          </button>
          <button className="secondary" onClick={handleRefreshStatus} disabled={!apiBase || !sessionId}>
            Refresh status
          </button>
        </div>
        <div className="pill" style={{ marginTop: 10 }}>
          {sessionId && apiBase
            ? `Ready to submit to ${apiBase}/draft-order/attempt (session ${sessionId})`
            : "Local-only mode: set API base + session ID to submit attempts."}
        </div>
        {status ? <div className="pill" style={{ marginTop: 8 }}>{status}</div> : null}
      </div>

      <div className="grid">
        <div className="card">
          <h3>Live Attempt</h3>
          <ReactionGame
            teamId={teamId}
            teamName={teamName}
            onAttempt={handleAttempt}
            disabled={!teamId}
            onEarlyClick={() => setSubmitStatus("Early click (no bonus)")}
          />
          {submitStatus ? <div className="pill" style={{ marginTop: 10 }}>{submitStatus}</div> : null}
        </div>

        <div className="card">
          <h3>Attempts</h3>
          {attempts.length === 0 ? (
            <p>No attempts yet. Start the mini-game to record a reaction time.</p>
          ) : (
            <div className="attempt-list">
              {attempts.map((attempt, idx) => (
                <div className="attempt-row" key={idx}>
                  <div>
                    <div>{attempt.teamName ?? attempt.teamId}</div>
                    <div className="meta">
                      {new Date(attempt.attemptAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </div>
                  </div>
                  <div className={`badge ${attempt.status}`}>
                    {attempt.status === "valid" && typeof attempt.reactionMs === "number" ? `${attempt.reactionMs} ms` : "EARLY"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3>Bonuses</h3>
          <div className="instruction">
            <div>
              Fastest valid: <strong>+2 balls</strong>
              <br />
              Second fastest: <strong>+1 ball</strong>
              <br />
              Early clicks: <strong>0</strong>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            {bestValid ? (
              <div className="pill warning">
                Current leader: {bestValid.teamName ?? bestValid.teamId} ({bestValid.reactionMs} ms)
              </div>
            ) : (
              <div className="pill">No valid attempts yet</div>
            )}
            {lastAttempt && lastAttempt.status === "early" ? (
              <div className="pill danger" style={{ marginTop: 10 }}>
                Last attempt was early — no bonus.
              </div>
            ) : null}
          </div>
        </div>

        <div className="card">
          <h3>Draw Animation (Preview)</h3>
          <canvas
            ref={canvasRef}
            width={640}
            height={360}
            style={{ width: "100%", borderRadius: 12, background: "rgba(255,255,255,0.04)" }}
          />
          <div className="button-row" style={{ marginTop: 10 }}>
            <button
              className="secondary"
              onClick={() => {
                rendererRef.current?.reset();
                if (draws.length) {
                  const balls = draws.map((d) => ({ ballId: d.ballId, teamId: d.teamId }));
                  rendererRef.current?.spawnBalls(balls);
                }
              }}
              disabled={!draws.length}
            >
              Reset balls
            </button>
            <button
              onClick={async () => {
                for (const draw of draws) {
                  await rendererRef.current?.drawBall(draw.ballId);
                }
              }}
              disabled={!draws.length}
            >
              Play draws
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
