/**
 * Finding the cards that have to play before a clued card can.
 *
 * This is scala-bot's `hgroup/connect.scala`, which is where prompts, finesses,
 * layered finesses and bluffs actually come from. A clue on an unplayable card
 * only makes sense if the table can see how it becomes playable, and that
 * "how" is a list of connections.
 *
 * The rules that matter, all of them scala-bot's:
 *
 * - **The giver is never a connection.** They can see their own clue; asking
 *   them to blind-play into it says nothing.
 * - **Seats are searched backwards from the giver**, so the player with the
 *   least time to act is considered first and the player about to move last.
 * - **The target cannot connect to themselves when the clue looks direct.** A
 *   colour clue, or a clue that could be a save, reads as being about the card
 *   it touched; only once that reading is impossible does the receiver start
 *   looking in their own hand.
 * - **A finesse must be possible.** A card negatively clued out of being r1
 *   cannot be asked to blind-play r1, even though nobody can see it.
 */
import type { GameState } from "../hanabi/engine";
import { isKnown, type Identity } from "../hanabi/types";
import { cardTouched } from "../hanabi/variants";
import { levelAllows, type BotSettings } from "./conventions";
import {
  handOrders,
  identityOfOrd,
  isPlayPromised,
  ordOf,
  playableAgainst,
  possibilities,
  type Ord,
  type Thought,
} from "./empathy";

export type ConnectionKind = "known" | "playable" | "prompt" | "finesse";

export interface Connection {
  kind: ConnectionKind;
  playerIndex: number;
  /** -1 for a card already promised elsewhere and not worth naming again. */
  order: number;
  identity: Ord;
  /**
   * True when this card is not the promised identity but something that has to
   * come off first — the covered layer of a layered finesse.
   */
  hidden: boolean;
  /** True when the blind play is a different suit: a bluff (level 11). */
  bluff: boolean;
  /** True when we cannot see the card, so the link is taken on trust. */
  assumed: boolean;
}

/** One complete reading of a clue: an identity, and the work it takes to reach it. */
export interface FocusPossibility {
  identity: Ord;
  connections: Connection[];
  /** True when this reading is "hold onto it", not "play it". */
  save: boolean;
}

export interface ConnectContext {
  /** The board *after* the clue, which is what everyone reasons from. */
  state: GameState;
  thoughts: Map<number, Thought>;
  giver: number;
  target: number;
  focus: number;
  settings: BotSettings;
  /**
   * True when the clue reads as being about the card it touched, which stops
   * the receiver looking in their own hand for the connection.
   */
  looksDirect: boolean;
  /** Stacks once everything already promised has played. */
  stacks: number[];
}

/** Seats in scala-bot's search order: backwards from the giver, giver excluded. */
export function connectionSeats(numPlayers: number, giver: number): number[] {
  return Array.from({ length: numPlayers - 1 }, (_, i) => (giver - i - 1 + numPlayers) % numPlayers);
}

function heldThought(
  ctx: ConnectContext,
  order: number,
): { card: NonNullable<GameState["cards"][number]>; thought: Thought } | undefined {
  const card = ctx.state.cards[order];
  const thought = ctx.thoughts.get(order);
  if (!card || !thought || card.holder < 0) return undefined;
  return { card, thought };
}

/**
 * A card the whole table already knows is that identity and going to play.
 *
 * Costs nothing: nobody has to work anything out, so it does not count against
 * a reading under Occam's razor.
 */
function findKnown(ctx: ConnectContext, needed: Ord, taken: ReadonlySet<number>): Connection | undefined {
  for (let seat = 0; seat < ctx.state.players.length; seat++) {
    for (const order of handOrders(ctx.state, seat)) {
      if (taken.has(order)) continue;
      const held = heldThought(ctx, order);
      if (!held) continue;
      const pool = possibilities(held.thought);
      if (pool.size !== 1 || !pool.has(needed)) continue;
      // Known to be the card, and either promised or plainly playable.
      const playable = playableAgainst(ctx.stacks).has(needed);
      if (!isPlayPromised(held.thought) && !playable) continue;
      // A card we can see is only a connection if it really is that card.
      if (isKnown(held.card.identity) && ordOf(held.card.identity) !== needed) continue;
      return {
        kind: "known",
        playerIndex: seat,
        order,
        identity: needed,
        hidden: false,
        bluff: false,
        assumed: !isKnown(held.card.identity),
      };
    }
  }
  return undefined;
}

/**
 * A clued card that could be the missing identity — the prompt.
 *
 * Of the cards that fit, the one carrying the most clues is prompted, which is
 * scala-bot's tie-break and matches how a table reads it: the most-specified
 * card is the one being pointed at.
 */
function findPrompt(
  ctx: ConnectContext,
  seat: number,
  needed: Ord,
  taken: ReadonlySet<number>,
): Connection | undefined {
  const identity = identityOfOrd(needed);
  let best: { order: number; clues: number } | undefined;

  for (const order of handOrders(ctx.state, seat)) {
    if (taken.has(order) || order === ctx.focus) continue;
    const held = heldThought(ctx, order);
    if (!held || !held.card.knowledge.clued) continue;
    const { card, thought } = held;
    if (!thought.possible.has(needed)) continue;
    // Info-locked onto something else: it cannot be quietly re-read.
    if (thought.inferred.size === 1 && !thought.inferred.has(needed)) continue;
    // At least one clue on the card has to actually match the identity, or it
    // is not the card being pointed at.
    if (!cluesMatch(ctx.state, card.knowledge, identity)) continue;
    if (isKnown(card.identity) && ordOf(card.identity) !== needed) {
      // A prompt onto the wrong card still works if what is really there plays
      // first — that is a layered prompt, and it is level 5 material.
      if (!levelAllows(ctx.settings, 5)) continue;
      const top = ctx.stacks[card.identity.suitIndex] ?? 0;
      if (top !== card.identity.rank - 1) continue;
      return {
        kind: "prompt",
        playerIndex: seat,
        order,
        identity: ordOf(card.identity),
        hidden: true,
        bluff: false,
        assumed: false,
      };
    }

    const clues = countClues(card.knowledge);
    if (!best || clues > best.clues) best = { order, clues };
  }

  if (!best) return undefined;
  const card = ctx.state.cards[best.order];
  return {
    kind: "prompt",
    playerIndex: seat,
    order: best.order,
    identity: needed,
    hidden: false,
    bluff: false,
    assumed: !card || !isKnown(card.identity),
  };
}

function countClues(knowledge: GameState["cards"][number]["knowledge"]): number {
  return knowledge.positiveColors.length + knowledge.positiveRanks.length;
}

function cluesMatch(
  state: GameState,
  knowledge: GameState["cards"][number]["knowledge"],
  identity: Identity,
): boolean {
  for (const value of knowledge.positiveColors) {
    if (!cardTouched(state.variant, identity, { kind: "color", value })) return false;
  }
  for (const value of knowledge.positiveRanks) {
    if (!cardTouched(state.variant, identity, { kind: "rank", value })) return false;
  }
  return knowledge.positiveColors.length + knowledge.positiveRanks.length > 0;
}

/**
 * The finesse: the newest untouched card in a hand, asked to play blind.
 *
 * Two things can be sitting there. The card itself, which is the plain finesse.
 * Or something else that is playable right now, which at level 5 is a layered
 * finesse: it comes off first and the promised card is underneath it.
 *
 * A bluff is the same shape seen from the other side — the blind play happens
 * but the promise was never about that card. Nothing here can tell the two
 * apart, because from common knowledge they are the same clue; the difference
 * is written onto the blind-playing card instead (`assignConnections`).
 */
function findFinesse(
  ctx: ConnectContext,
  seat: number,
  needed: Ord,
  taken: ReadonlySet<number>,
): Connection | undefined {
  if (!levelAllows(ctx.settings, 2)) return undefined;

  for (const order of handOrders(ctx.state, seat)) {
    if (taken.has(order) || order === ctx.focus) continue;
    const held = heldThought(ctx, order);
    if (!held) continue;
    const { card, thought } = held;
    if (card.knowledge.clued) continue;
    if (thought.status === "chop moved") continue;
    // Already blind-playing something else: it is spoken for.
    if (thought.status === "finessed" && !thought.inferred.has(needed)) break;

    // A card negatively clued out of the identity cannot be finessed as it,
    // however invisible it is to its holder.
    const couldBe = thought.possible.has(needed);

    if (!isKnown(card.identity)) {
      // Our own hand: nothing to check it against, so it is taken on trust.
      if (!couldBe) break;
      return {
        kind: "finesse",
        playerIndex: seat,
        order,
        identity: needed,
        hidden: false,
        bluff: false,
        assumed: true,
      };
    }

    if (ordOf(card.identity) === needed) {
      if (!couldBe) break;
      return {
        kind: "finesse",
        playerIndex: seat,
        order,
        identity: needed,
        hidden: false,
        bluff: false,
        assumed: false,
      };
    }

    // Something else playable is sitting in front of it: a layered finesse.
    // The layer is a connection in its own right — it has to go down first and
    // its holder has to be told so — but it does not supply the missing rank,
    // which is what `hidden` means to the caller.
    const top = ctx.stacks[card.identity.suitIndex] ?? 0;
    if (top !== card.identity.rank - 1 || !levelAllows(ctx.settings, 5)) break;
    return {
      kind: "finesse",
      playerIndex: seat,
      order,
      identity: ordOf(card.identity),
      hidden: true,
      bluff: false,
      assumed: false,
    };
  }
  return undefined;
}

/**
 * True when a seat may not be asked to supply this connection.
 *
 * The giver never can. The target cannot connect to themselves while the clue
 * still reads as being about the card it touched — that is the rule that keeps
 * a colour clue meaning "this is the playable one" rather than "blind-play the
 * card underneath it".
 */
function skipSeat(ctx: ConnectContext, seat: number): boolean {
  if (seat === ctx.giver) return true;
  if (seat === ctx.target && ctx.looksDirect) return true;
  return false;
}

function findLink(
  ctx: ConnectContext,
  needed: Ord,
  taken: ReadonlySet<number>,
): Connection | undefined {
  const known = findKnown(ctx, needed, taken);
  if (known) return known;

  for (const seat of connectionSeats(ctx.state.players.length, ctx.giver)) {
    if (skipSeat(ctx, seat)) continue;
    const prompt = findPrompt(ctx, seat, needed, taken);
    if (prompt) return prompt;
    const finesse = findFinesse(ctx, seat, needed, taken);
    if (finesse) return finesse;
  }
  return undefined;
}

/**
 * The connections that make `ord` a sensible thing for this clue to promise, or
 * `undefined` when the table could not be expected to find any.
 *
 * A bluff shortens the chain rather than lengthening it: the blind play is a
 * different suit, so nothing more is needed after it.
 */
export function connect(ctx: ConnectContext, ord: Ord): Connection[] | undefined {
  const identity = identityOfOrd(ord);
  const top = ctx.stacks[identity.suitIndex] ?? 0;
  if (top >= identity.rank) return undefined; // already played: not a play clue

  const connections: Connection[] = [];
  const taken = new Set<number>([ctx.focus]);
  const stacks = [...ctx.stacks];
  const walked: ConnectContext = { ...ctx, stacks };

  for (let rank = top + 1; rank < identity.rank; rank++) {
    const needed = ordOf({ suitIndex: identity.suitIndex, rank });
    const link = findLink(walked, needed, taken);
    if (!link) return undefined;
    if (link.order >= 0) taken.add(link.order);
    connections.push(link);

    if (link.hidden) {
      // A layer, not the card we came for. It goes down and the stacks move
      // with it, but the rank we needed is still missing, so ask again.
      const layer = identityOfOrd(link.identity);
      stacks[layer.suitIndex] = layer.rank;
      rank--;
    } else {
      stacks[identity.suitIndex] = rank;
    }

    // A hand only holds so many cards; anything longer than this is the search
    // going in circles rather than a line the table could ever follow.
    if (connections.length > 6) return undefined;
  }

  return connections;
}

/**
 * Occam's razor: of the readings a clue could carry, the table settles on the
 * ones asking for the least work.
 *
 * scala-bot's `occams.scala`. Saves are free — nobody has to work anything out
 * — so they beat any reading needing a blind play, which is what makes a 2 on
 * chop mean "hold it" rather than "there is a finesse here somewhere".
 */
export function occamsRazor(possibilities: FocusPossibility[]): FocusPossibility[] {
  if (possibilities.length === 0) return [];
  const cost = (fp: FocusPossibility): number =>
    fp.connections.reduce((total, link) => total + (link.kind === "known" ? 0 : 1), 0);
  const cheapest = Math.min(...possibilities.map(cost));
  return possibilities.filter((fp) => cost(fp) === cheapest);
}
