/*
================================================================================
FILE: frontend/src/theme/contrast.ts
================================================================================

SUMMARY
    The WCAG 2 contrast ratio between two colors, and the color a translucent
    mark makes over its background. What the palette tests measure with.

BASIC IDEA
    Relative luminance from sRGB, then (L1 + 0.05) / (L2 + 0.05). A graph
    node is drawn translucent (G-8), so its contrast is measured as drawn:
    composited over the graph background first, channel by channel.

INPUTS / INPUT SOURCES
    - Six-digit hex colors, optionally with a two-digit alpha.

EXPECTED OUTPUT
    - contrast(a, b): the ratio, 1 to 21.
    - over(mark, bg): the opaque hex the mark shows as on bg.
================================================================================
*/

function channels(hex: string): [number, number, number, number] {
  const h = hex.replace("#", "");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c, i) => {
    if (i === 3) return c;
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** `mark` (with or without alpha) composited over the opaque `bg`. */
export function over(mark: string, bg: string): string {
  const [r, g, b, a] = channels(mark);
  const [R, G, B] = channels(bg);
  const mix = (c: number, C: number) =>
    Math.round(c * a + C * (1 - a)).toString(16).padStart(2, "0");
  return `#${mix(r, R)}${mix(g, G)}${mix(b, B)}`;
}
