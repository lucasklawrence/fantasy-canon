import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';

/**
 * A fake `ChatInputCommandInteraction` for exercising command handlers end-to-end without
 * a live discord.js client. Implements only the surface the canon handlers touch — the
 * `getInteger`/`getString` option getters, `guildId`, and the `reply`/`deferReply`/
 * `editReply` lifecycle — and captures every content-bearing reply so tests can assert on
 * the message the user would see. Pairs with {@link createMockContext}.
 */

export interface MockInteractionOptions {
  /** Option name → value. Numbers resolve via `getInteger`, strings via `getString`. */
  options?: Record<string, string | number>;
  /** guildId the handler sees; `null` simulates a DM. Defaults to `'guild-1'`. */
  guildId?: string | null;
  /** Discord user id of the invoking member. Defaults to `'user-1'`. */
  userId?: string;
}

export interface CapturedReply {
  method: 'reply' | 'editReply' | 'followUp';
  /** The `content` string of the payload, if any. */
  content?: string;
  /** The full options object passed (e.g. to inspect `flags`). */
  payload: Record<string, unknown>;
}

export interface MockInteractionHandle {
  interaction: ChatInputCommandInteraction;
  /** Whether `deferReply` was called. */
  deferred: () => boolean;
  /** Every content-bearing reply (`reply`/`editReply`/`followUp`) in call order. */
  replies: CapturedReply[];
  /** Content of the last reply — the final message the user sees. */
  lastContent: () => string | undefined;
}

export function createMockInteraction(opts: MockInteractionOptions = {}): MockInteractionHandle {
  const values = opts.options ?? {};
  const guildId = opts.guildId === undefined ? 'guild-1' : opts.guildId;
  const replies: CapturedReply[] = [];
  let deferred = false;

  const getInteger = (name: string, required?: boolean): number | null => {
    const v = values[name];
    if (typeof v === 'number') return v;
    if (required) throw new Error(`Missing required integer option "${name}"`);
    return null;
  };

  const getString = (name: string, required?: boolean): string | null => {
    const v = values[name];
    if (typeof v === 'string') return v;
    if (required) throw new Error(`Missing required string option "${name}"`);
    return null;
  };

  const capture = (method: CapturedReply['method'], payload: unknown): Promise<unknown> => {
    const p = (payload ?? {}) as Record<string, unknown>;
    const content = typeof p.content === 'string' ? p.content : undefined;
    replies.push({ method, content, payload: p });
    return Promise.resolve({});
  };

  const interaction = {
    guildId,
    // Always present on a real interaction — handlers read it to attribute an action to a member
    // (e.g. the lottery's in-Activity commissioner, #210).
    user: { id: opts.userId ?? 'user-1' },
    options: { getInteger, getString },
    reply: (payload: unknown) => capture('reply', payload),
    deferReply: (): Promise<unknown> => {
      deferred = true;
      return Promise.resolve({});
    },
    editReply: (payload: unknown) => capture('editReply', payload),
    followUp: (payload: unknown) => capture('followUp', payload),
  } as unknown as ChatInputCommandInteraction;

  return {
    interaction,
    deferred: () => deferred,
    replies,
    lastContent: () => {
      for (let i = replies.length - 1; i >= 0; i -= 1) {
        if (replies[i].content !== undefined) return replies[i].content;
      }
      return undefined;
    },
  };
}

/** A single autocomplete choice as captured from `interaction.respond`. */
export interface AutocompleteChoice {
  name: string;
  value: string | number;
}

export interface MockAutocompleteOptions {
  /** The currently-focused option (name + typed value), returned by `getFocused(true)`. */
  focused?: { name: string; value: string };
  /** Non-focused option values. Numbers resolve via `getInteger`, strings via `getString`. */
  options?: Record<string, string | number>;
  /** guildId the handler sees; `null` simulates a DM. Defaults to `'guild-1'`. */
  guildId?: string | null;
}

export interface MockAutocompleteHandle {
  interaction: AutocompleteInteraction;
  /** Every `respond(...)` call's choice array, in order. */
  responses: AutocompleteChoice[][];
  /** Choices from the last `respond` — what the user would see suggested. */
  lastChoices: () => AutocompleteChoice[] | undefined;
}

/**
 * A fake `AutocompleteInteraction` for exercising the scout opponent autocomplete without a
 * live discord.js client. Implements `getFocused`, the `getInteger`/`getString` getters,
 * `guildId`, and a `respond` that captures the suggested choices. Pairs with
 * {@link createMockContext}; the autocomplete reads team names from `context.teamNameCache`.
 */
export function createMockAutocomplete(opts: MockAutocompleteOptions = {}): MockAutocompleteHandle {
  const values = opts.options ?? {};
  const focused = opts.focused ?? { name: 'opponent', value: '' };
  const guildId = opts.guildId === undefined ? 'guild-1' : opts.guildId;
  const responses: AutocompleteChoice[][] = [];

  const getInteger = (name: string, required?: boolean): number | null => {
    const v = values[name];
    if (typeof v === 'number') return v;
    if (required) throw new Error(`Missing required integer option "${name}"`);
    return null;
  };

  const getString = (name: string, required?: boolean): string | null => {
    const v = values[name];
    if (typeof v === 'string') return v;
    if (required) throw new Error(`Missing required string option "${name}"`);
    return null;
  };

  const interaction = {
    guildId,
    options: {
      getFocused: (returnFull?: boolean) => (returnFull ? focused : focused.value),
      getInteger,
      getString,
    },
    respond: (choices: AutocompleteChoice[]): Promise<unknown> => {
      responses.push(choices);
      return Promise.resolve({});
    },
  } as unknown as AutocompleteInteraction;

  return {
    interaction,
    responses,
    lastChoices: () => (responses.length > 0 ? responses[responses.length - 1] : undefined),
  };
}
