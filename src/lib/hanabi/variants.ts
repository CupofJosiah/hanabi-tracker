/**
 * Runtime variant model, built from the generated `variantData.ts`.
 *
 * The clue-touch rules mirror hanab.live (and scala-bot's `Variant.idTouched`)
 * so that a clue recorded here means the same thing when the export is replayed
 * elsewhere. Only variants without special-rank rules are bundled, so the rules
 * below are the complete set.
 */
import { SUITS, VARIANTS, type SuitDef } from "./variantData";
import type { Clue, Identity } from "./types";

export type { SuitDef };

export interface ClueColor {
  /** Label shown on the clue button, e.g. `Pink` for the Dark Pink suit. */
  name: string;
  fill: readonly string[];
  /** Which suit in this variant this colour names. */
  suitIndex: number;
}

export interface Variant {
  name: string;
  suits: readonly SuitDef[];
  /** Per-suit display letters, made unique within the variant. */
  abbreviations: readonly string[];
  /** Colour clues available, in the order hanab.live indexes them. */
  clueColors: readonly ClueColor[];
  clueRanks: readonly number[];
  /** How many copies of each rank exist, per suit. */
  cardCounts: readonly (readonly number[])[];
  totalCards: number;
  maxScore: number;
}

export const RANKS = [1, 2, 3, 4, 5] as const;
const COPIES_BY_RANK = [3, 2, 2, 2, 1];

const cache = new Map<string, Variant>();

export const VARIANT_NAMES: readonly string[] = VARIANTS.map(([name]) => name);
export const DEFAULT_VARIANT_NAME = "No Variant";

const definitions = new Map(VARIANTS.map(([name, suits]) => [name, suits]));

export function variantExists(name: string): boolean {
  return definitions.has(name);
}

export function getVariant(name: string): Variant {
  const cached = cache.get(name);
  if (cached) return cached;

  const suitIndices = definitions.get(name);
  if (!suitIndices) throw new Error(`Unknown variant: ${name}`);

  const suits = suitIndices.map((i) => SUITS[i]);
  const cardCounts = suits.map((suit) => COPIES_BY_RANK.map((n) => (suit.oneOfEach ? 1 : n)));
  const variant: Variant = {
    name,
    suits,
    abbreviations: uniqueAbbreviations(suits),
    clueColors: suits.flatMap((suit, suitIndex) =>
      isColourable(suit) ? [{ name: suit.clueColor ?? suit.name, fill: suit.fill, suitIndex }] : [],
    ),
    clueRanks: [...RANKS],
    cardCounts,
    totalCards: cardCounts.flat().reduce((a, b) => a + b, 0),
    maxScore: suits.length * 5,
  };

  cache.set(name, variant);
  return variant;
}

/** A suit is colourable when some colour clue names it specifically. */
function isColourable(suit: SuitDef): boolean {
  return !suit.allClueColors && !suit.noClueColors && !suit.prism;
}

function uniqueAbbreviations(suits: readonly SuitDef[]): string[] {
  const used = new Set<string>();
  return suits.map((suit) => {
    const candidates = [suit.abbr, ...suit.name.replace(/[^A-Za-z]/g, "").toUpperCase()];
    const pick = candidates.find((c) => !used.has(c)) ?? suit.abbr;
    used.add(pick);
    return pick;
  });
}

export function copiesOf(variant: Variant, identity: Identity): number {
  return variant.cardCounts[identity.suitIndex]?.[identity.rank - 1] ?? 0;
}

/** Every distinct identity in the variant, in suit-then-rank order. */
export function allIdentities(variant: Variant): Identity[] {
  return variant.suits.flatMap((_, suitIndex) => RANKS.map((rank) => ({ suitIndex, rank })));
}

/** Whether a clue touches a card — the rule the analyser replays against. */
export function cardTouched(variant: Variant, identity: Identity, clue: Clue): boolean {
  const suit = variant.suits[identity.suitIndex];
  if (!suit) return false;

  if (clue.kind === "color") {
    if (suit.allClueColors) return true;
    if (suit.noClueColors) return false;
    if (suit.prism) return (identity.rank - 1) % variant.clueColors.length === clue.value;
    return variant.clueColors[clue.value]?.suitIndex === identity.suitIndex;
  }

  if (suit.allClueRanks) return true;
  if (suit.noClueRanks) return false;
  return identity.rank === clue.value;
}

export function suitAbbreviation(variant: Variant, suitIndex: number): string {
  return variant.abbreviations[suitIndex] ?? "?";
}

/** Short human name for a card, e.g. `r3`, matching the transcript shorthand. */
export function identityName(variant: Variant, identity: Identity): string {
  if (identity.suitIndex < 0 || identity.rank < 0) return "??";
  return `${suitAbbreviation(variant, identity.suitIndex).toLowerCase()}${identity.rank}`;
}

export function clueName(variant: Variant, clue: Clue): string {
  return clue.kind === "color"
    ? (variant.clueColors[clue.value]?.name ?? `colour ${clue.value}`)
    : String(clue.value);
}

/** Variant names matching a search box, cheap enough to run on every keystroke. */
export function searchVariants(query: string, limit = 60): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return VARIANT_NAMES.slice(0, limit);
  const words = needle.split(/\s+/);
  const matches: string[] = [];
  for (const name of VARIANT_NAMES) {
    const haystack = name.toLowerCase();
    if (words.every((word) => haystack.includes(word))) {
      matches.push(name);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}
