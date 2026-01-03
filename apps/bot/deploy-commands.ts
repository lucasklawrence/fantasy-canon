import { REST, Routes } from "discord.js";
import { canonCommand } from "./src/commands/canon/index.js";
import { loadEnv } from "./src/config.js";

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception during deploy:", err);
});

console.log("Starting deploy-commands script...");

async function deploy(): Promise<void> {
  const env = loadEnv();
  console.log("Env loaded for app ID", env.discordAppId);
  const rest = new REST({ version: "10" }).setToken(env.discordToken);
  const commands = [canonCommand.toJSON()];

  console.log(`Registering ${commands.length} command(s) for application ${env.discordAppId}`);

  await rest.put(Routes.applicationCommands(env.discordAppId), {
    body: commands
  });

  console.log("Slash commands registered.");
}

deploy().catch((error) => {
  console.error("Failed to deploy slash commands");
  console.error(error);
  if (error && typeof error === "object") {
    try {
      console.error("Error details:", JSON.stringify(error, null, 2));
    } catch {
      // ignore stringify issues
    }
  }
  process.exit(1);
});
