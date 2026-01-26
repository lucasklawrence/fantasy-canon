import React, { useEffect, useMemo, useRef, useState } from "react";

export type AttemptStatus = "valid" | "early" | "invalid";

export interface ReactionAttemptPayload {
  status: AttemptStatus;
  reactionMs?: number;
  attemptAt: number;
}

interface ReactionGameProps {
  teamId: string;
  teamName?: string;
  onAttempt?: (attempt: ReactionAttemptPayload) => void;
  disabled?: boolean;
  autoReset?: boolean;
  onEarlyClick?: () => void;
}

type Phase = "idle" | "countdown" | "go" | "complete";

const randomDelayMs = (): number => {
  const min = 1200;
  const max = 3200;
  return Math.floor(Math.random() * (max - min + 1) + min);
};

export function ReactionGame({
  teamId,
  teamName,
  onAttempt,
  disabled,
  autoReset,
  onEarlyClick
}: ReactionGameProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>("idle");
  const [signalAt, setSignalAt] = useState<number | null>(null);
  const [result, setResult] = useState<ReactionAttemptPayload | null>(null);
  const timerRef = useRef<number | null>(null);

  const callToAction = useMemo(() => {
    if (phase === "idle") return "Click start, then wait for GO.";
    if (phase === "countdown") return "Wait... don't click early.";
    if (phase === "go") return "GO! Click or press space.";
    return result?.status === "early" ? "Too soon. Reset to try again." : "Locked in.";
  }, [phase, result?.status]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const finish = (payload: ReactionAttemptPayload): void => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setResult(payload);
    setPhase("complete");
    onAttempt?.(payload);
    if (autoReset) {
      window.setTimeout(() => reset(), 1000);
    }
  };

  const start = (): void => {
    if (disabled) return;
    setResult(null);
    setPhase("countdown");
    const delay = randomDelayMs();
    timerRef.current = window.setTimeout(() => {
      setSignalAt(performance.now());
      setPhase("go");
    }, delay);
  };

  const reset = (): void => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setResult(null);
    setSignalAt(null);
    setPhase("idle");
  };

  const handlePress = (): void => {
    const now = performance.now();
    if (phase === "countdown") {
      finish({ status: "early", attemptAt: Date.now() });
      onEarlyClick?.();
    } else if (phase === "go" && signalAt) {
      const reactionMs = Math.max(0, Math.round(now - signalAt));
      finish({ status: "valid", reactionMs, attemptAt: Date.now() });
    }
  };

  const reading = useMemo(() => {
    if (phase === "go") return "—";
    if (result?.status === "valid" && typeof result.reactionMs === "number") {
      return `${result.reactionMs} ms`;
    }
    if (result?.status === "early") return "EARLY";
    return "Ready";
  }, [phase, result]);

  const statusPill = useMemo(() => {
    if (phase === "go") return { label: "GO", tone: "warning" as const };
    if (phase === "countdown") return { label: "Wait", tone: "neutral" as const };
    if (result?.status === "early") return { label: "Early click", tone: "danger" as const };
    if (result?.status === "valid") return { label: "Locked", tone: "success" as const };
    return { label: "Ready", tone: "neutral" as const };
  }, [phase, result]);

  return (
    <div className="card" role="group" aria-label="Reaction time mini-game">
      <div className="timer-face" onClick={handlePress} tabIndex={0} onKeyDown={(e) => (e.code === "Space" ? handlePress() : undefined)}>
        <div className="status">{statusPill.label}</div>
        <div className="reading">{reading}</div>
        <div className="instruction">{callToAction}</div>
        {teamName ? <div className="pill">Team {teamName}</div> : null}
        {result?.status === "early" && <div className="pill danger">Early click — no bonus</div>}
        {result?.status === "valid" && typeof result.reactionMs === "number" && (
          <div className="pill warning">Submit to host for bonus balls</div>
        )}
      </div>
      <div className="button-row" style={{ marginTop: 14 }}>
        <button onClick={start} disabled={disabled || phase === "countdown" || phase === "go"}>
          {phase === "idle" || phase === "complete" ? "Start attempt" : "Waiting..."}
        </button>
        <button className="secondary" onClick={reset} disabled={phase === "idle" && !result}>
          Reset
        </button>
      </div>
    </div>
  );
}
