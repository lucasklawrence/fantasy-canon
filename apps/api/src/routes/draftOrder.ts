import { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildDraftOrderProjection, DraftOrderAttemptStatus } from "@fantasy-canon/db";
import { store } from "../store.js";

export async function registerDraftOrderRoutes(app: FastifyInstance): Promise<void> {
  app.post("/draft-order/session", async (req, reply) => {
    const body = req.body as Partial<{
      seed: string;
      baseBallCount: number;
      teams: { teamId: string; displayName?: string }[];
    }>;

    const seed = body.seed ?? `seed-${Date.now()}`;
    const baseBallCount = body.baseBallCount ?? 1;
    const session = await store.createSession({
      id: randomUUID(),
      seed,
      baseBallCount,
      createdBy: "activity"
    });

    if (Array.isArray(body.teams)) {
      for (const team of body.teams) {
        await store.addTeam({
          sessionId: session.id,
          teamId: team.teamId,
          displayName: team.displayName ?? team.teamId
        });
      }
    }

    await store.appendEvent({
      sessionId: session.id,
      type: "session_created",
      payload: { seed, baseBallCount, teams: body.teams?.length ?? 0 }
    });

    return reply.send({ sessionId: session.id, seed, baseBallCount });
  });

  app.post("/draft-order/teams", async (req, reply) => {
    const body = req.body as { sessionId: string; teams: { teamId: string; displayName?: string }[] };
    if (!body?.sessionId || !Array.isArray(body.teams)) {
      return reply.status(400).send({ error: "sessionId and teams are required" });
    }

    for (const team of body.teams) {
      await store.addTeam({
        sessionId: body.sessionId,
        teamId: team.teamId,
        displayName: team.displayName ?? team.teamId
      });
    }

    await store.appendEvent({
      sessionId: body.sessionId,
      type: "team_registered",
      payload: { teams: body.teams.map((t) => t.teamId) }
    });

    return reply.send({ ok: true });
  });

  app.post("/draft-order/open-game", async (req, reply) => {
    const body = req.body as { sessionId: string };
    if (!body?.sessionId) {
      return reply.status(400).send({ error: "sessionId is required" });
    }
    const session = await store.getSession(body.sessionId);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }
    if (session.state !== "CREATED") {
      return reply.status(400).send({ error: `Cannot open game from state ${session.state}` });
    }

    await store.updateSession(session.id, { state: "GAME_OPEN" });
    await store.appendEvent({ sessionId: session.id, type: "game_opened", payload: {} });
    return reply.send({ ok: true });
  });

  app.post("/draft-order/attempt", async (req, reply) => {
    const body = req.body as {
      sessionId: string;
      teamId: string;
      status: DraftOrderAttemptStatus;
      reactionMs?: number;
      attemptAt?: number;
    };
    if (!body?.sessionId || !body?.teamId || !body?.status) {
      return reply.status(400).send({ error: "sessionId, teamId, status are required" });
    }
    const session = await store.getSession(body.sessionId);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }
    if (session.state !== "GAME_OPEN") {
      return reply.status(400).send({ error: `Session not accepting attempts (state ${session.state})` });
    }

    await store.recordAttempt({
      sessionId: body.sessionId,
      teamId: body.teamId,
      status: body.status,
      reactionMs: body.reactionMs,
      attemptAt: body.attemptAt ? new Date(body.attemptAt) : new Date()
    });

    await store.appendEvent({
      sessionId: body.sessionId,
      type: "mini_game_attempted",
      payload: {
        teamId: body.teamId,
        status: body.status,
        reactionMs: body.reactionMs
      }
    });

    return reply.send({ ok: true });
  });

  app.post("/draft-order/start-lottery", async (req, reply) => {
    const body = req.body as { sessionId: string };
    if (!body?.sessionId) {
      return reply.status(400).send({ error: "sessionId is required" });
    }
    const session = await store.getSession(body.sessionId);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }
    if (session.state !== "GAME_OPEN") {
      return reply.status(400).send({ error: `Cannot start lottery from state ${session.state}` });
    }

    const teams = await store.listTeams(session.id);
    if (teams.length === 0) {
      return reply.status(400).send({ error: "No teams registered" });
    }

    await store.updateSession(session.id, { state: "LOTTERY_RUNNING" });
    await store.appendEvent({ sessionId: session.id, type: "lottery_started", payload: {} });

    const attempts = await store.listAttempts(session.id);
    const projection = buildDraftOrderProjection({ session: { ...session, state: "LOTTERY_RUNNING" }, teams, attempts });

    return reply.send({ draws: projection.draws, teams: projection.teams, awards: projection.awards });
  });

  app.post("/draft-order/finalize", async (req, reply) => {
    const body = req.body as { sessionId: string };
    if (!body?.sessionId) {
      return reply.status(400).send({ error: "sessionId is required" });
    }
    const session = await store.getSession(body.sessionId);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }
    await store.updateSession(session.id, { state: "FINALIZED", finalizedAt: new Date() });
    await store.appendEvent({ sessionId: session.id, type: "finalized", payload: {} });
    return reply.send({ ok: true });
  });

  app.post("/draft-order/cancel", async (req, reply) => {
    const body = req.body as { sessionId: string };
    if (!body?.sessionId) {
      return reply.status(400).send({ error: "sessionId is required" });
    }
    const session = await store.getSession(body.sessionId);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }
    await store.updateSession(session.id, { state: "CANCELLED", cancelledAt: new Date() });
    await store.appendEvent({ sessionId: session.id, type: "cancelled", payload: {} });
    return reply.send({ ok: true });
  });

  app.get("/draft-order/status/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = await store.getSession(sessionId);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }
    const teams = await store.listTeams(sessionId);
    const attempts = await store.listAttempts(sessionId);
    const projection = buildDraftOrderProjection({ session, teams, attempts });
    return reply.send(projection);
  });
}
