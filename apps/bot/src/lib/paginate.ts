import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js';

/**
 * Reusable button pagination for long `/canon` list outputs (issue #60). Long results — multi-season
 * standings, transactions, managers, timelines — overrun Discord's 2000-char message cap, so this
 * pages over a `rows` array with Prev / page-indicator / Next buttons.
 *
 * The page-building is pure (see {@link buildPageContent}, {@link buildPaginationRow}) and unit
 * tested; {@link replyWithPagination} is the thin glue that renders the first page and wires a
 * message-component collector. Replies are ephemeral, so the buttons are private to whoever ran the
 * command — no cross-user access to guard. When the collector's window closes the buttons are
 * disabled in place, so an expired control degrades to a plain, static message rather than a dead
 * button that reports "interaction failed".
 */

/** Rows per page when a caller doesn't override it. Chosen to keep typical rows under the 2000 cap. */
export const PAGINATION_DEFAULT_PAGE_SIZE = 15;

/** Discord's hard per-message character cap; page content is clamped to it as a last resort. */
const DISCORD_CONTENT_LIMIT = 2000;

/**
 * How long the buttons stay live. Capped under the 15-minute interaction-token window so the
 * "disable on end" edit still runs against a valid token; `idle` resets on each click.
 */
const DEFAULT_TIME_MS = 14 * 60_000;
const DEFAULT_IDLE_MS = 5 * 60_000;

/** Number of pages needed to show `total` rows at `pageSize` per page (always ≥ 1). */
export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Clamp a (possibly out-of-range) page index into `[0, count - 1]`. */
export function clampPageIndex(index: number, count: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), Math.max(0, count - 1));
}

export interface PageContentOptions {
  /** A fixed line shown atop every page (e.g. "League L • Timeline"). Omitted when empty. */
  header?: string;
  /** The rows being paged over — one line each. */
  rows: string[];
  /** Zero-based page to render. Clamped into range. */
  pageIndex: number;
  /** Rows per page. */
  pageSize: number;
}

/**
 * Render one page to a message string: optional header, the page's slice of rows, and a
 * `Page i/n • N total` footer when there is more than one page. Clamped to Discord's 2000-char
 * cap as a backstop (a sensible `pageSize` should keep pages well under it).
 */
export function buildPageContent(opts: PageContentOptions): string {
  const { header, rows, pageSize } = opts;
  const count = pageCount(rows.length, pageSize);
  const pageIndex = clampPageIndex(opts.pageIndex, count);
  const start = pageIndex * pageSize;
  const slice = rows.slice(start, start + pageSize);

  const parts: string[] = [];
  if (header) parts.push(header);
  parts.push(...slice);
  if (count > 1) parts.push(`Page ${pageIndex + 1}/${count} • ${rows.length} total`);

  const content = parts.join('\n');
  return content.length > DISCORD_CONTENT_LIMIT
    ? `${content.slice(0, DISCORD_CONTENT_LIMIT - 1)}…`
    : content;
}

export interface PaginationRowOptions {
  /** Zero-based current page. */
  pageIndex: number;
  /** Total number of pages. */
  pageCount: number;
  /** Namespacing prefix for the button custom ids (unique per invocation). */
  idPrefix: string;
  /** Force all buttons disabled — used to freeze controls once the window closes. */
  disabled?: boolean;
}

/**
 * Build the Prev / page-indicator / Next button row. Prev is disabled on the first page, Next on the
 * last; the middle button is a non-interactive page indicator. Three buttons — well within the
 * ≤ 5-per-row cap.
 */
export function buildPaginationRow(opts: PaginationRowOptions): ActionRowBuilder<ButtonBuilder> {
  const { pageIndex, pageCount: count, idPrefix, disabled = false } = opts;
  const prev = new ButtonBuilder()
    .setCustomId(`${idPrefix}:prev`)
    .setLabel('◀ Prev')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || pageIndex <= 0);
  const indicator = new ButtonBuilder()
    .setCustomId(`${idPrefix}:page`)
    .setLabel(`Page ${pageIndex + 1}/${count}`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);
  const next = new ButtonBuilder()
    .setCustomId(`${idPrefix}:next`)
    .setLabel('Next ▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled || pageIndex >= count - 1);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(prev, indicator, next);
}

export interface PaginateOptions {
  /** A fixed header line shown atop every page. */
  header?: string;
  /** The rows to page over — one string per line. */
  rows: string[];
  /** Rows per page (default {@link PAGINATION_DEFAULT_PAGE_SIZE}). */
  pageSize?: number;
  /** Message shown when `rows` is empty (defaults to the header, or a generic note). */
  emptyContent?: string;
}

/**
 * Edit the (already-deferred) reply with the first page and, when there is more than one page, wire
 * a button collector that pages in place. Single-page results render with no buttons; an empty
 * `rows` renders `emptyContent`. The collector is feature-detected so this is safe to call with a
 * test double whose `editReply` doesn't return a real {@link Message}.
 */
export async function replyWithPagination(
  interaction: ChatInputCommandInteraction,
  opts: PaginateOptions,
): Promise<void> {
  const { header, rows } = opts;
  const pageSize = opts.pageSize ?? PAGINATION_DEFAULT_PAGE_SIZE;

  if (rows.length === 0) {
    await interaction.editReply({ content: opts.emptyContent ?? header ?? 'Nothing to show.' });
    return;
  }

  const count = pageCount(rows.length, pageSize);
  let pageIndex = 0;

  if (count === 1) {
    await interaction.editReply({
      content: buildPageContent({ header, rows, pageIndex, pageSize }),
    });
    return;
  }

  const idPrefix = `pg:${interaction.id}`;
  const message = await interaction.editReply({
    content: buildPageContent({ header, rows, pageIndex, pageSize }),
    components: [buildPaginationRow({ pageIndex, pageCount: count, idPrefix })],
  });

  // Feature-detect the collector: a live discord.js Message has it, but a test double may not.
  const collector = hasCollector(message)
    ? message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: DEFAULT_TIME_MS,
        idle: DEFAULT_IDLE_MS,
        filter: (i) => i.customId.startsWith(`${idPrefix}:`),
      })
    : undefined;
  if (!collector) return;

  collector.on('collect', (button: ButtonInteraction) => {
    void (async () => {
      if (button.customId === `${idPrefix}:next`) {
        pageIndex = clampPageIndex(pageIndex + 1, count);
      } else if (button.customId === `${idPrefix}:prev`) {
        pageIndex = clampPageIndex(pageIndex - 1, count);
      }
      await button.update({
        content: buildPageContent({ header, rows, pageIndex, pageSize }),
        components: [buildPaginationRow({ pageIndex, pageCount: count, idPrefix })],
      });
    })().catch((error) => {
      console.error('Failed to update paginated message', error);
    });
  });

  collector.on('end', () => {
    // Degrade gracefully once the window closes: freeze the buttons in place.
    void interaction
      .editReply({
        content: buildPageContent({ header, rows, pageIndex, pageSize }),
        components: [buildPaginationRow({ pageIndex, pageCount: count, idPrefix, disabled: true })],
      })
      .catch(() => undefined);
  });
}

/** Narrow an `editReply` return value to a Message that can spawn a component collector. */
function hasCollector(message: unknown): message is Message & {
  createMessageComponentCollector: Message['createMessageComponentCollector'];
} {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { createMessageComponentCollector?: unknown })
      .createMessageComponentCollector === 'function'
  );
}
