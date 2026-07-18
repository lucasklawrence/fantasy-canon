import { describe, expect, it } from 'vitest';
import {
  ApplicationCommandType,
  EntryPointCommandHandlerType,
  type APIApplicationCommand,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';
import { mergeEntryPointCommands } from '../deployPayload.js';

const localCanon: RESTPostAPIApplicationCommandsJSONBody = {
  name: 'canon',
  description: 'Fantasy Canon commands',
  type: ApplicationCommandType.ChatInput,
};

/** The Entry Point command Discord auto-creates when Activities are enabled. */
const launchEntryPoint = {
  id: '1234567890',
  application_id: '9876543210',
  version: '1',
  default_member_permissions: null,
  name: 'Launch',
  description: '',
  type: ApplicationCommandType.PrimaryEntryPoint,
  handler: EntryPointCommandHandlerType.DiscordLaunchActivity,
} as APIApplicationCommand;

const registeredCanon = {
  id: '5555555555',
  application_id: '9876543210',
  version: '2',
  default_member_permissions: null,
  name: 'canon',
  description: 'Fantasy Canon commands',
  type: ApplicationCommandType.ChatInput,
} as APIApplicationCommand;

describe('mergeEntryPointCommands', () => {
  it('returns the local payload unchanged when nothing is registered (today: no Activity)', () => {
    const merged = mergeEntryPointCommands([localCanon], []);

    expect(merged).toEqual([localCanon]);
    expect(JSON.stringify(merged)).toBe(JSON.stringify([localCanon]));
  });

  it('does not carry registered non-Entry-Point commands (bulk overwrite still prunes them)', () => {
    const stale = { ...registeredCanon, name: 'old-command' };

    expect(mergeEntryPointCommands([localCanon], [registeredCanon, stale])).toEqual([localCanon]);
  });

  it('carries a registered Entry Point command through unchanged, including handler', () => {
    const merged = mergeEntryPointCommands([localCanon], [registeredCanon, launchEntryPoint]);

    expect(merged).toEqual([localCanon, launchEntryPoint]);
    expect(merged[1]).toBe(launchEntryPoint);
  });

  it('never duplicates an Entry Point command already present in the local payload', () => {
    const localLaunch = {
      name: 'Launch',
      description: '',
      type: ApplicationCommandType.PrimaryEntryPoint,
      handler: EntryPointCommandHandlerType.DiscordLaunchActivity,
    } as RESTPostAPIApplicationCommandsJSONBody;

    const merged = mergeEntryPointCommands([localCanon, localLaunch], [launchEntryPoint]);

    expect(merged).toEqual([localCanon, localLaunch]);
  });

  it('handles an empty local payload by carrying only the Entry Point command', () => {
    expect(mergeEntryPointCommands([], [registeredCanon, launchEntryPoint])).toEqual([
      launchEntryPoint,
    ]);
  });
});
