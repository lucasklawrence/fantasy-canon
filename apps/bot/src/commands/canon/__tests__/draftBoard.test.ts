import { describe, expect, it } from 'vitest';
import { buildBoardComponents } from '../draftSession.js';

describe('buildBoardComponents', () => {
  it('emits session-tagged refresh + grade buttons on one action row', () => {
    const rows = buildBoardComponents('1720000000000');
    expect(rows).toHaveLength(1);

    const buttons = rows[0].toJSON().components as Array<{ custom_id: string; label: string }>;
    // customIds carry the `:<sessionId>` marker so a leftover board's buttons are rejectable.
    expect(buttons.map((b) => b.custom_id)).toEqual([
      'canon:board:refresh:1720000000000',
      'canon:board:grade:1720000000000',
    ]);
    expect(buttons.map((b) => b.label)).toEqual(['Refresh', 'Grade my roster']);
  });
});
