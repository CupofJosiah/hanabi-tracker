/**
 * The data model, chosen to match hanab.live's export JSON as closely as
 * possible so that exporting is a formatting step rather than a translation.
 *
 * The two load-bearing ideas:
 *
 *  1. A card is identified by its **order** — its index in the deck, i.e. the
 *     order it was dealt or drawn in. Every play/discard refers to an order.
 *  2. A game is fully described by `deck` + `actions`. Everything else (hands,
 *     stacks, strikes, clue tokens, whose turn it is) is derived by replaying
 *     them, which is what makes undo, history scrubbing and crash recovery
 *     trivial.
 */

/** A card's face. `UNKNOWN` (-1/-1) is a card we have not seen — normally ours. */
export interface Identity {
  suitIndex: number;
  rank: number;
}

export const UNKNOWN_SUIT = -1;
export const UNKNOWN_RANK = -1;

export const UNKNOWN: Identity = { suitIndex: UNKNOWN_SUIT, rank: UNKNOWN_RANK };

export function isKnown(identity: Identity | undefined): boolean {
  return identity !== undefined && identity.suitIndex >= 0 && identity.rank >= 0;
}

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.suitIndex === b.suitIndex && a.rank === b.rank;
}

/** hanab.live's `ActionType`. The numbers are part of the export format. */
export const ActionType = {
  Play: 0,
  Discard: 1,
  ColorClue: 2,
  RankClue: 3,
  EndGame: 4,
} as const;

export type ActionTypeValue = (typeof ActionType)[keyof typeof ActionType];

/**
 * One entry of the exported `actions` array.
 *
 * - Play/Discard: `target` is the card's order.
 * - Colour/Rank clue: `target` is the player index, `value` the colour index
 *   (into the variant's clue colours) or the rank.
 * - EndGame: `target` is the player who ended it, `value` the end condition.
 *
 * A misplay is recorded as a Play; hanab.live works out that it bombed from the
 * deck, and so does the scala-bot analyser.
 */
export interface GameAction {
  type: ActionTypeValue;
  target: number;
  value: number;
}

/** hanab.live's `EndCondition`, used as the `value` of an EndGame action. */
export const EndCondition = {
  InProgress: 0,
  Normal: 1,
  Strikeout: 2,
  Timeout: 3,
  Terminated: 4,
} as const;

export type EndConditionValue = (typeof EndCondition)[keyof typeof EndCondition];

export type ClueKind = "color" | "rank";

export interface Clue {
  kind: ClueKind;
  /** Colour index into the variant's clue colours, or the rank for a rank clue. */
  value: number;
}

/**
 * A game as stored on the device.
 *
 * `deck` grows as cards are dealt and drawn and is dense: `deck[order]` is the
 * card with that order, `UNKNOWN` while we have not seen its face. `actions` is
 * exactly the array that gets exported.
 */
export interface GameRecord {
  /** Local id, unrelated to any hanab.live game id. */
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Free-text label; defaults to the date. */
  title: string;
  players: string[];
  /** Which seat is the person holding the phone — the hidden hand. */
  ourPlayerIndex: number;
  variantName: string;
  deck: Identity[];
  actions: GameAction[];
  /**
   * Which orders each clue touched, keyed by index into `actions`.
   *
   * For clues to other players this is derived from the deck, but for clues to
   * us it cannot be — we do not know our own cards — so the recorder taps the
   * touched slots and we keep the answer here. Not part of the export; used for
   * the "what do I know about my hand" view and to narrow our unknown cards.
   */
  touchedByAction: Record<number, number[]>;
  /** Per-card notes, keyed by order. Exported in hanab.live's `notes` field. */
  notes: Record<number, string>;
  /** Set once the game is over; drives the home screen and export. */
  finishedAt?: number;
  /** Optional hanab.live game id, once uploaded. */
  hanabLiveId?: number;
  options: GameOptions;
}

export interface GameOptions {
  /** hanab.live rule: the last card of the deck may be played blind. */
  deckPlays: boolean;
  /** hanab.live rule: clues that touch no cards are legal. */
  emptyClues: boolean;
}

export const DEFAULT_OPTIONS: GameOptions = { deckPlays: false, emptyClues: false };

/** hanab.live's hand sizes, indexed by player count. */
const HAND_SIZES = [0, 0, 5, 5, 4, 4, 3];

export function handSize(numPlayers: number): number {
  const size = HAND_SIZES[numPlayers];
  if (size === undefined || size === 0) {
    throw new Error(`Hanabi supports 2-6 players, not ${numPlayers}`);
  }
  return size;
}

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const MAX_CLUE_TOKENS = 8;
export const MAX_STRIKES = 3;
