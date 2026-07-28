/**
 * Replays `deck` + `actions` into a full game state.
 *
 * Nothing else in the app mutates game state: recording a turn appends to the
 * record and the whole game is replayed. Games are at most a couple of hundred
 * actions, so this is cheap, and it buys exact undo and history scrubbing.
 */
import {
  ActionType,
  EndCondition,
  MAX_CLUE_TOKENS,
  MAX_STRIKES,
  UNKNOWN,
  handSize,
  isKnown,
  type Clue,
  type GameAction,
  type GameOptions,
  type GameRecord,
  type Identity,
} from "./types";
import { cardTouched, clueName, getVariant, identityName, type Variant } from "./variants";

export type CardLocation = "hand" | "played" | "discarded";

export interface CardKnowledge {
  /** Colour clue indices that touched this card. */
  positiveColors: number[];
  negativeColors: number[];
  positiveRanks: number[];
  negativeRanks: number[];
  clued: boolean;
}

export interface CardState {
  order: number;
  identity: Identity;
  location: CardLocation;
  /** Seat holding the card, or -1 once it has left a hand. */
  holder: number;
  /** 1-based slot while in a hand (1 = newest), else 0. */
  slot: number;
  /** Seat that drew it, for the "who drew this" hint in the discard pile. */
  drawnBy: number;
  /** True when it left the hand as a misplay rather than a discard. */
  failed: boolean;
  knowledge: CardKnowledge;
}

export type LogKind = "play" | "bomb" | "discard" | "clue" | "end";

export interface LogEntry {
  /** Index into `actions`. */
  actionIndex: number;
  turn: number;
  playerIndex: number;
  kind: LogKind;
  text: string;
}

export interface GameState {
  players: readonly string[];
  ourPlayerIndex: number;
  variant: Variant;
  options: GameOptions;
  /** Orders per seat; index 0 is slot 1, the newest card. */
  hands: number[][];
  /** Indexed by order. */
  cards: CardState[];
  /** Highest rank played per suit; 0 means nothing played. */
  playStacks: number[];
  /** Orders in the discard pile, oldest first. */
  discards: number[];
  clueTokens: number;
  strikes: number;
  score: number;
  maxScore: number;
  /** 1-based; equals the number of actions replayed plus one. */
  turn: number;
  currentPlayerIndex: number;
  /** Cards still undrawn. */
  cardsRemaining: number;
  /** Turns left once the deck is empty, or null before that. */
  finalRoundLeft: number | null;
  finished: boolean;
  endCondition: number;
  log: LogEntry[];
}

export interface ReplayInput {
  players: readonly string[];
  ourPlayerIndex: number;
  variant: Variant;
  deck: readonly Identity[];
  actions: readonly GameAction[];
  touchedByAction: Readonly<Record<number, number[]>>;
  options: GameOptions;
}

function emptyKnowledge(): CardKnowledge {
  return {
    positiveColors: [],
    negativeColors: [],
    positiveRanks: [],
    negativeRanks: [],
    clued: false,
  };
}

export function clueOf(action: GameAction): Clue | null {
  if (action.type === ActionType.ColorClue) return { kind: "color", value: action.value };
  if (action.type === ActionType.RankClue) return { kind: "rank", value: action.value };
  return null;
}

/**
 * Replays a game.
 *
 * @param through How many actions to apply; used by the history scrubber.
 */
export function replay(input: ReplayInput, through = Number.POSITIVE_INFINITY): GameState {
  const { players, variant, deck, actions, touchedByAction, options } = input;
  const numPlayers = players.length;
  const cardsPerHand = handSize(numPlayers);

  const state: GameState = {
    players,
    ourPlayerIndex: input.ourPlayerIndex,
    variant,
    options,
    hands: Array.from({ length: numPlayers }, () => []),
    cards: [],
    playStacks: variant.suits.map(() => 0),
    discards: [],
    clueTokens: MAX_CLUE_TOKENS,
    strikes: 0,
    score: 0,
    maxScore: variant.maxScore,
    turn: 1,
    currentPlayerIndex: 0,
    cardsRemaining: variant.totalCards,
    finalRoundLeft: null,
    finished: false,
    endCondition: EndCondition.InProgress,
    log: [],
  };

  let nextOrder = 0;

  const draw = (playerIndex: number): void => {
    if (nextOrder >= variant.totalCards) return;
    const order = nextOrder++;
    state.cards[order] = {
      order,
      identity: deck[order] ?? UNKNOWN,
      location: "hand",
      holder: playerIndex,
      slot: 1,
      drawnBy: playerIndex,
      failed: false,
      knowledge: emptyKnowledge(),
    };
    state.hands[playerIndex].unshift(order);
    state.cardsRemaining = variant.totalCards - nextOrder;
  };

  // hanab.live deals one full hand at a time, so seat 0 owns orders 0..handSize-1.
  for (let playerIndex = 0; playerIndex < numPlayers; playerIndex++) {
    for (let i = 0; i < cardsPerHand; i++) draw(playerIndex);
  }

  const removeFromHand = (playerIndex: number, order: number): number => {
    const hand = state.hands[playerIndex];
    const index = hand.indexOf(order);
    if (index === -1) return 0;
    hand.splice(index, 1);
    return index + 1;
  };

  const limit = Math.min(actions.length, through);
  for (let actionIndex = 0; actionIndex < limit; actionIndex++) {
    if (state.finished) break;
    const action = actions[actionIndex];
    const actor = state.currentPlayerIndex;
    let drew = false;

    switch (action.type) {
      case ActionType.Play:
      case ActionType.Discard: {
        const card = state.cards[action.target];
        if (!card) break;
        const slot = removeFromHand(actor, action.target);
        card.holder = -1;
        card.slot = 0;

        const isPlay = action.type === ActionType.Play;
        const playable =
          isKnown(card.identity) && state.playStacks[card.identity.suitIndex] === card.identity.rank - 1;

        if (isPlay && playable) {
          state.playStacks[card.identity.suitIndex] = card.identity.rank;
          state.score++;
          card.location = "played";
          if (card.identity.rank === 5 && state.clueTokens < MAX_CLUE_TOKENS) state.clueTokens++;
        } else if (isPlay && isKnown(card.identity)) {
          state.strikes++;
          card.location = "discarded";
          card.failed = true;
          state.discards.push(card.order);
        } else if (isPlay) {
          // Identity never recorded: keep replaying rather than guessing a strike.
          card.location = "played";
        } else {
          card.location = "discarded";
          state.discards.push(card.order);
          if (state.clueTokens < MAX_CLUE_TOKENS) state.clueTokens++;
        }

        state.log.push({
          actionIndex,
          turn: state.turn,
          playerIndex: actor,
          kind: isPlay ? (playable ? "play" : "bomb") : "discard",
          text: `${players[actor]} ${
            isPlay ? (playable ? "plays" : "misplays") : "discards"
          } ${identityName(variant, card.identity)} (slot ${slot})`,
        });

        if (state.cardsRemaining > 0) {
          draw(actor);
          drew = true;
        }
        break;
      }

      case ActionType.ColorClue:
      case ActionType.RankClue: {
        const clue = clueOf(action)!;
        state.clueTokens = Math.max(0, state.clueTokens - 1);
        const touched = touchedOrders(state, action.target, clue, touchedByAction[actionIndex]);
        applyClue(state, action.target, clue, touched);
        state.log.push({
          actionIndex,
          turn: state.turn,
          playerIndex: actor,
          kind: "clue",
          text: `${players[actor]} clues ${clueName(variant, clue)} to ${players[action.target]} (${
            touched.length
          } card${touched.length === 1 ? "" : "s"})`,
        });
        break;
      }

      case ActionType.EndGame: {
        state.finished = true;
        state.endCondition = action.value;
        state.log.push({
          actionIndex,
          turn: state.turn,
          playerIndex: action.target,
          kind: "end",
          text: `${players[action.target] ?? "Someone"} ended the game`,
        });
        break;
      }
    }

    if (!state.finished) {
      if (state.strikes >= MAX_STRIKES) {
        state.finished = true;
        state.endCondition = EndCondition.Strikeout;
      } else if (state.score >= state.maxScore) {
        state.finished = true;
        state.endCondition = EndCondition.Normal;
      } else if (state.finalRoundLeft !== null) {
        state.finalRoundLeft--;
        if (state.finalRoundLeft <= 0) {
          state.finished = true;
          state.endCondition = EndCondition.Normal;
        }
      } else if (drew && state.cardsRemaining === 0) {
        // Everyone, including whoever took the last card, gets one more turn.
        state.finalRoundLeft = numPlayers;
      }
    }

    state.currentPlayerIndex = (actor + 1) % numPlayers;
    state.turn++;
  }

  for (const hand of state.hands) {
    hand.forEach((order, index) => {
      const card = state.cards[order];
      if (card) card.slot = index + 1;
    });
  }

  return state;
}

/**
 * Which orders a clue touched.
 *
 * Derived from the deck where we know the cards. For clues aimed at our own
 * hidden hand there is nothing to derive from, so the recorder's tap-selection
 * (`override`) is authoritative.
 */
export function touchedOrders(
  state: GameState,
  target: number,
  clue: Clue,
  override?: readonly number[],
): number[] {
  const hand = state.hands[target] ?? [];
  if (override) return hand.filter((order) => override.includes(order));
  return hand.filter((order) => {
    const card = state.cards[order];
    return card !== undefined && isKnown(card.identity) && cardTouched(state.variant, card.identity, clue);
  });
}

function applyClue(state: GameState, target: number, clue: Clue, touched: readonly number[]): void {
  for (const order of state.hands[target] ?? []) {
    const knowledge = state.cards[order]?.knowledge;
    if (!knowledge) continue;
    const hit = touched.includes(order);
    if (hit) knowledge.clued = true;
    const list =
      clue.kind === "color"
        ? hit
          ? knowledge.positiveColors
          : knowledge.negativeColors
        : hit
          ? knowledge.positiveRanks
          : knowledge.negativeRanks;
    if (!list.includes(clue.value)) list.push(clue.value);
  }
}

/** Replays a stored game. */
export function stateOf(record: GameRecord, through?: number): GameState {
  return replay(
    {
      players: record.players,
      ourPlayerIndex: record.ourPlayerIndex,
      variant: getVariant(record.variantName),
      deck: record.deck,
      actions: record.actions,
      touchedByAction: record.touchedByAction,
      options: record.options,
    },
    through,
  );
}

/** Orders that would be touched, for previewing a clue before recording it. */
export function previewClue(state: GameState, target: number, clue: Clue): number[] {
  return touchedOrders(state, target, clue);
}

export function canGiveClue(state: GameState): boolean {
  return !state.finished && state.clueTokens > 0;
}

export function canDiscard(state: GameState): boolean {
  return !state.finished && state.clueTokens < MAX_CLUE_TOKENS;
}

/** hanab.live's pace: how many discards are left before the max score slips away. */
export function pace(state: GameState): number {
  return state.score + state.cardsRemaining + state.players.length - state.maxScore;
}

/** How many copies of an identity have already been discarded or misplayed. */
export function discardedCopies(state: GameState, identity: Identity): number {
  let count = 0;
  for (const order of state.discards) {
    const card = state.cards[order];
    if (
      card &&
      card.identity.suitIndex === identity.suitIndex &&
      card.identity.rank === identity.rank
    ) {
      count++;
    }
  }
  return count;
}

/** True when every copy of an identity is gone, so its suit is capped below it. */
export function isDead(state: GameState, identity: Identity): boolean {
  const total = state.variant.cardCounts[identity.suitIndex]?.[identity.rank - 1] ?? 0;
  return discardedCopies(state, identity) >= total;
}

/** True when one copy is left and the suit still needs it. */
export function isCritical(state: GameState, identity: Identity): boolean {
  const total = state.variant.cardCounts[identity.suitIndex]?.[identity.rank - 1] ?? 0;
  if (state.playStacks[identity.suitIndex] >= identity.rank) return false;
  return total - discardedCopies(state, identity) === 1;
}

export type IdentityStatus = "playable" | "played" | "dead" | "later";

/** Where an identity stands against the board as it is now. */
export function identityStatus(state: GameState, identity: Identity): IdentityStatus {
  const top = state.playStacks[identity.suitIndex] ?? 0;
  if (top >= identity.rank) return "played";
  if (top === identity.rank - 1) return "playable";
  // Unreachable if every copy of some rank between the stack and this one is gone.
  for (let rank = top + 1; rank < identity.rank; rank++) {
    if (isDead(state, { suitIndex: identity.suitIndex, rank })) return "dead";
  }
  return "later";
}
