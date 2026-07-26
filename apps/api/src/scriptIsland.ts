/**
 * Safe interpolation of server values into a `<script>` JSON island, shared by the page shells
 * (`board.ts`, `lotteryPage.ts`).
 */

// U+2028 / U+2029 are valid JSON but illegal raw in a <script>; build them from char codes so
// this source file stays pure ASCII.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

/**
 * Escape a value for a `<script>` JSON island: `<` (→ `</script>`) and the two line terminators
 * are the only sequences that can break out, so an injected value can never break the markup.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .split(LINE_SEP)
    .join('\\u2028')
    .split(PARA_SEP)
    .join('\\u2029');
}
