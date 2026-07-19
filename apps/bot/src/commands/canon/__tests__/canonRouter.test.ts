import { ApplicationCommandOptionType } from 'discord.js';
import type { ChatInputCommandInteraction, MessageComponentInteraction } from 'discord.js';
import {
  CANON_AUTOCOMPLETE_ROUTES,
  CANON_ROUTES,
  canonCommand,
  canonRouteKey,
  handleCanonComponent,
  handleCanonInteraction,
} from '../index.js';

/**
 * Every `group:sub` (or top-level `sub`) key Discord will actually send, derived from the
 * registered `SlashCommandBuilder` — the single source of truth the router must cover.
 */
function registeredRouteKeys(): string[] {
  const json = canonCommand.toJSON();
  const keys: string[] = [];
  for (const opt of json.options ?? []) {
    if (opt.type === ApplicationCommandOptionType.SubcommandGroup) {
      for (const sub of opt.options ?? []) {
        keys.push(`${opt.name}:${sub.name}`);
      }
    } else if (opt.type === ApplicationCommandOptionType.Subcommand) {
      keys.push(opt.name);
    }
  }
  return keys;
}

/** Minimal `ChatInputCommandInteraction` returning a chosen group/sub with a reply spy. */
function fakeChatInput(group: string | null, subcommand: string) {
  const replies: string[] = [];
  const interaction = {
    options: {
      getSubcommand: () => subcommand,
      getSubcommandGroup: () => group,
    },
    reply: (payload: { content?: string }) => {
      if (payload.content) replies.push(payload.content);
      return Promise.resolve({});
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, replies };
}

describe('canonRouteKey', () => {
  it('namespaces grouped subcommands and passes top-level ones through', () => {
    expect(canonRouteKey('draftorder', 'begin')).toBe('draftorder:begin');
    expect(canonRouteKey(null, 'luck')).toBe('luck');
  });
});

describe('CANON_ROUTES', () => {
  it('covers exactly the registered subcommands — no missing routes, no orphans', () => {
    const registered = registeredRouteKeys().sort();
    const routed = Object.keys(CANON_ROUTES).sort();
    expect(routed).toEqual(registered);
  });

  it('maps every route to a function', () => {
    for (const [key, handler] of Object.entries(CANON_ROUTES)) {
      expect(typeof handler, key).toBe('function');
    }
  });

  it('registers a non-trivial surface (guards against an empty table)', () => {
    expect(Object.keys(CANON_ROUTES).length).toBeGreaterThan(30);
  });
});

describe('handleCanonInteraction', () => {
  it('dispatches to the mapped handler with (interaction, context)', async () => {
    const original = CANON_ROUTES.luck;
    const calls: unknown[][] = [];
    CANON_ROUTES.luck = (...args) => {
      calls.push(args);
      return Promise.resolve();
    };
    try {
      const { interaction } = fakeChatInput(null, 'luck');
      const context = { marker: 'ctx' } as never;
      await handleCanonInteraction(interaction, context);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(interaction);
      expect(calls[0][1]).toBe(context);
    } finally {
      CANON_ROUTES.luck = original;
    }
  });

  it('resolves grouped subcommands through the group-prefixed key', async () => {
    const original = CANON_ROUTES['draftorder:begin'];
    let called = false;
    CANON_ROUTES['draftorder:begin'] = () => {
      called = true;
      return Promise.resolve();
    };
    try {
      const { interaction } = fakeChatInput('draftorder', 'begin');
      await handleCanonInteraction(interaction, {} as never);
      expect(called).toBe(true);
    } finally {
      CANON_ROUTES['draftorder:begin'] = original;
    }
  });

  it('replies "not implemented" for an unregistered subcommand', async () => {
    const { interaction, replies } = fakeChatInput('admin', 'does-not-exist');
    await handleCanonInteraction(interaction, {} as never);
    expect(replies[0]).toContain('not implemented');
  });
});

describe('CANON_AUTOCOMPLETE_ROUTES', () => {
  it('only exposes routes that are real registered subcommands', () => {
    const registered = new Set(registeredRouteKeys());
    for (const key of Object.keys(CANON_AUTOCOMPLETE_ROUTES)) {
      expect(registered.has(key), key).toBe(true);
    }
  });
});

describe('handleCanonComponent', () => {
  const componentWith = (customId: string, kind: 'button' | 'select') => {
    const interaction = {
      customId,
      isButton: () => kind === 'button',
      isStringSelectMenu: () => kind === 'select',
    } as unknown as MessageComponentInteraction;
    return interaction;
  };

  it('ignores an unknown customId without throwing', async () => {
    await expect(
      handleCanonComponent(componentWith('canon:unknown:thing:42', 'button')),
    ).resolves.toBeUndefined();
  });

  it('no-ops when the component kind does not match the route guard', async () => {
    // grade-view is a select-menu route; a button carrying that prefix must not dispatch.
    await expect(
      handleCanonComponent(componentWith('canon:grade:view:42', 'button')),
    ).resolves.toBeUndefined();
  });
});
