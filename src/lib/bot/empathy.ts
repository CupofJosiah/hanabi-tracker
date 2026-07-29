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

/**
 * The conventional label a card is carrying, from scala-bot's `CardStatus`.
 *
 * `saved` is the one addition. scala-bot has no such status because a save is
 * the *absence* of a play promise on a clued card — being clued already lifts a
 * card off the chop, so nothing needs recording. That is true of the mechanics
 * but useless to read: "saved" and "carries no instruction" are the same state
 * with very different meanings at a table, and a save says something the other
 * does not — that the card is one of the identities worth saving.
 */
export type CardStatus =
  | "none"
  | "called to play"
  | "finessed"
  | "chop moved"
  | "saved"
  | "called to discard";

export interface Thought {
  order: number;
  /** Identities still consistent with the clues and with the cards everyone can count. */
  possible: Set<Ord>;
  /** `possible` narrowed by conventions. May be empty when a clue made no sense. */
  inferred: Set<Ord>;
  status: CardStatus;
  /**
   * True when the card must play *through* something else first — the covered
   * layer of a layered finesse. It is blind-playing, but not the card that was
   * promised, so nothing may be concluded about the promise from it.
   */
  hidden: boolean;
  /** True when the blind play is a different suit entirely: a bluff. */
  bluffed: boolean;
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
    hidden: false,
    bluffed: false,
    focused: false,
    reset: false,
    narrowed: false,
    overridden: false,
    drawnTurn,
  };
}

/** Puts a card back to meaning nothing in particular. */
export function resetThought(thought: Thought): void {
  thought.status = "none";
  thought.hidden = false;
  thought.bluffed = false;
  thought.narrowed = false;
  thought.inferred = new Set(thought.possible);
}

/** True while the card is one the table is counting on to play. */
export function isBlindPlaying(thought: Thought): boolean {
  return thought.status === "finessed";
}

export function isPlayPromised(thought: Thought): boolean {
  return thought.status === "called to play" || thought.status === "finessed";
}

/** The inferences if there are any, else the raw possibilities — scala-bot's `possibilities`. */
export function possibilities(thought: Thought): Set<Ord> {
  return thought.inferred.size > 0 ? thought.inferred : thought.possible;
}

/**
 * A card's identity as the bot is allowed to see it, as an ordinal.
 *
 * The bot plays as the recorder, and the recorder cannot see their own hand —
 * that is the game. A finished game record fills those cards in after the fact,
 * so reading them straight off the deck would let the bot find connections the
 * recorder could never have found, and reject ones they would have made. Every
 * question about what a card *really* is has to go through here.
 *
 * Played and discarded cards are face up, so they stay visible.
 */
export function visibleOrd(state: GameState, order: number): Ord | undefined {
  const card = state.cards[order];
  if (!card || !isKnown(card.identity)) return undefined;
  if (card.holder === state.ourPlayerIndex) return undefined;
  return ordOf(card.identity);
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
  return playableAgainst(state.playStacks);
}

/** Ordinals playable against an arbitrary set of stacks — real or hypothetical. */
export function playableAgainst(stacks: readonly number[]): Set<Ord> {
  const out = new Set<Ord>();
  for (let suitIndex = 0; suitIndex < stacks.length; suitIndex++) {
    const rank = stacks[suitIndex] + 1;
    if (rank <= 5) out.add(ordOf({ suitIndex, rank }));
  }
  return out;
}

/**
 * The stacks as they will stand once everything already promised has played.
 *
 * scala-bot's `hypoStacks`, and the reason a chain of connections can be found
 * at all: once r1 is called to play, r2 counts as reachable, so a clue on r3
 * can be read as "r2 is prompted, r1 is already coming". Without this the bot
 * only ever sees one rank past the real stacks and every deeper clue reads as
 * nonsense.
 *
 * Only cards narrowed to a single identity advance a stack. A card that could
 * be either of two playables tells the table it will play, but not what onto.
 */
export function hypoStacks(
  state: GameState,
  thoughts: Map<number, Thought>,
  exclude: ReadonlySet<number> = new Set(),
): number[] {
  const stacks = [...state.playStacks];
  const promised: Ord[] = [];
  for (const [order, thought] of thoughts) {
    if (exclude.has(order)) continue;
    const card = state.cards[order];
    if (!card || card.holder < 0 || !isPlayPromised(thought)) continue;
    const pool = possibilities(thought);
    if (pool.size === 1) promised.push([...pool][0]);
  }

  // Repeat rather than sort: the promises are unordered, and r1 may only become
  // placeable after r2's holder has been counted.
  for (let pass = 0; pass < promised.length + 1; pass++) {
    let changed = false;
    for (const ord of promised) {
      const identity = identityOfOrd(ord);
      if (stacks[identity.suitIndex] !== identity.rank - 1) continue;
      stacks[identity.suitIndex] = identity.rank;
      changed = true;
    }
    if (!changed) break;
  }
  return stacks;
}

/**
 * Ordinals a clue could sensibly be protecting: the last copy of anything, and
 * the 5s and 2s that convention saves on sight.
 *
 * Used when you tell the bot a card was saved, to work out what that says about
 * which card it is.
 */
export function worthSavingOrds(state: GameState): Set<Ord> {
  const out = new Set<Ord>(criticalOrds(state));
  for (const identity of allIdentities(state.variant)) {
    if (state.playStacks[identity.suitIndex] >= identity.rank) continue;
    if (identity.rank === 5 || identity.rank === 2) out.add(ordOf(identity));
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
      const held = thought.narrowed ? intersect(thought.inferred, next) : new Set(next);

      if (held.size > 0) {
        thought.inferred = held;
        continue;
      }

      // The reading and the count now contradict each other, so the reading was
      // wrong. Keeping an empty note would leave the card reading `??` for the
      // rest of the game; the honest thing is to let go of the reading and say
      // what the clues alone still allow.
      thought.inferred = new Set(next);
      thought.narrowed = false;
      thought.reset = true;
      thought.status = "none";
      changed = true;
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
  //
  // Only when the first card really is it, though. A card the table has *read*
  // as b2 while we can see it is a b3 is not holding b2, and striking b2 off
  // every other card would let one wrong reading spread through the rest of the
  // game. Cards we cannot see — our own — are taken at the table's word.
  const claimed = new Set<Ord>();
  for (const thought of thoughts.values()) {
    const card = state.cards[thought.order];
    if (!card || card.holder < 0 || !card.knowledge.clued) continue;
    if (thought.inferred.size !== 1) continue;
    const ord = [...thought.inferred][0];
    const seen = visibleOrd(state, thought.order);
    if (seen !== undefined && seen !== ord) continue;
    claimed.add(ord);
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

/**
 * The finesse position: the newest card carrying no information.
 *
 * `taken` holds orders already spoken for by connections found so far, so a
 * clue asking for two blind plays from one hand walks down the hand rather than
 * naming the same card twice.
 */
export function finessePosition(
  state: GameState,
  thoughts: Map<number, Thought>,
  playerIndex: number,
  taken: ReadonlySet<number> = new Set(),
): number | undefined {
  for (const order of handOrders(state, playerIndex)) {
    const card = state.cards[order];
    if (!card || card.knowledge.clued || taken.has(order)) continue;
    const status = thoughts.get(order)?.status;
    if (status === "chop moved" || status === "finessed") continue;
    return order;
  }
  return undefined;
}
