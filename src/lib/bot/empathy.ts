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
  /**
   * True when the card counts as clued without ever having been clued.
   *
   * A Baton Discard hands a known card over to somebody else, and the receiver
   * treats it as touched from then on: it is off their chop and their finesse
   * position has moved past it.
   */
  touched: boolean;
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
    touched: false,
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
 * Where every copy of every identity has got to, as far as a point of view can
 * tell — scala-bot's `certainMap`.
 *
 * Each entry records where a copy is *and the one seat that cannot tell it is
 * there*, which is the whole of empathy. A card face up on a stack is known to
 * everybody. A card sitting in Bob's hand is known to everybody except Bob, so
 * when the table counts the last b3 into Bob's hand, every other player may
 * strike b3 off their notes and Bob may not — he is the one person who cannot
 * look at it.
 */
interface Placement {
  /** The held card, or -1 for one face up on a stack or in the discard pile. */
  order: number;
  /** The seat that cannot see this copy, or -1 when everyone can. */
  unknownTo: number;
}

/**
 * What a viewer can see of a held card, so far as the bot may say it.
 *
 * `viewer` is whose eyes to look through: a seat index, or `undefined` for the
 * view every seat shares. Three rules, in order.
 *
 * - Nobody sees their own hand, so a card the viewer holds is invisible.
 * - The bot cannot see *our* hand either, and may not report those faces on
 *   another seat's behalf even though that seat is looking right at them. The
 *   exception is a dead deck: once the last card is dealt, our hand is whatever
 *   the piles and the other hands leave over, and counting that is arithmetic
 *   anybody at the table can do rather than a peek.
 * - Otherwise the face is there to be read.
 */
function sightOf(state: GameState, order: number, viewer: number | undefined): Ord | undefined {
  const card = state.cards[order];
  if (!card || card.holder < 0 || !isKnown(card.identity)) return undefined;
  if (card.holder === viewer) return undefined;
  if (card.holder === state.ourPlayerIndex && state.cardsRemaining > 0) return undefined;
  return ordOf(card.identity);
}

/** Every copy the viewer can account for, keyed by identity. */
function placementsOf(
  state: GameState,
  thoughts: Map<number, Thought>,
  viewer: number | undefined,
): Map<Ord, Placement[]> {
  const out = new Map<Ord, Placement[]>();
  const add = (ord: Ord, placement: Placement): void => {
    const list = out.get(ord);
    if (list) list.push(placement);
    else out.set(ord, [placement]);
  };

  for (const card of state.cards) {
    if (!card) continue;
    if (card.location === "played" || card.location === "discarded") {
      if (isKnown(card.identity)) add(ordOf(card.identity), { order: -1, unknownTo: -1 });
      continue;
    }
    if (card.holder < 0) continue;

    // A card the table has already pinned down is placed for everybody, its
    // holder included, so nobody is left in the dark about it.
    const thought = thoughts.get(card.order);
    if (thought && thought.possible.size === 1) {
      add([...thought.possible][0], { order: card.order, unknownTo: -1 });
      continue;
    }

    const seen = sightOf(state, card.order, viewer);
    if (seen !== undefined) add(seen, { order: card.order, unknownTo: card.holder });
  }
  return out;
}

/**
 * Whether a card may still be an identity, given where the copies have got to.
 *
 * Once every copy is accounted for the identity is off the table — except for
 * the card that *is* one of those copies, and except for anyone holding a copy
 * they cannot see. Skipping that second exemption is the classic empathy bug:
 * it hands a player a deduction they had no way of making.
 */
function placeable(
  placements: Map<Ord, Placement[]>,
  copies: number,
  ord: Ord,
  order: number,
  holder: number,
): boolean {
  const placed = placements.get(ord);
  if (!placed || placed.length < copies) return true;
  return placed.some((p) => p.order === order || p.unknownTo === holder);
}

/**
 * Naked groups — the sudoku half of empathy, scala-bot's `performCrossElim`.
 *
 * When a set of cards share a possibility set and between them hold every copy
 * of it, they have used it up: three cards that must be the three remaining 1s
 * say that nothing else is a 1. It is what tells five clued 5s apart when five
 * 5s are left, and no amount of counting copies one at a time will find it.
 *
 * Only `possible` feeds this, never a conventional reading, so a wrong note
 * cannot propagate through it.
 */
function nakedGroups(
  state: GameState,
  thoughts: Map<number, Thought>,
  barred: Map<number, Set<Ord>>,
): boolean {
  const groups = new Map<string, number[]>();
  for (const [order, thought] of thoughts) {
    const card = state.cards[order];
    if (!card || card.holder < 0 || thought.possible.size < 2) continue;
    const key = [...thought.possible].sort((a, b) => a - b).join(",");
    const list = groups.get(key);
    if (list) list.push(order);
    else groups.set(key, [order]);
  }

  let changed = false;
  for (const [key, orders] of groups) {
    const ords = key.split(",").map(Number);
    let copies = 0;
    for (const ord of ords) copies += copiesOf(state.variant, identityOfOrd(ord));
    if (orders.length < copies) continue;

    const inGroup = new Set(orders);
    for (const [order, thought] of thoughts) {
      const card = state.cards[order];
      if (!card || card.holder < 0 || inGroup.has(order)) continue;
      for (const ord of ords) {
        if (!thought.possible.has(ord)) continue;
        let set = barred.get(order);
        if (!set) {
          set = new Set<Ord>();
          barred.set(order, set);
        }
        if (set.has(ord)) continue;
        set.add(ord);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * What one seat can work out about the cards, ours included.
 *
 * The table's shared view is deliberately blind: it counts only what everybody
 * can count. A player is not. Bob looks at three hands, subtracts them from the
 * deck, and knows things about his own cards that no note records — and by the
 * time the deck runs out he can name his whole hand. Reading a move Bob made
 * means asking what *Bob* knew, not what the table did.
 *
 * The answer is exact for our own seat and for anything a dead deck has
 * settled. Elsewhere it is a safe over-estimate: another seat can see our hand
 * and the bot cannot, so where that sight would have narrowed something this
 * leaves it wide. Crediting a player with more possibilities than they really
 * have only ever makes the bot read *less* into what they did.
 */
export function perspectiveOf(
  state: GameState,
  thoughts: Map<number, Thought>,
  seat: number,
): Map<number, Set<Ord>> {
  const view = new Map<number, Set<Ord>>();
  const counts = new Map<Ord, number>();
  for (const identity of allIdentities(state.variant)) {
    counts.set(ordOf(identity), copiesOf(state.variant, identity));
  }
  const spend = (from: Map<Ord, number>, ord: Ord): void => {
    from.set(ord, (from.get(ord) ?? 0) - 1);
  };

  for (const card of state.cards) {
    if (!card) continue;
    if (card.location === "played" || card.location === "discarded") {
      if (isKnown(card.identity)) spend(counts, ordOf(card.identity));
      continue;
    }
    if (card.holder < 0) continue;

    const thought = thoughts.get(card.order);
    const pool = new Set<Ord>(thought ? thought.possible : []);
    if (card.holder === seat) {
      // Counted in the pass below, as the seat narrows their own hand down.
      view.set(card.order, pool);
      continue;
    }

    const seen = sightOf(state, card.order, seat);
    if (seen !== undefined) {
      spend(counts, seen);
      view.set(card.order, new Set([seen]));
      continue;
    }
    // A hand the bot may not look at either. The seat can see it and we cannot,
    // so the honest answer is whatever the table already made of the card.
    if (pool.size === 1) spend(counts, [...pool][0]);
    view.set(card.order, pool);
  }

  // Settling one of the seat's own cards frees a copy for the next, so this
  // repeats: two clued cards that could each be one of two 5s name each other.
  const hand = handOrders(state, seat);
  for (let pass = 0; pass < hand.length + 1; pass++) {
    const left = new Map(counts);
    for (const order of hand) {
      const pool = view.get(order);
      if (pool?.size === 1) spend(left, [...pool][0]);
    }

    let changed = false;
    for (const order of hand) {
      const pool = view.get(order);
      if (!pool || pool.size <= 1) continue;
      const next = new Set<Ord>();
      for (const ord of pool) if ((left.get(ord) ?? 0) > 0) next.add(ord);
      if (next.size === 0 || next.size === pool.size) continue;
      view.set(order, next);
      changed = true;
    }
    if (!changed) break;
  }
  return view;
}

/**
 * Rebuilds every held card's `possible` set from the clues and the count.
 *
 * Repeats until nothing more drops out, because settling one card frees the
 * count for the next — three clued 1s in a hand where the fourth 1 is discarded
 * tell each other apart this way.
 *
 * The count is the table's, not ours: `placementsOf` decides which copies the
 * shared view may spend and, for each one, which single seat has to be let off
 * spending it. Naked groups run on top, and their findings are remembered in
 * `barred` across passes because rebuilding from the clues alone would hand
 * back what they just took away.
 */
export function refreshPossible(state: GameState, thoughts: Map<number, Thought>): void {
  const variant = state.variant;
  const identities = allIdentities(variant);
  const barred = new Map<number, Set<Ord>>();

  for (let pass = 0; pass < 6; pass++) {
    const placements = placementsOf(state, thoughts, undefined);
    let changed = false;

    for (const thought of thoughts.values()) {
      const card = state.cards[thought.order];
      if (!card || card.holder < 0) continue;

      const allowed = barred.get(thought.order);
      const next = new Set<Ord>();
      for (const identity of identities) {
        const ord = ordOf(identity);
        if (!matchesKnowledge(variant, identity, card.knowledge)) continue;
        if (allowed?.has(ord)) continue;
        const copies = copiesOf(variant, identity);
        if (!placeable(placements, copies, ord, thought.order, card.holder)) continue;
        next.add(ord);
      }

      // Counting the copies has contradicted the clues, which means the record
      // itself is wrong — a mis-entered card, most likely. The clues are the
      // part a player can be sure of, so keep those and let the count go.
      if (next.size === 0) {
        for (const identity of identities) {
          if (matchesKnowledge(variant, identity, card.knowledge)) next.add(ordOf(identity));
        }
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

    if (nakedGroups(state, thoughts, barred)) changed = true;
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
    const thought = thoughts.get(order);
    if (thought?.touched) continue;
    if (thought?.status === "chop moved") continue;
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
    const thought = thoughts.get(order);
    if (thought?.touched) continue;
    const status = thought?.status;
    if (status === "chop moved" || status === "finessed") continue;
    return order;
  }
  return undefined;
}
