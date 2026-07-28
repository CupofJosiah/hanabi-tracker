/**
 * What the table collectively knows about each card.
 *
 * This is scala-bot's `common` player: the view built only from information
 * every seat shares — the clues given, the cards on the stacks and in the
 * discard pile, and whatever has been narrowed to a single identity. It is
 * deliberately *not* our view. A note has to mean the same thing to the person
 * holding the card as it does to us, or it is not a convention, it is a peek.
 *
 * Identities are handled as ordinals (`suitIndex * 5 + rank - 1`) so the sets
 * are cheap to intersect and subtract.
 */
import type { CardKnowledge, GameState } from "../hanabi/engine";
import { isKnown, type Identity } from "../hanabi/types";
import { allIdentities, copiesOf, type Variant } from "../hanabi/variants";
import { matchesKnowledge } from "../hanabi/deduce";

export type Ord = number;

export function ordOf(identity: Identity): Ord {
  return identity.suitIndex * 5 + (identity.rank - 1);
}

export function identityOfOrd(ord: Ord): Identity {
  return { suitIndex: Math.floor(ord / 5), rank: (ord % 5) + 1 };
}

/** Every ordinal the variant contains, ascending. */
export function allOrds(variant: Variant): Ord[] {
  return allIdentities(variant).map(ordOf);
}

export function intersect(a: ReadonlySet<Ord>, b: ReadonlySet<Ord>): Set<Ord> {
  const out = new Set<Ord>();
  for (const ord of a) if (b.has(ord)) out.add(ord);
  return out;
}

export function difference(a: ReadonlySet<Ord>, b: ReadonlySet<Ord>): Set<Ord> {
  const out = new Set<Ord>();
  for (const ord of a) if (!b.has(ord)) out.add(ord);
  return out;
}

/** The conventional label a card is carrying, from scala-bot's `CardStatus`. */
export type CardStatus =
  | "none"
  | "called to play"
  | "finessed"
  | "chop moved"
  | "called to discard";

export interface Thought {
  order: number;
  /** Identities still consistent with the clues and with the cards everyone can count. */
  possible: Set<Ord>;
  /** `possible` narrowed by conventions. May be empty when a clue made no sense. */
  inferred: Set<Ord>;
  status: CardStatus;
  /** True once this card was focused by a clue, which is what promises anything. */
  focused: boolean;
  /** True when its inferences were wiped by a fix clue; stops re-inferring. */
  reset: boolean;
  /**
   * True once a convention has narrowed `inferred` below `possible`.
   *
   * Until then the two track each other, so a card drawn into a hand starts by
   * being able to be anything rather than nothing. Only conventional readings
   * set this — Good Touch re-derives itself from `possible` every pass, so it
   * stays self-healing when the count changes underneath it.
   */
  narrowed: boolean;
  /** True when you overruled the bot on this card, so the UI can say so. */
  overridden: boolean;
  /** Turn the card was drawn, for finding the newest card in a hand. */
  drawnTurn: number;
}

export function newThought(order: number, possible: Set<Ord>, drawnTurn: number): Thought {
  return {
    order,
    possible,
    inferred: new Set(possible),
    status: "none",
    focused: false,
    reset: false,
    narrowed: false,
    overridden: false,
    drawnTurn,
  };
}

/** The inferences if there are any, else the raw possibilities — scala-bot's `possibilities`. */
export function possibilities(thought: Thought): Set<Ord> {
  return thought.inferred.size > 0 ? thought.inferred : thought.possible;
}

/** The identity when it is pinned down to exactly one, else undefined. */
export function settled(thought: Thought): Identity | undefined {
  if (thought.possible.size === 1) return identityOfOrd([...thought.possible][0]);
  if (thought.inferred.size === 1) return identityOfOrd([...thought.inferred][0]);
  return undefined;
}

/** Ordinals that are already on the stacks — playing one again is throwing it away. */
export function trashOrds(state: GameState): Set<Ord> {
  const out = new Set<Ord>();
  for (const identity of allIdentities(state.variant)) {
    if (state.playStacks[identity.suitIndex] >= identity.rank) out.add(ordOf(identity));
  }
  return out;
}

/** Ordinals that would go straight onto a stack right now. */
export function playableOrds(state: GameState): Set<Ord> {
  const out = new Set<Ord>();
  for (let suitIndex = 0; suitIndex < state.variant.suits.length; suitIndex++) {
    const rank = state.playStacks[suitIndex] + 1;
    if (rank <= 5) out.add(ordOf({ suitIndex, rank }));
  }
  return out;
}

/** Ordinals with exactly one copy left that the stacks still want. */
export function criticalOrds(state: GameState): Set<Ord> {
  const discarded = new Map<Ord, number>();
  for (const order of state.discards) {
    const card = state.cards[order];
    if (!card || !isKnown(card.identity)) continue;
    const ord = ordOf(card.identity);
    discarded.set(ord, (discarded.get(ord) ?? 0) + 1);
  }

  const out = new Set<Ord>();
  for (const identity of allIdentities(state.variant)) {
    if (state.playStacks[identity.suitIndex] >= identity.rank) continue;
    const total = copiesOf(state.variant, identity);
    if (total - (discarded.get(ordOf(identity)) ?? 0) === 1) out.add(ordOf(identity));
  }
  return out;
}

/**
 * Copies of each identity that common knowledge cannot yet place.
 *
 * Counts down the stacks and the discard pile — visible to everyone — and then
 * any card the table has already narrowed to one identity. Held cards whose
 * faces only *we* can see are deliberately not counted: the point of view here
 * is the one every player shares.
 */
function commonCounts(state: GameState, thoughts: Map<number, Thought>): Map<Ord, number> {
  const counts = new Map<Ord, number>();
  for (const identity of allIdentities(state.variant)) {
    counts.set(ordOf(identity), copiesOf(state.variant, identity));
  }

  const spend = (identity: Identity): void => {
    if (!isKnown(identity)) return;
    const ord = ordOf(identity);
    counts.set(ord, Math.max(0, (counts.get(ord) ?? 0) - 1));
  };

  for (const card of state.cards) {
    if (!card) continue;
    if (card.location === "played" || card.location === "discarded") spend(card.identity);
  }
  for (const thought of thoughts.values()) {
    if (thought.possible.size === 1) spend(identityOfOrd([...thought.possible][0]));
  }

  return counts;
}

/**
 * Rebuilds every held card's `possible` set from the clues and the count.
 *
 * Repeats until nothing more drops out, because settling one card frees the
 * count for the next — three clued 1s in a hand where the fourth 1 is discarded
 * tell each other apart this way.
 */
export function refreshPossible(state: GameState, thoughts: Map<number, Thought>): void {
  const variant = state.variant;
  const identities = allIdentities(variant);

  for (let pass = 0; pass < 6; pass++) {
    const counts = commonCounts(state, thoughts);
    let changed = false;

    for (const thought of thoughts.values()) {
      const card = state.cards[thought.order];
      if (!card || card.holder < 0) continue;

      const next = new Set<Ord>();
      for (const identity of identities) {
        const ord = ordOf(identity);
        // A card is always allowed to be what it has already been settled as.
        const available = (counts.get(ord) ?? 0) > 0 || thought.possible.size === 1;
        if (available && matchesKnowledge(variant, identity, card.knowledge)) next.add(ord);
      }

      if (next.size !== thought.possible.size) changed = true;
      thought.possible = next;
      // A card no convention has spoken about can be anything it could be; one
      // that has been read is held to that reading, narrowed by the new count.
      thought.inferred = thought.narrowed ? intersect(thought.inferred, next) : new Set(next);
    }

    if (!changed) break;
  }
}

/**
 * Good Touch Principle: a card someone bothered to touch is not trash.
 *
 * Drops identities already on the stacks, and identities held by another
 * *clued* card — a convention-abiding table does not touch the same card twice,
 * so two clued cards that could both be g3 are telling you they are not both.
 */
export function applyGoodTouch(
  state: GameState,
  thoughts: Map<number, Thought>,
  enabled: boolean,
): void {
  if (!enabled) return;
  const trash = trashOrds(state);

  for (const thought of thoughts.values()) {
    const card = state.cards[thought.order];
    if (!card || card.holder < 0 || !card.knowledge.clued) continue;
    // A card whose every possibility is trash is telling you it is trash; the
    // clue was a fix or a chop move, and pruning would leave nothing at all.
    const kept = difference(thought.inferred, trash);
    if (kept.size > 0) thought.inferred = kept;
  }

  // A second copy of an identity that some other clued card is already known to
  // be cannot also be that identity.
  const claimed = new Set<Ord>();
  for (const thought of thoughts.values()) {
    const card = state.cards[thought.order];
    if (!card || card.holder < 0 || !card.knowledge.clued) continue;
    if (thought.inferred.size === 1) claimed.add([...thought.inferred][0]);
  }
  for (const thought of thoughts.values()) {
    const card = state.cards[thought.order];
    if (!card || card.holder < 0 || !card.knowledge.clued) continue;
    if (thought.inferred.size <= 1) continue;
    const kept = difference(thought.inferred, claimed);
    if (kept.size > 0) thought.inferred = kept;
  }
}

/** Cards in a seat's hand, newest (slot 1) first — the same order as the board. */
export function handOrders(state: GameState, playerIndex: number): number[] {
  return state.hands[playerIndex] ?? [];
}

/**
 * The chop: the oldest card carrying no information at all.
 *
 * Chop-moved cards are skipped, which is the whole point of a chop move.
 */
export function chopOf(
  state: GameState,
  thoughts: Map<number, Thought>,
  playerIndex: number,
): number | undefined {
  const hand = handOrders(state, playerIndex);
  for (let i = hand.length - 1; i >= 0; i--) {
    const order = hand[i];
    const card = state.cards[order];
    if (!card || card.knowledge.clued) continue;
    if (thoughts.get(order)?.status === "chop moved") continue;
    return order;
  }
  return undefined;
}

/** The finesse position: the newest card carrying no information. */
export function finessePosition(
  state: GameState,
  thoughts: Map<number, Thought>,
  playerIndex: number,
): number | undefined {
  for (const order of handOrders(state, playerIndex)) {
    const card = state.cards[order];
    if (!card || card.knowledge.clued) continue;
    const status = thoughts.get(order)?.status;
    if (status === "chop moved" || status === "finessed") continue;
    return order;
  }
  return undefined;
}
