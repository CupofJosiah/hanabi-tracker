/**
 * H-Group clue interpretation.
 *
 * Walks a recorded game and works out what each clue was *meant* to say, which
 * is what turns a list of touched cards into a note like `r1,r5` or `[f]`.
 *
 * The structure follows scala-bot (`hgroup/interpretClue.scala`): find the
 * focus, check whether the clue is a fix, then decide between a save and a play
 * — and if it is a play whose card cannot go down yet, hunt for the connecting
 * cards through prompts and finesses.
 *
 * Where scala-bot searches deeply, this searches to a bounded depth and says so
 * rather than guessing. An interpretation it cannot justify comes back as
 * `unclear`, and the note falls back to plain possibilities.
 */
import { clueOf, replay, touchedOrders, type GameState } from "../hanabi/engine";
import { getVariant, identityName } from "../hanabi/variants";
import {
  ActionType,
  isKnown,
  type Clue,
  type GameAction,
  type GameRecord,
  type Identity,
} from "../hanabi/types";
import {
  applyGoodTouch,
  chopOf,
  criticalOrds,
  handOrders,
  identityOfOrd,
  intersect,
  newThought,
  ordOf,
  playableOrds,
  refreshPossible,
  settled,
  trashOrds,
  type Ord,
  type Thought,
} from "./empathy";
import { levelAllows, type BotSettings } from "./conventions";
import type { BotOverrides } from "./overrides";

export interface Connection {
  kind: "known" | "prompt" | "finesse";
  playerIndex: number;
  order: number;
  identity: Ord;
  /** True when the card sits in a hand we cannot see, so this is taken on trust. */
  assumed: boolean;
}

export type ClueInterpKind =
  | "play"
  | "save"
  | "fix"
  | "chop move"
  | "stall"
  | "useless"
  | "unclear";

export interface ClueInterp {
  actionIndex: number;
  kind: ClueInterpKind;
  /** Seat that received it. */
  target: number;
  focus: number;
  touched: number[];
  connections: Connection[];
  /** Human-readable reason, shown in the bot log. */
  detail: string;
}

export interface BotAnalysis {
  state: GameState;
  thoughts: Map<number, Thought>;
  interps: ClueInterp[];
  settings: BotSettings;
  overrides: BotOverrides;
  /** How many actions were replayed, so a hypothetical can be appended after them. */
  actionCount: number;
}

/**
 * Puts your corrections on top of whatever the bot worked out.
 *
 * Applied at the end of every step rather than once at the end, so a card you
 * have pinned is already pinned when the next clue is interpreted — the bot
 * looks for prompts and finesses through your reading, not around it.
 *
 * Your word wins outright: an identity you name is kept even when the clues on
 * the card appear to rule it out, because if the two disagree it is the bot's
 * model of the table that is wrong, not you.
 */
function applyOverrides(
  thoughts: Map<number, Thought>,
  overrides: BotOverrides,
  appliedActions: number,
): void {
  for (const [key, override] of Object.entries(overrides)) {
    if (override.fromAction > appliedActions) continue;
    const thought = thoughts.get(Number(key));
    if (!thought) continue;

    thought.overridden = true;
    if (override.status !== undefined) thought.status = override.status;
    if (override.identity !== undefined) {
      thought.inferred = new Set([override.identity]);
      thought.narrowed = true;
    }
  }
}

export function cloneThoughts(thoughts: Map<number, Thought>): Map<number, Thought> {
  const copy = new Map<number, Thought>();
  for (const [order, thought] of thoughts) {
    copy.set(order, {
      ...thought,
      possible: new Set(thought.possible),
      inferred: new Set(thought.inferred),
    });
  }
  return copy;
}

/**
 * The focus of a clue: the one card it is really about.
 *
 * If the clue touched the chop, that is the focus. Otherwise it is the newest
 * card the clue just introduced, and failing that (a re-clue) the newest card
 * it touched at all.
 */
export function determineFocus(
  state: GameState,
  thoughts: Map<number, Thought>,
  target: number,
  touched: readonly number[],
  previouslyClued: ReadonlySet<number>,
): { focus: number; onChop: boolean } {
  const hand = handOrders(state, target);
  const chop = chopOf(state, thoughts, target);
  if (chop !== undefined && touched.includes(chop)) return { focus: chop, onChop: true };

  const newly = hand.filter((order) => touched.includes(order) && !previouslyClued.has(order));
  const pool = newly.length > 0 ? newly : hand.filter((order) => touched.includes(order));
  // hand[0] is slot 1, so the earliest entry is the newest card.
  return { focus: pool[0] ?? touched[0] ?? -1, onChop: false };
}

/** Identities a chop clue could be saving, per H-Group's save rules. */
function savableOrds(state: GameState, clue: Clue, possible: ReadonlySet<Ord>): Set<Ord> {
  const critical = criticalOrds(state);
  const out = new Set<Ord>();
  for (const ord of possible) {
    const identity = identityOfOrd(ord);
    if (state.playStacks[identity.suitIndex] >= identity.rank) continue;
    const fiveSave = identity.rank === 5 && clue.kind === "rank" && clue.value === 5;
    const twoSave = identity.rank === 2 && clue.kind === "rank" && clue.value === 2;
    if (fiveSave || twoSave || critical.has(ord)) out.add(ord);
  }
  return out;
}

/** Seats in turn order after `from`, going once around and stopping before it. */
function seatsAfter(numPlayers: number, from: number): number[] {
  return Array.from({ length: numPlayers - 1 }, (_, i) => (from + 1 + i) % numPlayers);
}

interface ConnectContext {
  state: GameState;
  thoughts: Map<number, Thought>;
  giver: number;
  target: number;
  settings: BotSettings;
}

/**
 * Finds the cards that must play before `identity` can, if the table could
 * reasonably be expected to spot them.
 *
 * Each missing rank is looked for in this order, which is the H-Group priority:
 * a card already promised to play, then a prompt among clued cards, then a
 * finesse on someone's newest unclued card.
 *
 * Returns `undefined` when a link cannot be found, which is what makes an
 * identity unreachable and therefore not a candidate for a play clue.
 */
function connect(
  ctx: ConnectContext,
  identity: Identity,
  focusOrder: number,
  used: Set<number>,
): Connection[] | undefined {
  const { state, thoughts, giver, settings } = ctx;
  const connections: Connection[] = [];
  const top = state.playStacks[identity.suitIndex] ?? 0;
  if (top >= identity.rank) return undefined; // already played: not a play clue

  const promised = new Set<Ord>();
  for (const [order, thought] of thoughts) {
    if (order === focusOrder) continue;
    const card = state.cards[order];
    if (!card || card.holder < 0) continue;
    if (thought.status !== "called to play" && thought.status !== "finessed") continue;
    if (thought.inferred.size === 1) promised.add([...thought.inferred][0]);
  }

  for (let rank = top + 1; rank < identity.rank; rank++) {
    const needed: Identity = { suitIndex: identity.suitIndex, rank };
    const neededOrd = ordOf(needed);

    // Already going to play by itself.
    if (promised.has(neededOrd)) {
      connections.push({
        kind: "known",
        playerIndex: -1,
        order: -1,
        identity: neededOrd,
        assumed: false,
      });
      continue;
    }

    const link =
      findPrompt(ctx, needed, used, focusOrder) ??
      (levelAllows(settings, 2) ? findFinesse(ctx, needed, used, focusOrder) : undefined);

    if (!link) return undefined;
    used.add(link.order);
    connections.push(link);
  }

  return connections;
}

/** A clued card that could be the missing identity — the prompt. */
function findPrompt(
  ctx: ConnectContext,
  needed: Identity,
  used: Set<number>,
  focusOrder: number,
): Connection | undefined {
  const { state, thoughts, giver } = ctx;
  const neededOrd = ordOf(needed);

  for (const playerIndex of seatsAfter(state.players.length, giver)) {
    // Leftmost (newest) clued card that could be it.
    for (const order of handOrders(state, playerIndex)) {
      if (order === focusOrder || used.has(order)) continue;
      const card = state.cards[order];
      const thought = thoughts.get(order);
      if (!card || !thought || !card.knowledge.clued) continue;
      if (!thought.possible.has(neededOrd)) continue;
      if (thought.inferred.size === 1 && !thought.inferred.has(neededOrd)) continue;
      // If we can see the card, a prompt only works when it really is the card.
      if (isKnown(card.identity) && ordOf(card.identity) !== neededOrd) continue;
      return {
        kind: "prompt",
        playerIndex,
        order,
        identity: neededOrd,
        assumed: !isKnown(card.identity),
      };
    }
  }
  return undefined;
}

/** The newest unclued card in a hand, asked to blind-play. */
function findFinesse(
  ctx: ConnectContext,
  needed: Identity,
  used: Set<number>,
  focusOrder: number,
): Connection | undefined {
  const { state, thoughts, giver, settings } = ctx;
  const neededOrd = ordOf(needed);
  const layers = levelAllows(settings, 5) ? 3 : 1;

  for (const playerIndex of seatsAfter(state.players.length, giver)) {
    const hand = handOrders(state, playerIndex);
    let depth = 0;
    for (const order of hand) {
      if (depth >= layers) break;
      const card = state.cards[order];
      const thought = thoughts.get(order);
      if (!card || !thought) continue;
      if (card.knowledge.clued || thought.status === "chop moved") continue;
      if (used.has(order) || order === focusOrder) continue;
      depth++;

      if (!isKnown(card.identity)) {
        // Our own hand: the finesse is taken on trust, since we cannot look.
        return { kind: "finesse", playerIndex, order, identity: neededOrd, assumed: true };
      }
      if (ordOf(card.identity) === neededOrd) {
        return { kind: "finesse", playerIndex, order, identity: neededOrd, assumed: false };
      }
      // A layered finesse walks past cards that are themselves playable.
      const top = state.playStacks[card.identity.suitIndex] ?? 0;
      if (!(levelAllows(settings, 5) && top === card.identity.rank - 1)) break;
    }
  }
  return undefined;
}

/** Adds/removes thoughts so the map matches the cards currently in hands. */
function syncThoughts(state: GameState, thoughts: Map<number, Thought>, turn: number): void {
  for (const [order] of thoughts) {
    const card = state.cards[order];
    if (!card || card.holder < 0) thoughts.delete(order);
  }
  for (const card of state.cards) {
    if (!card || card.holder < 0 || thoughts.has(card.order)) continue;
    thoughts.set(card.order, newThought(card.order, new Set<Ord>(), turn));
  }
}

function settle(
  state: GameState,
  thoughts: Map<number, Thought>,
  settings: BotSettings,
  overrides: BotOverrides = {},
  appliedActions = Number.POSITIVE_INFINITY,
): void {
  refreshPossible(state, thoughts);
  applyGoodTouch(state, thoughts, settings.goodTouch);
  applyOverrides(thoughts, overrides, appliedActions);
}

/**
 * Detects a clue whose job was to stop a card being played.
 *
 * A card that was promised playable and can no longer be any playable identity
 * has been fixed; the clue promises nothing new.
 */
function detectFix(
  state: GameState,
  thoughts: Map<number, Thought>,
  target: number,
  before: Map<number, Set<Ord>>,
): number[] {
  const playable = playableOrds(state);
  const fixed: number[] = [];
  for (const order of handOrders(state, target)) {
    const thought = thoughts.get(order);
    const previous = before.get(order);
    if (!thought || !previous) continue;
    if (thought.status !== "called to play" && thought.status !== "finessed") continue;
    const stillPlayable = intersect(thought.possible, playable);
    if (stillPlayable.size === 0) fixed.push(order);
  }
  return fixed;
}

/**
 * Replays a game and keeps the table's shared reading of every card alongside
 * it.
 *
 * @param through Stop after this many actions, for stepping back through a game.
 */
export function analyse(
  record: GameRecord,
  settings: BotSettings,
  overrides: BotOverrides = {},
  through = Number.POSITIVE_INFINITY,
): BotAnalysis {
  const variant = getVariant(record.variantName);
  const base = {
    players: record.players,
    ourPlayerIndex: record.ourPlayerIndex,
    variant,
    deck: record.deck,
    actions: record.actions,
    touchedByAction: record.touchedByAction,
    options: record.options,
  };

  const limit = Math.min(record.actions.length, through);
  let state = replay(base, 0);
  const thoughts = new Map<number, Thought>();
  syncThoughts(state, thoughts, 0);
  settle(state, thoughts, settings, overrides, 0);

  const interps: ClueInterp[] = [];

  for (let actionIndex = 0; actionIndex < limit; actionIndex++) {
    const action = record.actions[actionIndex];
    const before = state;
    const clue = clueOf(action);
    const done = actionIndex + 1;

    if (clue) {
      const touched = touchedOrders(before, action.target, clue, record.touchedByAction[actionIndex]);
      const previouslyClued = new Set(
        handOrders(before, action.target).filter((order) => before.cards[order]?.knowledge.clued),
      );
      const priorPossible = new Map<number, Set<Ord>>();
      for (const [order, thought] of thoughts) priorPossible.set(order, new Set(thought.possible));

      state = replay(base, done);
      syncThoughts(state, thoughts, state.turn);
      settle(state, thoughts, settings, overrides, done);

      interps.push(
        interpretClue(
          before,
          state,
          thoughts,
          action,
          clue,
          actionIndex,
          touched,
          previouslyClued,
          priorPossible,
          settings,
        ),
      );
      settle(state, thoughts, settings, overrides, done);
    } else {
      // A play or discard settles that card and clears what it was promising.
      state = replay(base, done);
      syncThoughts(state, thoughts, state.turn);
      settle(state, thoughts, settings, overrides, done);
    }
  }

  return { state, thoughts, interps, settings, overrides, actionCount: limit };
}

/**
 * Reads a clue that has not been given yet.
 *
 * Used to score candidate clues: it runs the same interpretation the table
 * would, against a copy of the notes, so nothing about the real game moves.
 */
export function hypotheticalClue(
  record: GameRecord,
  analysis: BotAnalysis,
  target: number,
  clue: Clue,
): { interp: ClueInterp; thoughts: Map<number, Thought>; after: GameState } {
  const before = analysis.state;
  const action: GameAction = {
    type: clue.kind === "color" ? ActionType.ColorClue : ActionType.RankClue,
    target,
    value: clue.value,
  };
  const actions = [...record.actions.slice(0, analysis.actionCount), action];
  const after = replay(
    {
      players: record.players,
      ourPlayerIndex: record.ourPlayerIndex,
      variant: before.variant,
      deck: record.deck,
      actions,
      touchedByAction: record.touchedByAction,
      options: record.options,
    },
    actions.length,
  );

  const touched = touchedOrders(before, target, clue);
  const previouslyClued = new Set(
    handOrders(before, target).filter((order) => before.cards[order]?.knowledge.clued),
  );
  const thoughts = cloneThoughts(analysis.thoughts);
  const priorPossible = new Map<number, Set<Ord>>();
  for (const [order, thought] of thoughts) priorPossible.set(order, new Set(thought.possible));

  syncThoughts(after, thoughts, after.turn);
  settle(after, thoughts, analysis.settings, analysis.overrides, actions.length);
  const interp = interpretClue(
    before,
    after,
    thoughts,
    action,
    clue,
    analysis.actionCount,
    touched,
    previouslyClued,
    priorPossible,
    analysis.settings,
  );
  settle(after, thoughts, analysis.settings, analysis.overrides, actions.length);

  return { interp, thoughts, after };
}

function interpretClue(
  before: GameState,
  after: GameState,
  thoughts: Map<number, Thought>,
  action: GameAction,
  clue: Clue,
  actionIndex: number,
  touched: number[],
  previouslyClued: Set<number>,
  priorPossible: Map<number, Set<Ord>>,
  settings: BotSettings,
): ClueInterp {
  const target = action.target;
  const giver = before.currentPlayerIndex;
  const { focus, onChop } = determineFocus(before, thoughts, target, touched, previouslyClued);

  const shell: ClueInterp = {
    actionIndex,
    kind: "unclear",
    target,
    focus,
    touched,
    connections: [],
    detail: "",
  };

  if (touched.length === 0) return { ...shell, kind: "useless", detail: "touched nothing" };

  const focusThought = thoughts.get(focus);
  if (!focusThought) return { ...shell, kind: "unclear", detail: "focus already gone" };

  // A fix outranks everything: it is about a card that was already promised.
  if (levelAllows(settings, 3)) {
    const fixed = detectFix(after, thoughts, target, priorPossible);
    if (fixed.length > 0) {
      for (const order of fixed) {
        const thought = thoughts.get(order);
        if (!thought) continue;
        thought.status = "none";
        thought.reset = true;
        // The card goes back to meaning nothing in particular.
        thought.narrowed = false;
        thought.inferred = new Set(thought.possible);
      }
      return { ...shell, kind: "fix", detail: "stops a card being misplayed" };
    }
  }

  const trash = trashOrds(after);
  const allTrash = [...focusThought.possible].every((ord) => trash.has(ord));

  // 5 Chop Move / Trash Chop Move: the clue is not about its own focus.
  if (levelAllows(settings, 4)) {
    const five = clue.kind === "rank" && clue.value === 5;
    const focusCard = after.cards[focus];
    const focusIsPlayable =
      focusCard &&
      isKnown(focusCard.identity) &&
      after.playStacks[focusCard.identity.suitIndex] === focusCard.identity.rank - 1;

    if ((five && !onChop && !focusIsPlayable) || (allTrash && !onChop)) {
      const chop = chopOf(before, thoughts, target);
      if (chop !== undefined && chop !== focus) {
        const chopThought = thoughts.get(chop);
        if (chopThought) chopThought.status = "chop moved";
        return {
          ...shell,
          kind: "chop move",
          detail: five ? "5 chop move" : "trash chop move",
        };
      }
    }
  }

  const ctx: ConnectContext = { state: after, thoughts, giver, target, settings };
  const playable = playableOrds(after);

  // Which identities the focus could be that the clue could sensibly promise,
  // and how much work each reading takes.
  const cost = new Map<Ord, Connection[]>();
  for (const ord of focusThought.possible) {
    if (playable.has(ord)) {
      cost.set(ord, []);
      continue;
    }
    const connections = connect(ctx, identityOfOrd(ord), focus, new Set([focus]));
    if (connections) cost.set(ord, connections);
  }

  // Occam's razor, scala-bot's `occams.scala`: the table settles on the reading
  // that asks for the fewest blind plays. A red clue on a fresh card means r1,
  // not "r1, or r2 off a finesse" — the finesse is only read once r1 cannot be.
  const cheapest = Math.min(...[...cost.values()].map((c) => c.length));
  const reachable = new Set<Ord>();
  let bestConnections: Connection[] = [];
  for (const [ord, connections] of cost) {
    if (connections.length !== cheapest) continue;
    reachable.add(ord);
    if (bestConnections.length === 0) bestConnections = connections;
  }

  const savable = onChop ? savableOrds(after, clue, focusThought.possible) : new Set<Ord>();
  const promised = new Set<Ord>([...reachable, ...savable]);

  if (promised.size === 0) {
    if (allTrash) return { ...shell, kind: "useless", detail: "touched only trash" };
    return { ...shell, kind: "unclear", detail: "no reading found for this clue" };
  }

  focusThought.focused = true;
  focusThought.narrowed = true;
  focusThought.inferred = intersect(focusThought.possible, promised);

  // A save on chop promises nothing to play, so leave the status alone.
  const isSave = savable.size > 0 && reachable.size === 0;
  if (!isSave) {
    focusThought.status = "called to play";
    for (const link of bestConnections) {
      if (link.order < 0) continue;
      const thought = thoughts.get(link.order);
      if (!thought) continue;
      thought.status = link.kind === "finesse" ? "finessed" : "called to play";
      if (!thought.reset) {
        // A blind play is promised a specific card, so its note says so even
        // though nothing has touched it.
        const pinned =
          link.kind === "finesse"
            ? new Set([link.identity])
            : intersect(thought.possible, new Set([link.identity]));
        if (pinned.size > 0) {
          thought.inferred = pinned;
          thought.narrowed = true;
        }
      }
    }
  }

  const name = (ord: Ord): string => shortId(after, identityOfOrd(ord));
  if (isSave) {
    const which = [...savable].map(name).join(", ");
    return { ...shell, kind: "save", detail: `save on chop (${which})` };
  }

  const detail =
    bestConnections.length > 0
      ? `play clue, through ${bestConnections
          .map((c) => `${c.kind} ${name(c.identity)}`)
          .join(" → ")}`
      : "play clue";
  return { ...shell, kind: "play", connections: bestConnections, detail };
}

/** `r1`-style name, matching the notes scala-bot writes. */
export function shortId(state: GameState, identity: Identity): string {
  return isKnown(identity) ? identityName(state.variant, identity) : "??";
}

/** Convenience for the UI: the thought for one order, if it is still in a hand. */
export function thoughtOf(analysis: BotAnalysis, order: number): Thought | undefined {
  return analysis.thoughts.get(order);
}

export function settledIdentity(thought: Thought): Identity | undefined {
  return settled(thought);
}
