import { createServer } from "./server.js";
import { registerDraftOrderRoutes } from "./routes/draftOrder.js";

const PORT = Number(process.env.PORT ?? 4000);

async function start(): Promise<void> {
  const app = createServer();
  await registerDraftOrderRoutes(app);
  await app.listen({ port: PORT, host: "0.0.0.0" });
}

start().catch((error) => {
  console.error("Failed to start API", error);
  process.exit(1);
});
