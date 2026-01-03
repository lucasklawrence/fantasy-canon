import { REST, Routes } from "discord.js";
import { canonCommand } from "./src/commands/canon/index.js";
import { loadEnv } from "./src/config.js";

async function deploy(): Promise<void> {
  const env = loadEnv();
  const rest = new REST({ version: "10" }).setToken(env.discordToken);
  const commands = [canonCommand.toJSON()];

  console.log(`Registering ${commands.length} command(s) for application ${env.discordAppId}`);

  await rest.put(Routes.applicationCommands(env.discordAppId), {
    body: commands
  });

  console.log("Slash commands registered.");
}

deploy().catch((error) => {
  console.error("Failed to deploy slash commands", error);
  process.exit(1);
});
