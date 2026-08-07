import { describe, expect, it } from 'vitest';
import { rasterizeSvgLogo } from '../render.js';

describe('rasterizeSvgLogo (#249)', () => {
  it('turns a real SVG into PNG bytes', () => {
    const png = rasterizeSvgLogo(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
    );
    expect(png).not.toBeNull();
    // PNG magic: \x89PNG
    expect(png?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('returns null for garbage instead of throwing — the caller treats it as "no logo"', () => {
    expect(rasterizeSvgLogo('not an svg at all')).toBeNull();
    expect(rasterizeSvgLogo('')).toBeNull();
  });
});
