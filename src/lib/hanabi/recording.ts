/**
 * Turning taps into `GameRecord` updates.
 *
 * Every function here is pure: it takes a record and returns a new one, so the
 * caller can store the result and get undo for free. State needed to make a
 * decision (did a draw happen? which slot was that?) is recovered by replaying,
 * never cached.
 */
import { replay, stateOf, type GameState } from "./engine";
import {
  ActionType,
  DEFAULT_OPTIONS,
  EndCondition,
  UNKNOWN,
  handSize,
  type Clue,
  type EndConditionValue,
  type GameOptions,
  type GameRecord,
  type Identity,
} from "./types";
import { getVariant } from "./variants";

export interface NewGameInput {
  players: string[];
  ourPlayerIndex: number;
  variantName: string;
  title?: string;
  options?: Partial<GameOptions>;
}

export function createGame(input: NewGameInput): GameRecord {
  const { players, ourPlayerIndex, variantName } = input;
  const variant = getVariant(variantName);
  const dealt = players.length * handSize(players.length);
  if (dealt > variant.totalCards) {
    throw new Error(`${variantName} does not have enough cards for ${players.length} players.`);
  }

  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    title: input.title?.trim() || defaultTitle(players, now),
    players: [...players],
    ourPlayerIndex,
    variantName,
    deck: Array.from({ length: dealt }, () => ({ ...UNKNOWN })),
    actions: [],
    touchedByAction: {},
    notes: {},
    options: { ...DEFAULT_OPTIONS, ...input.options },
  };
}

export function defaultTitle(players: readonly string[], at: number): string {
  const date = new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `${date} · ${players.length}p`;
}

/**
 * Deck index of a card dealt to a seat at the start.
 *
 * hanab.live deals a whole hand at a time and every draw becomes slot 1, so
 * within a seat's block the highest index is the newest card.
 */
export function initialDeckIndex(numPlayers: number, playerIndex: number, slot: number): number {
  const size = handSize(numPlayers);
  return playerIndex * size + (size - slot);
}

/** Fills in one card of a starting hand during setup. */
export function setDealtCard(
  record: GameRecord,
  playerIndex: number,
  slot: number,
  identity: Identity,
): GameRecord {
  const deck = [...record.deck];
  deck[initialDeckIndex(record.players.length, playerIndex, slot)] = { ...identity };
  return touch({ ...record, deck });
}

/** True once every visible starting card has been entered. */
export function setupComplete(record: GameRecord): boolean {
  const size = handSize(record.players.length);
  for (let playerIndex = 0; playerIndex < record.players.length; playerIndex++) {
    if (playerIndex === record.ourPlayerIndex) continue;
    for (let slot = 1; slot <= size; slot++) {
      const card = record.deck[initialDeckIndex(record.players.length, playerIndex, slot)];
      if (!card || card.suitIndex < 0) return false;
    }
  }
  return true;
}

export interface PlayInput {
  /** The card's order, i.e. its deck index. */
  order: number;
  /** Its face, needed when it was one of our hidden cards. */
  reveal?: Identity;
  /** The card drawn to replace it, if the drawer is not us and the deck holds. */
  drawn?: Identity;
}

export function recordPlay(record: GameRecord, input: PlayInput): GameRecord {
  return recordPlayOrDiscard(record, ActionType.Play, input);
}

export function recordDiscard(record: GameRecord, input: PlayInput): GameRecord {
  return recordPlayOrDiscard(record, ActionType.Discard, input);
}

function recordPlayOrDiscard(
  record: GameRecord,
  type: typeof ActionType.Play | typeof ActionType.Discard,
  { order, reveal, drawn }: PlayInput,
): GameRecord {
  const before = stateOf(record);
  const deck = [...record.deck];
  if (reveal) deck[order] = { ...reveal };

  const actions = [...record.actions, { type, target: order, value: 0 }];
  // The replacement draw is part of the same turn, so it appends to the deck now.
  if (before.cardsRemaining > 0) deck.push(drawn ? { ...drawn } : { ...UNKNOWN });

  return finish(touch({ ...record, deck, actions }));
}

export function recordClue(
  record: GameRecord,
  target: number,
  clue: Clue,
  touched?: readonly number[],
): GameRecord {
  const actions = [
    ...record.actions,
    {
      type: clue.kind === "color" ? ActionType.ColorClue : ActionType.RankClue,
      target,
      value: clue.value,
    },
  ];
  const touchedByAction = { ...record.touchedByAction };
  if (touched) touchedByAction[actions.length - 1] = [...touched];

  return finish(touch({ ...record, actions, touchedByAction }));
}

/** Ends a game early — someone had to catch a train. */
export function endGame(
  record: GameRecord,
  condition: EndConditionValue = EndCondition.Terminated,
): GameRecord {
  const state = stateOf(record);
  if (state.finished) return touch({ ...record, finishedAt: record.finishedAt ?? Date.now() });
  const actions = [
    ...record.actions,
    { type: ActionType.EndGame, target: record.ourPlayerIndex, value: condition },
  ];
  return touch({ ...record, actions, finishedAt: Date.now() });
}

/** Marks the record finished if replaying says the game is over. */
function finish(record: GameRecord): GameRecord {
  const state = stateOf(record);
  if (state.finished && record.finishedAt === undefined) {
    return { ...record, finishedAt: Date.now() };
  }
  if (!state.finished && record.finishedAt !== undefined) {
    const { finishedAt: _dropped, ...rest } = record;
    return rest;
  }
  return record;
}

/** Removes the last action, along with any card it caused to be drawn. */
export function undo(record: GameRecord): GameRecord {
  if (record.actions.length === 0) return record;
  const actions = record.actions.slice(0, -1);
  const removedIndex = record.actions.length - 1;

  const before = replay({
    players: record.players,
    ourPlayerIndex: record.ourPlayerIndex,
    variant: getVariant(record.variantName),
    deck: record.deck,
    actions,
    touchedByAction: record.touchedByAction,
    options: record.options,
  });

  // Everything drawn after this point goes away with it.
  const drawn = before.cards.length;
  const deck = record.deck.slice(0, Math.max(drawn, minimumDeckLength(record)));

  const touchedByAction = { ...record.touchedByAction };
  delete touchedByAction[removedIndex];

  const notes = Object.fromEntries(
    Object.entries(record.notes).filter(([order]) => Number(order) < deck.length),
  );

  return finish(touch({ ...record, actions, deck, touchedByAction, notes }));
}

function minimumDeckLength(record: GameRecord): number {
  return record.players.length * handSize(record.players.length);
}

/**
 * Sets what a card actually is.
 *
 * Covers both filling in a card we could not see at the time and correcting one
 * entered wrongly — a mistyped draw, say. Because the board is replayed from the
 * deck, a correction re-runs the whole game: stacks, strikes and the score all
 * follow the new card, which is why the finished flag is re-derived too.
 */
export function revealCard(record: GameRecord, order: number, identity: Identity): GameRecord {
  const deck = [...record.deck];
  if (order < 0 || order >= deck.length) return record;
  deck[order] = { ...identity };
  return finish(touch({ ...record, deck }));
}

export function revealMany(record: GameRecord, identities: ReadonlyMap<number, Identity>): GameRecord {
  const deck = [...record.deck];
  for (const [order, identity] of identities) {
    if (order >= 0 && order < deck.length) deck[order] = { ...identity };
  }
  return finish(touch({ ...record, deck }));
}

export function setNote(record: GameRecord, order: number, text: string): GameRecord {
  const notes = { ...record.notes };
  if (text.trim() === "") delete notes[order];
  else notes[order] = text;
  return touch({ ...record, notes });
}

export function rename(record: GameRecord, title: string): GameRecord {
  return touch({ ...record, title: title.trim() || record.title });
}

export function setHanabLiveId(record: GameRecord, id: number | undefined): GameRecord {
  return touch({ ...record, hanabLiveId: id });
}

function touch(record: GameRecord): GameRecord {
  return { ...record, updatedAt: Date.now() };
}

/** Whether the seat about to act is the one holding the phone. */
export function isOurTurn(state: GameState): boolean {
  return state.currentPlayerIndex === state.ourPlayerIndex;
}
