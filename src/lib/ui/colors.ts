import type { SuitDef } from "../hanabi/variants";

/** CSS background for a suit: a flat colour, or a sweep for multicolour suits. */
export function suitBackground(suit: SuitDef | undefined): string {
  if (!suit) return "var(--panel-3)";
  if (suit.fill.length === 1) return suit.fill[0];
  return `linear-gradient(150deg, ${suit.fill.join(", ")})`;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  if (value.length !== 6) return 0.5;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Ink that stays legible on a suit's fill — Yellow and White need dark text. */
export function suitInk(suit: SuitDef | undefined): string {
  if (!suit) return "var(--text)";
  const average = suit.fill.map(luminance).reduce((a, b) => a + b, 0) / suit.fill.length;
  return average > 0.42 ? "#0d0f13" : "#ffffff";
}
