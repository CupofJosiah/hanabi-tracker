/**
 * Overruling the bot.
 *
 * Tables play off-book. Someone gives a clue that means something at your table
 * and nothing in the convention, and the bot either reads it wrong or gives up
 * with `??`. Rather than trying to guess, it lets you say what a card means and
 * then reasons from that.
 *
 * There are two kinds. A **card** correction says what one card means, and is
 * the general one: the bot's whole state is what each card means, so pinning a
 * card propagates to the notes, to the connections it searches for next and to
 * the move values. A **clue** correction picks between readings the bot itself
 * came up with — when it settled on the wrong one of two, saying which is far
 * quicker than describing the cards one at a time.
 *
 * Corrections live in their own localStorage key, keyed by game. They are never
 * part of the game record, so they cannot reach the export, and because orders
 * and action indices are stable they survive undo and a corrected card.
 */
import type { CardStatus } from "./empathy";
import type { Ord } from "./empathy";

export interface BotOverride {
  /** What the card is doing, as you say it is. */
  status?: CardStatus;
  /** The identity you know it to be, as an ordinal. */
  identity?: Ord;
  /**
   * How many actions had been recorded when you said so.
   *
   * A correction applies from that point on rather than retroactively, so
   * stepping back through the game still shows what the table knew at the time.
   */
  fromAction: number;
}

/** Which of the readings a clue could carry is the one your table meant. */
export interface ClueOverride {
  /** The identity the focus really was, as an ordinal. */
  identity: Ord;
}

export interface BotOverrides {
  /** Keyed by card order. */
  cards: Record<number, BotOverride>;
  /** Keyed by the clue's index in `record.actions`. */
  clues: Record<number, ClueOverride>;
}

export const NO_OVERRIDES: BotOverrides = { cards: {}, clues: {} };

/**
 * Accepts either shape: the current one, or the flat card map written before
 * clue corrections existed. Saved games outlive their storage format.
 */
export function normaliseOverrides(value: unknown): BotOverrides {
  if (typeof value !== "object" || value === null) return { cards: {}, clues: {} };
  const record = value as Record<string, unknown>;
  if (typeof record.cards === "object" && record.cards !== null) {
    return {
      cards: record.cards as Record<number, BotOverride>,
      clues:
        typeof record.clues === "object" && record.clues !== null
          ? (record.clues as Record<number, ClueOverride>)
          : {},
    };
  }
  return { cards: record as unknown as Record<number, BotOverride>, clues: {} };
}

const PREFIX = "hanabi-tracker/v1/bot-overrides/";

function storage(): Storage | undefined {
  try {
    const probe = "hanabi-tracker/probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadOverrides(gameId: string): BotOverrides {
  const raw = storage()?.getItem(PREFIX + gameId);
  if (!raw) return { cards: {}, clues: {} };
  try {
    return normaliseOverrides(JSON.parse(raw));
  } catch {
    return { cards: {}, clues: {} };
  }
}

export function saveOverrides(gameId: string, overrides: BotOverrides): void {
  try {
    if (countOverrides(overrides) === 0) storage()?.removeItem(PREFIX + gameId);
    else storage()?.setItem(PREFIX + gameId, JSON.stringify(overrides));
  } catch {
    // A correction that cannot be saved still applies for this session.
  }
}

export function deleteOverrides(gameId: string): void {
  try {
    storage()?.removeItem(PREFIX + gameId);
  } catch {
    // Nothing to do.
  }
}

export function countOverrides(overrides: BotOverrides): number {
  return Object.keys(overrides.cards).length + Object.keys(overrides.clues).length;
}
