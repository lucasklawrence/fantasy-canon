import { describe, expect, it } from 'vitest';
import {
  buildPageContent,
  buildPaginationRow,
  clampPageIndex,
  pageCount,
  PAGINATION_DEFAULT_PAGE_SIZE,
  replyWithPagination,
} from '../paginate.js';
import { createMockInteraction } from './mockInteraction.js';

const rows = (n: number): string[] => Array.from({ length: n }, (_, i) => `row ${i + 1}`);

/** The button-component fields the tests read; the JSON union also has an SKU variant without them. */
type ButtonJSON = { custom_id?: string; label?: string; disabled?: boolean };
const buttons = (row: { components: unknown[] }): ButtonJSON[] => row.components as ButtonJSON[];

describe('pageCount', () => {
  it('rounds up and never returns fewer than one page', () => {
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(10, 10)).toBe(1);
    expect(pageCount(11, 10)).toBe(2);
    expect(pageCount(25, 10)).toBe(3);
  });

  it('treats a non-positive page size as a single page', () => {
    expect(pageCount(100, 0)).toBe(1);
    expect(pageCount(100, -5)).toBe(1);
  });
});

describe('clampPageIndex', () => {
  it('clamps into [0, count - 1]', () => {
    expect(clampPageIndex(-3, 4)).toBe(0);
    expect(clampPageIndex(2, 4)).toBe(2);
    expect(clampPageIndex(9, 4)).toBe(3);
    expect(clampPageIndex(Number.NaN, 4)).toBe(0);
  });
});

describe('buildPageContent', () => {
  it('shows the header, the page slice, and a footer when multi-page', () => {
    const content = buildPageContent({ header: 'H', rows: rows(25), pageIndex: 1, pageSize: 10 });
    const lines = content.split('\n');
    expect(lines[0]).toBe('H');
    expect(lines[1]).toBe('row 11'); // second page starts at row 11
    expect(lines).toContain('row 20');
    expect(lines).not.toContain('row 21');
    expect(lines[lines.length - 1]).toBe('Page 2/3 • 25 total');
  });

  it('omits the footer for a single page', () => {
    const content = buildPageContent({ header: 'H', rows: rows(3), pageIndex: 0, pageSize: 10 });
    expect(content).toBe('H\nrow 1\nrow 2\nrow 3');
    expect(content).not.toContain('Page');
  });

  it('clamps an out-of-range page index into the last page', () => {
    const content = buildPageContent({ rows: rows(12), pageIndex: 99, pageSize: 10 });
    expect(content).toContain('row 11');
    expect(content).toContain('Page 2/2 • 12 total');
  });

  it('clamps content to the 2000-char Discord limit', () => {
    const huge = ['x'.repeat(5000)];
    const content = buildPageContent({ rows: huge, pageIndex: 0, pageSize: 10 });
    expect(content.length).toBe(2000);
    expect(content.endsWith('…')).toBe(true);
  });
});

describe('buildPaginationRow', () => {
  it('disables Prev on the first page and enables Next', () => {
    const row = buildPaginationRow({ pageIndex: 0, pageCount: 3, idPrefix: 'pg:1' }).toJSON();
    expect(row.components).toHaveLength(3); // ≤ 5 per row
    const [prev, indicator, next] = buttons(row);
    expect(prev.custom_id).toBe('pg:1:prev');
    expect(prev.disabled).toBe(true);
    expect(indicator.custom_id).toBe('pg:1:page');
    expect(indicator.label).toBe('Page 1/3');
    expect(indicator.disabled).toBe(true); // indicator is never clickable
    expect(next.custom_id).toBe('pg:1:next');
    expect(next.disabled).toBe(false);
  });

  it('disables Next on the last page and enables Prev', () => {
    const row = buildPaginationRow({ pageIndex: 2, pageCount: 3, idPrefix: 'pg:1' }).toJSON();
    const [prev, , next] = buttons(row);
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);
  });

  it('force-disables every control when frozen', () => {
    const row = buildPaginationRow({
      pageIndex: 1,
      pageCount: 3,
      idPrefix: 'pg:1',
      disabled: true,
    }).toJSON();
    expect(buttons(row).every((c) => c.disabled === true)).toBe(true);
  });
});

describe('replyWithPagination', () => {
  it('renders a single page with no buttons', async () => {
    const { interaction, replies } = createMockInteraction();
    await interaction.deferReply();
    await replyWithPagination(interaction, { header: 'H', rows: rows(5), pageSize: 10 });

    const last = replies[replies.length - 1];
    expect(last.method).toBe('editReply');
    expect(last.content).toBe('H\nrow 1\nrow 2\nrow 3\nrow 4\nrow 5');
    expect(last.payload.components).toBeUndefined();
  });

  it('renders the first page with a button row when multi-page', async () => {
    const { interaction, replies } = createMockInteraction();
    await interaction.deferReply();
    await replyWithPagination(interaction, { header: 'H', rows: rows(25), pageSize: 10 });

    const last = replies[replies.length - 1];
    expect(last.content).toContain('row 1');
    expect(last.content).toContain('Page 1/3 • 25 total');
    const components = last.payload.components as Array<{
      toJSON: () => { components: unknown[] };
    }>;
    expect(components).toHaveLength(1);
    expect(components[0].toJSON().components).toHaveLength(3);
  });

  it('shows the empty-content message when there are no rows', async () => {
    const { interaction, replies } = createMockInteraction();
    await interaction.deferReply();
    await replyWithPagination(interaction, {
      header: 'H',
      rows: [],
      emptyContent: 'Nothing here.',
    });

    expect(replies[replies.length - 1].content).toBe('Nothing here.');
  });

  it('defaults the page size when unspecified', async () => {
    const { interaction, replies } = createMockInteraction();
    await interaction.deferReply();
    // One more row than the default page size forces a second page.
    await replyWithPagination(interaction, { rows: rows(PAGINATION_DEFAULT_PAGE_SIZE + 1) });

    const last = replies[replies.length - 1];
    expect(last.content).toContain('Page 1/2');
    expect(last.payload.components).toBeDefined();
  });
});
