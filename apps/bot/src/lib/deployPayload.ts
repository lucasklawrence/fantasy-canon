import {
  ApplicationCommandType,
  type APIApplicationCommand,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

/**
 * Builds the bulk-overwrite `PUT` body for `deploy-commands.ts`, carrying any registered
 * `PRIMARY_ENTRY_POINT` command (type 4) through unchanged.
 *
 * Enabling Discord Activities auto-creates an Entry Point command ("Launch", handler
 * `DISCORD_LAUNCH_ACTIVITY`) that is not defined anywhere in this codebase — a bulk `PUT` of only
 * the local commands silently deletes it and breaks the Activity's launch button (issue #167). So
 * the deploy script must fetch the registered set and re-include any Entry Point command verbatim,
 * `handler` and all. While no Activity is enabled the registered set has no type-4 command and the
 * returned body is identical to the local payload.
 */
export function mergeEntryPointCommands(
  localCommands: RESTPostAPIApplicationCommandsJSONBody[],
  registeredCommands: APIApplicationCommand[],
): (RESTPostAPIApplicationCommandsJSONBody | APIApplicationCommand)[] {
  // Discord command uniqueness is per (type, name) — a local command of another type may share the
  // Entry Point's name, so only a local type-4 command with the same name suppresses the carry.
  const carried = registeredCommands.filter(
    (registered) =>
      registered.type === ApplicationCommandType.PrimaryEntryPoint &&
      !localCommands.some(
        (local) =>
          local.type === ApplicationCommandType.PrimaryEntryPoint && local.name === registered.name,
      ),
  );
  return [...localCommands, ...carried];
}
