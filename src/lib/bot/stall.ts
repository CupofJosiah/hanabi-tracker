/**
 * When a clue is allowed to say nothing.
 *
 * H-Group level 9. Most of the convention rests on Minimum Clue Value — a clue
 * has to get a card played or save one — but there are positions where a player
 * *may not discard* and has no such clue to give. Then a clue that says nothing
 * is not a mistake, it is the only legal move, and reading it as a play clue
 * invents a promise nobody made.
 *
 * The situations are ranked, because which stall clues are permitted depends on
 * how stuck the giver was (`hanabi.github.io/level-9`):
 *
 * ```
 * 0  normal        nothing special
 * 1  early game    nobody has discarded their chop yet
 * 2  double discard the last discard may be about to be duplicated
 * 3  locked hand   every card is clued or chop moved; no legal discard
 * 4  eight clues   discarding is illegal outright
 * ```
 *
 * and the clues themselves are ranked too, most informative first: a normal
 * play or save clue, then the 5 Stall, then a tempo clue, then a fill-in or a
 * locked-hand/8-clue save, and finally a hard burn that says nothing at all.
 * The bot uses that ordering as a *fallback*: a reading that gets a card played
 * always wins, and only when none exists does the clue get read as a stall.
 */
import { pace, type GameState } from "../hanabi/engine";
import { MAX_CLUE_TOKENS, type Clue } from "../hanabi/types";
import {
  chopOf,
  criticalOrds,
  handOrders,
  identityOfOrd,
  possibilities,
  type Ord,
  type Thought,
} from "./empathy";

export const Stall = {
  None: 0,
  EarlyGame: 1,
  DoubleDiscard: 2,
  LockedHand: 3,
  EightClues: 4,
} as const;

export type StallSeverity = (typeof Stall)[keyof typeof Stall];

/** Every card is clued or chop moved, so there is nothing safe to throw away. */
export function isLocked(
  state: GameState,
  thoughts: Map<number, Thought>,
  seat: number,
): boolean {
  const hand = handOrders(state, seat);
  return hand.length > 0 && chopOf(state, thoughts, seat) === undefined;
}

/**
 * The identity the previous discard just made critical, when the player about
 * to act could be holding the last copy on their own chop.
 *
 * That is H-Group's Double Discard position: discarding blind could throw away
 * the second-to-last copy of something the team still needs, so the player is
 * expected to clue instead — and a clue given there may be a stall.
 */
export function doubleDiscardRisk(
  state: GameState,
  thoughts: Map<number, Thought>,
  seat: number,
  lastDiscard: Ord | undefined,
): Ord | undefined {
  if (lastDiscard === undefined) return undefined;
  if (!criticalOrds(state).has(lastDiscard)) return undefined;
  const chop = chopOf(state, thoughts, seat);
  if (chop === undefined) return undefined;
  const thought = thoughts.get(chop);
  if (!thought) return undefined;
  return possibilities(thought).has(lastDiscard) ? lastDiscard : undefined;
}

export interface StallInput {
  state: GameState;
  thoughts: Map<number, Thought>;
  /** The seat that gave — or is about to give — the clue. */
  giver: number;
  /** Clue tokens as the giver found them, before the clue was paid for. */
  clueTokens: number;
  earlyGame: boolean;
  /** From `doubleDiscardRisk`, computed against the board the giver faced. */
  doubleDiscard: Ord | undefined;
}

/** How stuck the giver was, on H-Group's scale. The highest one that applies. */
export function stallSeverity(input: StallInput): StallSeverity {
  if (input.clueTokens >= MAX_CLUE_TOKENS) return Stall.EightClues;
  if (isLocked(input.state, input.thoughts, input.giver)) return Stall.LockedHand;
  if (input.doubleDiscard !== undefined) return Stall.DoubleDiscard;
  if (input.earlyGame) return Stall.EarlyGame;
  return Stall.None;
}

export function severityName(severity: StallSeverity): string {
  switch (severity) {
    case Stall.EightClues:
      return "at 8 clues";
    case Stall.LockedHand:
      return "locked hand";
    case Stall.DoubleDiscard:
      return "double discard position";
    case Stall.EarlyGame:
      return "early game";
    default:
      return "no stall";
  }
}

/**
 * The 5 Stall: a "5" clue on a 5 that is not on chop, given because there was
 * nothing better to say.
 *
 * Level 2 already knows this one — it is how the early game is padded out. Two
 * rules keep it from swallowing every 5 clue: there has to *be* a stalling
 * situation, and the 5 clued has to be the one nearest the chop, because
 * anything else would be pointing at a particular card.
 */
export function isFiveStall(
  state: GameState,
  thoughts: Map<number, Thought>,
  target: number,
  clue: Clue,
  focus: number,
  onChop: boolean,
  severity: StallSeverity,
): boolean {
  if (severity === Stall.None) return false;
  if (clue.kind !== "rank" || clue.value !== 5 || onChop) return false;

  const thought = thoughts.get(focus);
  if (!thought) return false;
  if (![...possibilities(thought)].some((ord) => identityOfOrd(ord).rank === 5)) return false;

  // "The 5 closest to chop" — of the fives the clue could have gone to, this
  // has to be the oldest, or it is naming a card rather than passing the turn.
  const hand = handOrders(state, target);
  const chopIndex = hand.length - 1;
  for (let i = chopIndex; i >= 0; i--) {
    const order = hand[i];
    if (order === focus) return true;
    const other = thoughts.get(order);
    if (!other || state.cards[order]?.knowledge.clued) continue;
    const pool = possibilities(other);
    if (pool.size > 0 && [...pool].every((ord) => identityOfOrd(ord).rank === 5)) return false;
  }
  return true;
}

/**
 * A clue that hands out information without asking for anything: it touches no
 * new cards and gets nothing played.
 *
 * Permitted from a Double Discard position upwards. Below that, a clue with
 * nothing to say is a Tempo Clue Chop Move instead (level 6).
 */
export function isFillIn(
  touchedNewCards: boolean,
  narrowedSomething: boolean,
  severity: StallSeverity,
): boolean {
  return !touchedNewCards && narrowedSomething && severity >= Stall.DoubleDiscard;
}

/**
 * A Locked Hand Save: with no legal discard, any chop card may be saved, not
 * just the 2s, 5s and last copies.
 */
export function allowsLockedHandSave(severity: StallSeverity, onChop: boolean): boolean {
  return severity >= Stall.LockedHand && onChop;
}

/**
 * An 8 Clue Save: at maximum clues anything may be saved except a card on the
 * receiver's finesse position, which would read as a play clue.
 */
export function allowsEightClueSave(
  state: GameState,
  severity: StallSeverity,
  focus: number,
): boolean {
  return severity >= Stall.EightClues && (state.cards[focus]?.slot ?? 0) !== 1;
}

/** A clue that leaves every note exactly as it found it: the last resort. */
export function isHardBurn(
  touchedNewCards: boolean,
  narrowedSomething: boolean,
  severity: StallSeverity,
): boolean {
  return !touchedNewCards && !narrowedSomething && severity >= Stall.DoubleDiscard;
}

/**
 * H-Group's end-game: the point where pace runs out and there is no longer a
 * future to save cards for.
 *
 * The one reading that turns on it is that chop moves stop existing — a clue
 * that looks like one has to mean something else, because the cards being held
 * back would never be reached.
 */
export function inEndgame(state: GameState): boolean {
  return pace(state) < state.players.length;
}
