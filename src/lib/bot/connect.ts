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
 * - **A connection does not have to be playable yet.** The chain is walked one
 *   rank at a time from the top of the stack, so each link is exactly the card
 *   the previous link unblocks. A known r3 is what makes a clue on r4 readable
 *   while red is still on 1. This is the *delayed* play clue, and it is where
 *   most connections come from; requiring each link to be playable right now
 *   restricts the bot to seeing a single rank ahead.
 * - **The giver is never asked to blind-play.** They can see their own clue, so
 *   telling them to work something out from it says nothing.
 * - **Seats are searched backwards from the giver**, so the player with the
 *   least time to act is considered first and the player about to move last.
 * - **The target cannot connect to themselves while the clue looks direct.** A
 *   colour clue, or a clue that could be a save, reads as being about the card
 *   it touched. That holds until someone *else* is asked to blind-play, which
 *   is the table's signal that more is going on.
 * - **A prompt, once available, is binding.** If a seat holds a clued card that
 *   fits, that card is the connection — and if what is really there does not
 *   fit, the clue cannot mean this. Reaching past it for a finesse would invent
 *   a blind play nobody has a reason to make.
 *
 * The one piece of scala-bot deliberately left out is `mustPassback`, its
 * reordering of the seat search for variants where the focus could be a
 * different suit at the same height. It only bites in rainbow-like variants,
 * which this bot does not reason about anyway.
 */
import type { GameState } from "../hanabi/engine";
import { isKnown, type Identity } from "../hanabi/types";
import { cardTouched, copiesOf } from "../hanabi/variants";
import { levelAllows, type BotSettings } from "./conventions";
import {
  difference,
  handOrders,
  identityOfOrd,
  ordOf,
  playableAgainst,
  possibilities,
  visibleOrd,
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
  /** The board before it, for telling an old clue from this one. */
  before: GameState;
  thoughts: Map<number, Thought>;
  giver: number;
  target: number;
  focus: number;
  settings: BotSettings;
  /**
   * True when the clue reads as being about the card it touched, which stops
   * the receiver looking in their own hand.
   */
  looksDirect: boolean;
  /**
   * The real play stacks, which is where a chain starts.
   *
   * Deliberately *not* the hypothetical ones. Starting above everything already
   * promised would make a delayed play clue look like a direct one and leave
   * nothing for the search to find — the connections would be real but
   * invisible, so nobody would be told to play them.
   */
  stacks: number[];
  /**
   * The stacks once every outstanding promise has been kept.
   *
   * Used only to judge whether a card counts as "going to play" — a clued card
   * two ranks up is on its way if the cards under it are already spoken for.
   */
  hypo: number[];
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

/** scala-bot's `isTouched`: clued, or carrying a promise that amounts to the same. */
function isTouched(card: NonNullable<GameState["cards"][number]>, thought: Thought): boolean {
  return card.knowledge.clued || thought.status === "called to play" || thought.status === "finessed";
}

/** Copies of an identity already played or thrown away, which everyone can count. */
function copiesGone(state: GameState, ord: Ord): number {
  let gone = 0;
  for (const card of state.cards) {
    if (!card) continue;
    if (card.location !== "played" && card.location !== "discarded") continue;
    if (isKnown(card.identity) && ordOf(card.identity) === ord) gone++;
  }
  return gone;
}

/** False when every copy is on a stack or in the bin: nothing left to connect through. */
function stillExists(state: GameState, ord: Ord): boolean {
  return copiesGone(state, ord) < copiesOf(state.variant, identityOfOrd(ord));
}

/** Ordinals the hypothetical stacks have already covered. */
function coveredBy(stacks: readonly number[]): Set<Ord> {
  const out = new Set<Ord>();
  for (let suitIndex = 0; suitIndex < stacks.length; suitIndex++) {
    for (let rank = 1; rank <= stacks[suitIndex]; rank++) out.add(ordOf({ suitIndex, rank }));
  }
  return out;
}

/**
 * Every copy still in play is sitting where the seats between here and the
 * giver can see it.
 *
 * scala-bot's `allVisible`, and the reason a receiver may sometimes connect to
 * themselves even when the clue looks direct: if everyone who acts before them
 * can see the other copies, nobody else is going to react, so it must be them.
 */
function allCopiesVisible(ctx: ConnectContext, reacting: number, needed: Ord): boolean {
  const state = ctx.state;
  const remaining = copiesOf(state.variant, identityOfOrd(needed)) - copiesGone(state, needed);
  if (remaining <= 0) return false;

  const numPlayers = state.players.length;
  let visible = 0;
  for (let seat = (reacting + 1) % numPlayers; seat !== ctx.giver; seat = (seat + 1) % numPlayers) {
    for (const order of handOrders(state, seat)) {
      if (visibleOrd(state, order) === needed) visible++;
    }
  }
  return remaining === visible;
}

/**
 * A card that gets the table to this identity for free.
 *
 * Two shapes, both of scala-bot's, and neither of which asks anyone to work
 * anything out — which is why they cost nothing under Occam's razor.
 *
 * **Known**: common knowledge has pinned the card to exactly this identity. It
 * need not be playable yet; the chain is walked in rank order, so whatever
 * unblocks it is already earlier in the same chain.
 *
 * **Playable**: the table knows the card is going to play but not which card it
 * is — a clued "1" that could be any of three playable 1s. Whether it is the
 * one this chain needs is something the seats who can see it know and its
 * holder does not, so it only counts when the card is visible and really is
 * that identity. That asymmetry is the point: the clue was given by someone who
 * could see it.
 */
function findKnown(
  ctx: ConnectContext,
  needed: Ord,
  taken: ReadonlySet<number>,
  ignore: ReadonlySet<number>,
): Connection | undefined {
  const numPlayers = ctx.state.players.length;

  for (let seat = 0; seat < numPlayers; seat++) {
    for (const order of handOrders(ctx.state, seat)) {
      if (taken.has(order) || ignore.has(order)) continue;
      const held = heldThought(ctx, order);
      if (!held || held.thought.hidden) continue;
      const pool = possibilities(held.thought);
      if (pool.size !== 1 || !pool.has(needed)) continue;
      // A card we can see is only that identity if it really is. One we cannot
      // — our own hand — is taken at the table's word.
      const seen = visibleOrd(ctx.state, order);
      if (seen !== undefined && seen !== needed) continue;
      return {
        kind: "known",
        playerIndex: seat,
        order,
        identity: needed,
        hidden: false,
        bluff: false,
        assumed: seen === undefined,
      };
    }
  }

  const playable = playableAgainst(ctx.hypo);
  const covered = coveredBy(ctx.hypo);

  for (let seat = 0; seat < numPlayers; seat++) {
    if (seat === ctx.giver) continue;
    for (const order of handOrders(ctx.state, seat)) {
      if (taken.has(order) || ignore.has(order)) continue;
      const held = heldThought(ctx, order);
      if (!held || held.thought.hidden) continue;
      if (!isTouched(held.card, held.thought)) continue;
      // Only the seats that can see it can read this connection, so we have to
      // be one of them.
      if (visibleOrd(ctx.state, order) !== needed) continue;

      const pool = possibilities(held.thought);
      if (!pool.has(needed)) continue;
      const useful = difference(pool, covered);
      if (useful.size === 0) continue;
      let allPlayable = true;
      for (const ord of useful) {
        if (!playable.has(ord)) {
          allPlayable = false;
          break;
        }
      }
      if (!allPlayable) continue;

      return {
        kind: "playable",
        playerIndex: seat,
        order,
        identity: needed,
        hidden: false,
        bluff: false,
        assumed: false,
      };
    }
  }

  return undefined;
}

/**
 * The clued card in a hand that a prompt would point at.
 *
 * Of the cards that fit, the one carrying the most clues is prompted, which is
 * scala-bot's tie-break and matches how a table reads it: the most-specified
 * card is the one being pointed at.
 */
function promptOrder(
  ctx: ConnectContext,
  seat: number,
  needed: Ord,
  taken: ReadonlySet<number>,
  ignore: ReadonlySet<number>,
): number | undefined {
  const identity = identityOfOrd(needed);
  let best: { order: number; clues: number } | undefined;

  for (const order of handOrders(ctx.state, seat)) {
    if (taken.has(order) || ignore.has(order) || order === ctx.focus) continue;
    const held = heldThought(ctx, order);
    if (!held || !held.card.knowledge.clued) continue;
    const { card, thought } = held;
    if (!thought.possible.has(needed)) continue;
    // Info-locked onto something else: it cannot be quietly re-read.
    if (thought.inferred.size === 1 && !thought.inferred.has(needed)) continue;
    // At least one clue on the card has to actually match the identity, or it
    // is not the card being pointed at.
    if (!cluesMatch(ctx.state, card.knowledge, identity)) continue;

    const clues = countClues(card.knowledge);
    if (!best || clues > best.clues) best = { order, clues };
  }
  return best?.order;
}

/**
 * What the prompted card turns out to be.
 *
 * `undefined` here is not "try something else" — it is "this clue cannot mean
 * that". A seat holding a clued card that fits the description is the seat's
 * answer, right or wrong.
 */
function tryPrompt(
  ctx: ConnectContext,
  seat: number,
  order: number,
  needed: Ord,
): Connection | undefined {
  const card = ctx.state.cards[order];
  if (!card) return undefined;

  const conn = (identity: Ord, hidden: boolean, assumed: boolean): Connection => ({
    kind: "prompt",
    playerIndex: seat,
    order,
    identity,
    hidden,
    bluff: false,
    assumed,
  });

  const seen = visibleOrd(ctx.state, order);
  if (seen === undefined) return conn(needed, false, true);
  if (seen === needed) return conn(needed, false, false);

  // Something else is really there. That still works if it plays first — the
  // layered prompt, level 5 — and otherwise the reading is dead.
  if (!levelAllows(ctx.settings, 5)) return undefined;
  const real = identityOfOrd(seen);
  const top = ctx.stacks[real.suitIndex] ?? 0;
  if (top !== real.rank - 1) return undefined;
  return conn(seen, true, false);
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
 * Nobody is finessed for a card that is already clued somewhere.
 *
 * scala-bot's `cluedDupe`. If a copy is sitting clued in a hand the giver is
 * not holding, the table reads the clue as being about that copy rather than
 * as an instruction to blind-play a second one.
 */
function cluedDupe(ctx: ConnectContext, needed: Ord): boolean {
  for (let seat = 0; seat < ctx.state.players.length; seat++) {
    if (seat === ctx.giver) continue;
    for (const order of handOrders(ctx.state, seat)) {
      if (!ctx.before.cards[order]?.knowledge.clued) continue;
      if (visibleOrd(ctx.state, order) === needed) return true;
    }
  }
  return false;
}

/**
 * The finesse position: the newest card in a hand carrying no information.
 *
 * scala-bot's `findFinesseId` — one card, found by scanning past everything
 * that is spoken for. Whether it can be the identity is decided afterwards; the
 * position itself does not move to suit the answer, which is exactly why a
 * finesse is readable at all.
 */
function finesseOrder(
  ctx: ConnectContext,
  seat: number,
  needed: Ord,
  taken: ReadonlySet<number>,
  ignore: ReadonlySet<number>,
): number | undefined {
  for (const order of handOrders(ctx.state, seat)) {
    const held = heldThought(ctx, order);
    if (!held) continue;
    if (held.card.knowledge.clued) continue;
    if (taken.has(order) || ignore.has(order)) continue;
    const { thought } = held;
    if (thought.status === "chop moved") continue;
    if (thought.status === "finessed") {
      // Already blind-playing. At level 5 it may be blind-playing *this*, in
      // which case it is still the card being pointed at.
      if (!levelAllows(ctx.settings, 5) || !possibilities(thought).has(needed)) continue;
    }
    return order;
  }
  return undefined;
}

/**
 * What the card on finesse position can be asked to do.
 *
 * Either it is the promised card — the plain finesse — or something else
 * playable is sitting in front of it, which at level 5 is a layered finesse:
 * the layer comes off first and the promised card is underneath.
 *
 * A bluff is the same shape seen from the other side — the blind play happens
 * but the promise was never about that card. Nothing here can tell the two
 * apart, because from common knowledge they are the same clue; the difference
 * is written onto the blind-playing card instead (`assignConnections`).
 */
function tryFinesse(
  ctx: ConnectContext,
  seat: number,
  order: number,
  needed: Ord,
): Connection | undefined {
  if (!levelAllows(ctx.settings, 2)) return undefined;
  const held = heldThought(ctx, order);
  if (!held) return undefined;
  const { thought } = held;

  const conn = (identity: Ord, hidden: boolean, assumed: boolean): Connection => ({
    kind: "finesse",
    playerIndex: seat,
    order,
    identity,
    hidden,
    bluff: false,
    assumed,
  });

  // A card negatively clued out of the identity cannot be finessed as it,
  // however invisible it is to its holder.
  const couldBe = thought.possible.has(needed);

  const seen = visibleOrd(ctx.state, order);
  if (seen === undefined) return couldBe ? conn(needed, false, true) : undefined;
  if (seen === needed) return couldBe ? conn(needed, false, false) : undefined;

  if (!levelAllows(ctx.settings, 5)) return undefined;
  const real = identityOfOrd(seen);
  const top = ctx.stacks[real.suitIndex] ?? 0;
  if (top !== real.rank - 1) return undefined;
  return conn(seen, true, false);
}

/**
 * True when a seat may not be asked to supply this connection.
 *
 * The giver never can. The target cannot connect to themselves while the clue
 * still reads as being about the card it touched — that is the rule that keeps
 * a colour clue meaning "this is the playable one" rather than "blind-play the
 * card underneath it" — unless every remaining copy is somewhere the seats
 * ahead of them can see, in which case nobody else will react.
 */
function skipSeat(ctx: ConnectContext, seat: number, needed: Ord): boolean {
  if (seat === ctx.giver) return true;
  if (seat === ctx.target && ctx.looksDirect && !allCopiesVisible(ctx, seat, needed)) return true;
  return false;
}

/**
 * One seat's contribution: the layers it has to shed, ending in the card that
 * actually supplies the identity.
 *
 * scala-bot recurses on the *same* seat after a hidden layer rather than
 * starting the search over, so a hand with two cards stacked in front of the
 * promised one is walked in place.
 */
function findSeatLinks(
  ctx: ConnectContext,
  seat: number,
  needed: Ord,
  taken: ReadonlySet<number>,
  ignore: ReadonlySet<number>,
): Connection[] | undefined {
  if (skipSeat(ctx, seat, needed)) return undefined;

  const links: Connection[] = [];
  const stacks = [...ctx.stacks];
  const hypo = [...ctx.hypo];
  const used = new Set(taken);

  // A hand only holds so many cards, so a chain longer than this is the search
  // going in circles rather than a line the table could follow.
  for (let depth = 0; depth < 5; depth++) {
    const walked: ConnectContext = { ...ctx, stacks, hypo };
    const prompt = promptOrder(walked, seat, needed, used, ignore);
    const link =
      prompt !== undefined
        ? tryPrompt(walked, seat, prompt, needed)
        : cluedDupe(walked, needed)
          ? undefined
          : ((): Connection | undefined => {
              const position = finesseOrder(walked, seat, needed, used, ignore);
              return position === undefined ? undefined : tryFinesse(walked, seat, position, needed);
            })();

    if (!link) return undefined;
    links.push(link);
    used.add(link.order);
    if (!link.hidden) return links;

    const layer = identityOfOrd(link.identity);
    stacks[layer.suitIndex] = Math.max(stacks[layer.suitIndex] ?? 0, layer.rank);
    hypo[layer.suitIndex] = Math.max(hypo[layer.suitIndex] ?? 0, layer.rank);
  }
  return undefined;
}

/** The cards that supply one missing rank, cheapest source first. */
function findLink(
  ctx: ConnectContext,
  needed: Ord,
  taken: ReadonlySet<number>,
  ignore: ReadonlySet<number>,
): Connection[] | undefined {
  if (!stillExists(ctx.state, needed)) return undefined;

  const known = findKnown(ctx, needed, taken, ignore);
  if (known) return [known];

  for (const seat of connectionSeats(ctx.state.players.length, ctx.giver)) {
    const links = findSeatLinks(ctx, seat, needed, taken, ignore);
    if (links) return links;
  }
  return undefined;
}

/**
 * The connections that make `ord` a sensible thing for this clue to promise, or
 * `undefined` when the table could not be expected to find any.
 */
export function connect(ctx: ConnectContext, ord: Ord): Connection[] | undefined {
  return connectFrom(ctx, ord, new Set<number>(), 0);
}

function connectFrom(
  ctx: ConnectContext,
  ord: Ord,
  ignore: ReadonlySet<number>,
  depth: number,
): Connection[] | undefined {
  const identity = identityOfOrd(ord);
  const top = ctx.stacks[identity.suitIndex] ?? 0;
  if (top >= identity.rank) return undefined; // already played: not a play clue

  const connections: Connection[] = [];
  const taken = new Set<number>([ctx.focus]);
  const stacks = [...ctx.stacks];
  const hypo = [...ctx.hypo];
  let looksDirect = ctx.looksDirect;

  for (let rank = top + 1; rank < identity.rank; rank++) {
    const needed = ordOf({ suitIndex: identity.suitIndex, rank });
    const walked: ConnectContext = { ...ctx, stacks, hypo, looksDirect };
    const links = findLink(walked, needed, taken, ignore);

    if (!links) {
      // The chain died after leaning on a card the table has pinned down. That
      // card may simply be the wrong copy, so scala-bot sets it aside and tries
      // again rather than giving up on the reading.
      const known = connections.find((link) => link.kind === "known" && !ignore.has(link.order));
      if (known && depth < 3) {
        return connectFrom(ctx, ord, new Set([...ignore, known.order]), depth + 1);
      }
      return undefined;
    }

    for (const link of links) {
      if (link.order >= 0) taken.add(link.order);
      connections.push(link);
      const gained = identityOfOrd(link.identity);
      stacks[gained.suitIndex] = Math.max(stacks[gained.suitIndex] ?? 0, gained.rank);
      hypo[gained.suitIndex] = Math.max(hypo[gained.suitIndex] ?? 0, gained.rank);
    }

    // Once someone other than the receiver has been asked to blind-play, the
    // clue has stopped being simply about the card it touched — so from here on
    // the receiver may look in their own hand too.
    if (links.some((l) => l.kind === "finesse" && l.playerIndex !== ctx.target && !l.hidden)) {
      looksDirect = false;
    }

    if (connections.length > 6) return undefined;
  }

  return connections;
}

/** The first connection anybody has to work out for themselves. */
function nextUnknown(fp: FocusPossibility): Connection | undefined {
  return fp.connections.find((link) => link.kind !== "known" && link.kind !== "playable");
}

/**
 * How much work a reading asks for, on scala-bot's scale (`occams.scala`).
 *
 * Nothing at all if the first card anyone has to work out belongs to a seat
 * that is neither the receiver nor us — someone else will demonstrate it before
 * it matters. Otherwise it counts the blind plays and prompts that seat has to
 * find in a row, and weights our own far more heavily than the receiver's,
 * because we cannot see our own hand to check.
 */
function simplicity(fp: FocusPossibility, target: number, ourPlayerIndex: number): number {
  const first = nextUnknown(fp);
  if (!first) return 0;
  if (first.playerIndex !== target && first.playerIndex !== ourPlayerIndex) return 0;

  const from = fp.connections.indexOf(first);
  const run: Connection[] = [];
  for (let i = from; i < fp.connections.length; i++) {
    if (fp.connections[i].playerIndex !== first.playerIndex) break;
    run.push(fp.connections[i]);
  }
  const blind = run.filter((link) => link.kind === "finesse").length;
  const prompts = run.filter((link) => link.kind === "prompt").length;

  return first.playerIndex === target ? 10 * blind + prompts : 1000 * blind + 100 * prompts;
}

/**
 * Occam's razor: of the readings a clue could carry, the table settles on the
 * ones asking for the least work.
 *
 * Saves cost nothing — nobody has to work anything out — so they beat any
 * reading needing a blind play, which is what makes a 2 on chop mean "hold it"
 * rather than "there is a finesse here somewhere". A delayed play clue that
 * runs entirely through cards the table has already placed costs nothing
 * either, and ties with a card that is playable this instant.
 */
export function occamsRazor(
  possibilities: FocusPossibility[],
  target: number,
  ourPlayerIndex: number,
): FocusPossibility[] {
  if (possibilities.length === 0) return [];
  const costs = possibilities.map((fp) => simplicity(fp, target, ourPlayerIndex));
  const cheapest = Math.min(...costs);
  return possibilities.filter((_, i) => costs[i] === cheapest);
}
