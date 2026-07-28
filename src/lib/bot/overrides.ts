/**
 * Overruling the bot.
 *
 * Tables play off-book. Someone gives a clue that means something at your table
 * and nothing in the convention, and the bot either reads it wrong or gives up
 * with `??`. Rather than trying to guess, it lets you say what a card means and
 * then reasons from that.
 *
 * A correction is attached to a **card**, not to a clue, because the bot's whole
 * state is what each card means: pin that and the notes, the connections it
 * searches for and the move values all follow. "That clue was a chop move" is
 * said by marking the chop card as chop moved.
 *
 * Corrections live in their own localStorage key, keyed by game and by order.
 * They are never part of the game record, so they cannot reach the export, and
 * because orders are stable they survive undo and a corrected card.
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

export type BotOverrides = Record<number, BotOverride>;

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
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as BotOverrides;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveOverrides(gameId: string, overrides: BotOverrides): void {
  try {
    if (Object.keys(overrides).length === 0) storage()?.removeItem(PREFIX + gameId);
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
  return Object.keys(overrides).length;
}
