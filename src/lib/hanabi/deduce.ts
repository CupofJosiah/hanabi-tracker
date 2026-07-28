/**
 * What a hidden card could still be.
 *
 * The recorder sees every hand except their own, so an unknown card is
 * constrained twice over: by the copies nobody has seen yet, and by the clues
 * that have touched (or pointedly missed) it.
 */
import { isKnown, type Identity } from "./types";
import type { CardKnowledge, GameState } from "./engine";
import { allIdentities, cardTouched, copiesOf, type Variant } from "./variants";

export function identityKey(identity: Identity): string {
  return `${identity.suitIndex}:${identity.rank}`;
}

/** Copies of each identity we have not seen anywhere, keyed by `identityKey`. */
export function unseenCounts(state: GameState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const identity of allIdentities(state.variant)) {
    counts.set(identityKey(identity), copiesOf(state.variant, identity));
  }
  for (const card of state.cards) {
    if (!card || !isKnown(card.identity)) continue;
    const key = identityKey(card.identity);
    counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
  }
  return counts;
}

/** How many copies of an identity are still unaccounted for. */
export function unseenCopies(state: GameState, identity: Identity): number {
  return unseenCounts(state).get(identityKey(identity)) ?? 0;
}

/**
 * Unseen counts as if one card had never been entered, for correcting a card
 * that was recorded wrong. Without crediting its own identity back, a card
 * would block itself from being changed to something it already claims to be.
 */
export function countsForCorrection(state: GameState, order: number): Map<string, number> {
  const counts = unseenCounts(state);
  const identity = state.cards[order]?.identity;
  if (identity && isKnown(identity)) {
    const key = identityKey(identity);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function matchesKnowledge(
  variant: Variant,
  identity: Identity,
  knowledge: CardKnowledge,
): boolean {
  for (const value of knowledge.positiveColors) {
    if (!cardTouched(variant, identity, { kind: "color", value })) return false;
  }
  for (const value of knowledge.negativeColors) {
    if (cardTouched(variant, identity, { kind: "color", value })) return false;
  }
  for (const value of knowledge.positiveRanks) {
    if (!cardTouched(variant, identity, { kind: "rank", value })) return false;
  }
  for (const value of knowledge.negativeRanks) {
    if (cardTouched(variant, identity, { kind: "rank", value })) return false;
  }
  return true;
}

/**
 * Identities a hidden card could hold, given unseen copies and its clues.
 *
 * Returns an empty list for a card whose identity we already know.
 */
export function possibleIdentities(
  state: GameState,
  order: number,
  counts = unseenCounts(state),
): Identity[] {
  const card = state.cards[order];
  if (!card || isKnown(card.identity)) return [];
  return allIdentities(state.variant).filter(
    (identity) =>
      (counts.get(identityKey(identity)) ?? 0) > 0 &&
      matchesKnowledge(state.variant, identity, card.knowledge),
  );
}

export interface HolderView {
  /** The seat this is seen from — whoever is holding the card. */
  viewer: number;
  /** What the holder can narrow their card down to. */
  possibilities: Identity[];
  /**
   * True when the holder can see cards we cannot — ours — so they may have
   * ruled out more than this. Goes away once our own hand is filled in.
   */
  approximate: boolean;
}

/**
 * What the player holding a card can work out about it.
 *
 * They cannot see their own hand, so their pool is every identity minus the
 * copies visible *to them*: the other hands, the stacks and the discards. That
 * is then narrowed by the clues that touched (and pointedly missed) the card.
 *
 * Answers the question that actually matters at the table — "did that clue tell
 * them what I meant?" — rather than what we happen to know.
 */
export function holderView(state: GameState, order: number): HolderView | undefined {
  const card = state.cards[order];
  if (!card || card.holder < 0) return undefined;
  const viewer = card.holder;

  const counts = new Map<string, number>();
  for (const identity of allIdentities(state.variant)) {
    counts.set(identityKey(identity), copiesOf(state.variant, identity));
  }

  let approximate = false;
  for (const other of state.cards) {
    if (!other) continue;
    if (!isKnown(other.identity)) {
      // A card the holder can see but we cannot weakens this estimate.
      if (other.holder >= 0 && other.holder !== viewer) approximate = true;
      continue;
    }
    if (other.holder === viewer) continue; // hidden from the holder, including this card
    const key = identityKey(other.identity);
    counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
  }

  return {
    viewer,
    approximate,
    possibilities: allIdentities(state.variant).filter(
      (identity) =>
        (counts.get(identityKey(identity)) ?? 0) > 0 &&
        matchesKnowledge(state.variant, identity, card.knowledge),
    ),
  };
}

export interface UnknownCard {
  order: number;
  /** Seat holding it, or -1 if it has already been played or discarded. */
  holder: number;
  slot: number;
  possibilities: Identity[];
}

/**
 * Every card we still have not identified, with what it could be.
 *
 * Drives the post-game fill-in screen: after the hands go face up you can
 * complete the deck, and most cards will have only a handful of candidates.
 */
export function unknownCards(state: GameState): UnknownCard[] {
  const counts = unseenCounts(state);
  const result: UnknownCard[] = [];
  for (const card of state.cards) {
    if (!card || isKnown(card.identity)) continue;
    result.push({
      order: card.order,
      holder: card.holder,
      slot: card.slot,
      possibilities: possibleIdentities(state, card.order, counts),
    });
  }
  return result;
}

/**
 * Fills in every unknown card that has exactly one candidate, repeating until
 * nothing more can be settled. Returns the identities to write, keyed by order.
 *
 * Cheap constraint propagation, not a full solver — it will not crack a case
 * where two cards share two candidates, and does not try to.
 */
export function autoResolve(state: GameState): Map<number, Identity> {
  const resolved = new Map<number, Identity>();
  const counts = unseenCounts(state);
  const pending = new Map<number, CardKnowledge>();
  for (const card of state.cards) {
    if (card && !isKnown(card.identity)) pending.set(card.order, card.knowledge);
  }

  let progress = true;
  while (progress) {
    progress = false;
    for (const [order, knowledge] of pending) {
      const candidates = allIdentities(state.variant).filter(
        (identity) =>
          (counts.get(identityKey(identity)) ?? 0) > 0 &&
          matchesKnowledge(state.variant, identity, knowledge),
      );
      if (candidates.length !== 1) continue;
      const identity = candidates[0];
      resolved.set(order, identity);
      const key = identityKey(identity);
      counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
      pending.delete(order);
      progress = true;
    }
  }

  return resolved;
}
