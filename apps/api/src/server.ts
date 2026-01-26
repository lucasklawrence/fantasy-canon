import Fastify from "fastify";
import cors from "@fastify/cors";

export function createServer() {
  const app = Fastify({ logger: true });
  void app.register(cors, { origin: true });
  return app;
}
