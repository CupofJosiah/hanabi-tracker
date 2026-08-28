/**
 * H-Group clue interpretation.
 *
 * Walks a recorded game and works out what each clue was *meant* to say, which
 * is what turns a list of touched cards into a note like `r1,r5` or `[f]`.
 *
 * The structure follows scala-bot (`hgroup/interpretClue.scala`): find the
 * focus, check whether the clue is a fix, then decide between a save and a play
 * — and if it is a play whose card cannot go down yet, hunt for the connecting
 * cards through prompts and finesses (`connect.ts`).
 *
 * Two things distinguish this from reading each clue once and moving on.
 *
 * **Every reading is kept, not just the winner.** Occam's razor picks the
 * cheapest, but the runners-up are recorded on the interpretation, which is
 * what lets the bot change its mind and what lets you pick a different one.
 *
 * **Promises are held open.** A clue asking for a blind play registers a
 * waiting connection (`waiting.ts`). If the player who was supposed to play
 * does something else, the reading is refuted, and the whole game is
 * re-analysed with that reading struck out. That is scala-bot's rewind, and it
 * is the difference between reading a clue and reading it *correctly*.
 */
import { clueOf, pace, replay, touchedOrders, type GameState } from "../hanabi/engine";
import { getVariant, identityName, type Variant } from "../hanabi/variants";
import {
  ActionType,
  isKnown,
  MAX_CLUE_TOKENS,
  type Clue,
  type GameAction,
  type GameRecord,
  type Identity,
} from "../hanabi/types";
import {
  applyGoodTouch,
  chopOf,
  criticalOrds,
  finessePosition,
  handOrders,
  hypoStacks,
  identityOfOrd,
  intersect,
  isPlayPromised,
  newThought,
  ordOf,
  perspectiveOf,
  playableAgainst,
  playableOrds,
  possibilities,
  refreshPossible,
  resetThought,
  settled,
  trashOrds,
  visibleOrd,
  worthSavingOrds,
  type Ord,
  type Thought,
} from "./empathy";
import {
  allowsEightClueSave,
  allowsLockedHandSave,
  doubleDiscardRisk,
  inEndgame,
  isFillIn,
  isFiveStall,
  isHardBurn,
  isLocked,
  severityName,
  Stall,
  stallSeverity,
  type StallSeverity,
} from "./stall";
import {
  bluffSeat,
  connect,
  occamsRazor,
  type Connection,
  type ConnectContext,
  type FocusPossibility,
} from "./connect";
import { updateWaiting, type Disproof, type WaitingConnection } from "./waiting";
import { levelAllows, type BotSettings } from "./conventions";
import { NO_OVERRIDES, type BotOverrides } from "./overrides";

export type { Connection, FocusPossibility };

export type ClueInterpKind =
  | "play"
  | "save"
  | "fix"
  | "chop move"
  | "tempo"
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
  /** Every reading the bot found, cheapest first — the winner is `chosen`. */
  alternatives: FocusPossibility[];
  /** The readings that survived Occam's razor. */
  chosen: Ord[];
  /** Readings the table has since refuted, or that you struck out. */
  ruledOut: Ord[];
  /** True when you picked the reading rather than the bot. */
  overridden: boolean;
  /** Human-readable reason, shown in the bot log. */
  detail: string;
}

/**
 * What a move other than a clue said.
 *
 * H-Group loads plenty onto plays and discards. A card thrown away can hand its
 * twin to somebody — a Sarcastic, Gentleman's or Baton Discard. A discard taken
 * instead of an obvious play is a shout of alarm that moves the next player's
 * chop. And playing unknown 1s out of order moves a chop too.
 */
export type ActionInterpKind =
  | "sarcastic"
  | "gentleman"
  | "baton"
  | "scream"
  | "shout"
  | "generation"
  | "order chop move"
  | "positional discard"
  | "positional misplay";

export interface DiscardInterp {
  actionIndex: number;
  kind: ActionInterpKind;
  /** Cards the move pointed at. */
  orders: number[];
  /** The identity involved, or -1 when the move names none. */
  identity: Ord;
  detail: string;
}

export interface BotAnalysis {
  state: GameState;
  /**
   * Why the conventions are switched off for this game, or undefined when the
   * bot is reading normally. See `unsupportedVariantReason`.
   */
  unsupported?: string;
  thoughts: Map<number, Thought>;
  interps: ClueInterp[];
  /** Moves other than clues that said something — see ActionInterpKind. */
  discards: DiscardInterp[];
  settings: BotSettings;
  overrides: BotOverrides;
  /** Promises the table is still waiting on. */
  waiting: WaitingConnection[];
  /** Readings the bot abandoned mid-game, with what refuted them. */
  reinterpretations: Disproof[];
  /** True until the first real chop discard — H-Group's early game. */
  earlyGame: boolean;
  /**
   * What the last player threw away, which is what would put the next one in a
   * double-discard position. Needed to score a clue that has not been given.
   */
  lastDiscard: Ord | undefined;
  /** How many actions were replayed, so a hypothetical can be appended after them. */
  actionCount: number;
}

/** Identities struck out for a given clue, keyed by its index in `actions`. */
type RuledOut = Record<number, Ord[]>;

/**
 * How many times the bot may change its mind before settling.
 *
 * Each pass strikes out at least one reading, so this terminates on its own;
 * the cap is only there to keep a pathological game from re-analysing forever.
 */
const MAX_REINTERPRETATIONS = 6;

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
  state: GameState,
  thoughts: Map<number, Thought>,
  overrides: BotOverrides,
  appliedActions: number,
): void {
  for (const [key, override] of Object.entries(overrides.cards)) {
    if (override.fromAction > appliedActions) continue;
    const thought = thoughts.get(Number(key));
    if (!thought) continue;

    thought.overridden = true;
    if (override.status !== undefined) thought.status = override.status;

    // Telling the bot a card was saved says something about which card it is:
    // it is one of the ones worth saving. Only narrow when something survives,
    // so saying "saved" about a card that cannot be one never empties its note.
    if (override.status === "saved" && override.identity === undefined) {
      const worthSaving = intersect(thought.inferred, worthSavingOrds(state));
      if (worthSaving.size > 0) {
        thought.inferred = worthSaving;
        thought.narrowed = true;
      }
    }

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
 * scala-bot's `determineFocus`. The chop wins outright. Otherwise the focus is
 * the newest card the clue introduced that carried nothing at all — a card
 * already called to play or blind-playing is skipped, because the clue cannot
 * be about a card that was already spoken for, and skipping it is what lets a
 * colour clue land on the card *behind* a finesse.
 *
 * Rank-1 clues are their own rule. 1s are played oldest-first out of the
 * starting hand, so a "1" points at the oldest untouched 1 there — or, if the
 * clue caught a 1 drawn since, at the newest of those.
 *
 * Focus Shifting is level 6, and it is the one rule that can move the focus off
 * the card the other rules pick: if that card is already known to be playable
 * the clue cannot be about it, so the focus slides to the next card along that
 * is not.
 */
export function determineFocus(
  state: GameState,
  thoughts: Map<number, Thought>,
  target: number,
  touched: readonly number[],
  previouslyClued: ReadonlySet<number>,
  clue: Clue,
  settings?: BotSettings,
  poolBefore?: ReadonlyMap<number, Set<Ord>>,
): { focus: number; onChop: boolean } {
  const chop = chopOf(state, thoughts, target);
  if (chop !== undefined && touched.includes(chop)) return { focus: chop, onChop: true };
  if (touched.length === 0) return { focus: -1, onChop: false };
  const shift = (focus: number): { focus: number; onChop: boolean } => ({
    focus: shiftFocus(state, thoughts, touched, focus, settings, poolBefore),
    onChop: false,
  });

  if (clue.kind === "rank" && clue.value === 1) {
    const rank = (order: number): number => {
      if (thoughts.get(order)?.status === "chop moved") return 100 - order;
      return (thoughts.get(order)?.drawnTurn ?? 0) === 0 ? order : -order;
    };
    let best = touched[0];
    for (const order of touched) if (rank(order) < rank(best)) best = order;
    return shift(best);
  }

  const newestFirst = [...touched].sort((a, b) => b - a);
  const fresh = newestFirst.find(
    (order) => !previouslyClued.has(order) && thoughts.get(order)?.status === "none",
  );
  if (fresh !== undefined) return shift(fresh);

  const moved = newestFirst.find((order) => thoughts.get(order)?.status === "chop moved");
  return shift(moved ?? newestFirst[0]);
}

/**
 * Focus Shifting, level 6.
 *
 * "When two or more cards are touched as part of a Play Clue, and the normally
 * focused card is already known to be playable, and one or more of the touched
 * cards are not, then the focus shifts to the next left-most card that is not
 * already known to be playable."
 *
 * Known-to-be-playable is common knowledge, not ours: every identity the table
 * still allows the card plays right now. A card like that is already clued, so
 * this can never move the focus off a chop, and a save clue is untouched by it.
 */
function shiftFocus(
  state: GameState,
  thoughts: Map<number, Thought>,
  touched: readonly number[],
  focus: number,
  settings: BotSettings | undefined,
  poolBefore: ReadonlyMap<number, Set<Ord>> | undefined,
): number {
  if (!settings || !levelAllows(settings, 6) || touched.length < 2) return focus;
  const playable = playableOrds(state);
  const knownPlayable = (order: number): boolean => {
    // What was known *before* this clue: the rule is about a card the clue had
    // no need to touch, not one it has just explained.
    const thought = thoughts.get(order);
    const pool = poolBefore?.get(order) ?? (thought && possibilities(thought));
    if (!pool || pool.size === 0) return false;
    return [...pool].every((ord) => playable.has(ord));
  };
  if (!knownPlayable(focus)) return focus;

  for (const order of [...touched].sort((a, b) => b - a)) {
    if (order === focus) continue;
    if (!knownPlayable(order)) return order;
  }
  return focus;
}

/**
 * Another card the whole table has already pinned to this identity.
 *
 * A save is not a save if everyone can see the copy is safe elsewhere, and a
 * play clue does not promise a card someone is already known to be holding.
 *
 * scala-bot's `invalidFocus` wants the table's reading *and* ours to agree
 * before it rules an identity out. A card the table has read as b2 while we can
 * see it is really b3 is not holding b2 for anybody, and treating it as if it
 * were takes b2 off the table for the rest of the game — one wrong reading
 * quietly poisoning every clue after it.
 */
function claimedElsewhere(
  state: GameState,
  thoughts: Map<number, Thought>,
  ord: Ord,
  exclude: number,
): boolean {
  for (const [order, thought] of thoughts) {
    if (order === exclude) continue;
    const card = state.cards[order];
    if (!card || card.holder < 0 || !card.knowledge.clued) continue;
    const pool = possibilities(thought);
    if (pool.size !== 1 || !pool.has(ord)) continue;
    const seen = visibleOrd(state, order);
    if (seen !== undefined && seen !== ord) continue;
    return true;
  }
  return false;
}

/**
 * The readings under which the clue means "hold onto this".
 *
 * Only ever on chop, and scala-bot's rules apply (`specialClues.scala`): the
 * card has to still be wanted, no copy may already be accounted for elsewhere,
 * and the clue has to be one that saves that card.
 *
 * By rank, that is the 2s and anything critical. By colour it is anything
 * critical **except a 5** — a 5 is saved with "5", never with its colour, so a
 * colour clue touching the chop is a play clue and the table reads it as one.
 * A 1 is never saved; there are five of them.
 *
 * The 2 Save has one more rule of its own: it is off if the giver can see the
 * other copy in somebody's hand, because saving a card that is already safe
 * duplicates it. The exception is both copies sitting on chops at once, when
 * whichever is saved first is the one that was in danger.
 */
function savePossibilities(
  state: GameState,
  thoughts: Map<number, Thought>,
  clue: Clue,
  focus: number,
  onChop: boolean,
  giver: number,
): FocusPossibility[] {
  if (!onChop) return [];
  const thought = thoughts.get(focus);
  if (!thought) return [];

  const critical = criticalOrds(state);
  const out: FocusPossibility[] = [];

  for (const ord of possibilities(thought)) {
    const identity = identityOfOrd(ord);
    if (state.playStacks[identity.suitIndex] >= identity.rank) continue; // no longer wanted
    if (claimedElsewhere(state, thoughts, ord, focus)) continue; // already safe somewhere
    if (identity.rank === 1) continue;

    const isCritical = critical.has(ord);
    const saves =
      clue.kind === "color"
        ? isCritical && identity.rank !== 5
        : clue.value === identity.rank && (identity.rank === 2 || isCritical);

    if (!saves) continue;
    if (identity.rank === 2 && !isCritical && duplicateInSight(state, thoughts, ord, focus, giver)) {
      continue;
    }
    out.push({ identity: ord, connections: [], save: true });
  }
  return out;
}

/**
 * Another copy of a 2 sitting where the giver could see it, and not itself in
 * danger — which is what makes a 2 Save on this card illegal.
 *
 * Cards in the giver's own hand do not count: they cannot see those, so a 2
 * Save given over one of them is still the clue they meant to give.
 */
function duplicateInSight(
  state: GameState,
  thoughts: Map<number, Thought>,
  ord: Ord,
  focus: number,
  giver: number,
): boolean {
  for (let seat = 0; seat < state.players.length; seat++) {
    if (seat === giver) continue;
    const chop = chopOf(state, thoughts, seat);
    for (const order of handOrders(state, seat)) {
      if (order === focus || order === chop) continue;
      if (visibleOrd(state, order) === ord) return true;
    }
  }
  return false;
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
  overrides: BotOverrides = NO_OVERRIDES,
  appliedActions = Number.POSITIVE_INFINITY,
): void {
  refreshAll(state, thoughts, settings);
  applyOverrides(state, thoughts, overrides, appliedActions);
}

/** Counting first, then Good Touch. Your corrections go on top, in `settle`. */
function refreshAll(
  state: GameState,
  thoughts: Map<number, Thought>,
  settings: BotSettings,
): void {
  refreshPossible(state, thoughts);
  applyGoodTouch(state, thoughts, settings.goodTouch);
}

/**
 * Detects a clue whose job was to stop a card being played.
 *
 * scala-bot's `basics/fix.scala`. Two things make this narrow, and both matter:
 * a fix is a clue given *on* the card it is fixing, so only cards this clue
 * touched are candidates; and being fixed means the card is now **trash** —
 * every identity it could still be is already on the stacks — not merely that
 * it cannot go down this instant. Without the second, every delayed play clue
 * reads as a fix, because a card promised two ranks up is not playable yet by
 * design.
 *
 * `promisedBefore` and `cluedBefore` are snapshots from before the clue landed,
 * because the promise is the first thing the clue destroys.
 */
function detectFix(
  thoughts: Map<number, Thought>,
  touched: readonly number[],
  promisedBefore: ReadonlySet<number>,
  cluedBefore: ReadonlySet<number>,
  trash: ReadonlySet<Ord>,
): number[] {
  const fixed: number[] = [];
  for (const order of touched) {
    if (!promisedBefore.has(order) && !cluedBefore.has(order)) continue;
    const thought = thoughts.get(order);
    if (!thought || thought.reset) continue;
    const pool = possibilities(thought);
    if (pool.size === 0) continue;
    let allTrash = true;
    for (const ord of pool) {
      if (!trash.has(ord)) {
        allTrash = false;
        break;
      }
    }
    if (allTrash) fixed.push(order);
  }
  return fixed;
}

/** Which slot a card is sitting in, 1 being the newest. */
function slotOf(state: GameState, order: number): number {
  return state.cards[order]?.slot ?? 0;
}

/**
 * How many slots newer than the chop a card is sitting, counting only cards
 * that are themselves still unspoken for. A card on chop is 0 away.
 */
function chopDistance(
  state: GameState,
  thoughts: Map<number, Thought>,
  playerIndex: number,
  order: number,
): number {
  const chop = chopOf(state, thoughts, playerIndex);
  if (chop === undefined) return -1;
  let count = 0;
  for (const held of handOrders(state, playerIndex)) {
    if (held >= order || held < chop) continue;
    if (state.cards[held]?.knowledge.clued) continue;
    if (thoughts.get(held)?.status !== "none") continue;
    count++;
  }
  return count;
}

/**
 * The 5's Chop Move, level 4.
 *
 * A 5 clued one slot off the chop is not about the 5 — it is telling the holder
 * to keep the card next to it. scala-bot's `interpret5cm`, and the two rules
 * that stop it firing everywhere are the ones easiest to leave out: the 5 has
 * to be *exactly* one away from chop, and a **stalling situation is exempt**,
 * because there the same clue is a 5 Stall — the giver had nothing better to
 * say and reached for the safest card on the board. That covers the early game,
 * where it started life, and the double-discard, locked-hand and 8-clue
 * positions too.
 *
 * There is deliberately no "but the 5 is playable" exemption. A chop-moved 5
 * that happens to be playable is still both — the holder plays it and keeps the
 * card beside it.
 */
function detect5cm(
  before: GameState,
  after: GameState,
  thoughts: Map<number, Thought>,
  target: number,
  touched: readonly number[],
  clue: Clue,
  previouslyClued: ReadonlySet<number>,
  severity: StallSeverity,
  trash: ReadonlySet<Ord>,
): number | undefined {
  if (clue.kind !== "rank" || clue.value !== 5) return undefined;
  if (severity !== Stall.None) return undefined;

  const chop = chopOf(before, thoughts, target);
  if (chop === undefined || touched.includes(chop)) return undefined;

  const fresh = touched.filter((order) => !previouslyClued.has(order) && order > chop);
  if (fresh.length === 0) return undefined;
  const oldest = Math.min(...fresh);
  if (chopDistance(before, thoughts, target, oldest) !== 1) return undefined;

  // It has to really be a 5. Our own hand we take on trust.
  const seen = visibleOrd(after, oldest);
  if (seen !== undefined && identityOfOrd(seen).rank !== 5) return undefined;

  // Nothing to save: the chop is already known to be worthless.
  const chopThought = thoughts.get(chop);
  if (!chopThought) return undefined;
  const pool = possibilities(chopThought);
  if (pool.size > 0 && [...pool].every((ord) => trash.has(ord))) return undefined;

  return chop;
}

/**
 * The Trash Chop Move, level 4.
 *
 * Touching a card that can only be trash cannot be about that card, so it is
 * about the cards behind it — everything older than the oldest card the clue
 * just introduced gets moved off the chop, not merely the chop itself.
 */
function detectTcm(
  state: GameState,
  thoughts: Map<number, Thought>,
  target: number,
  touched: readonly number[],
  focus: number,
  clue: Clue,
  previouslyClued: ReadonlySet<number>,
  trash: ReadonlySet<Ord>,
): number[] {
  if (previouslyClued.has(focus)) return [];
  const focusThought = thoughts.get(focus);
  if (!focusThought) return [];

  // What the clue claims about the focus — for a rank clue, only that rank.
  const promised = [...focusThought.possible].filter(
    (ord) => clue.kind !== "rank" || identityOfOrd(ord).rank === clue.value,
  );
  if (promised.length === 0 || !promised.every((ord) => trash.has(ord))) return [];
  // A card whose every inference is playable is a play clue, not trash.
  if ([...focusThought.inferred].every((ord) => !trash.has(ord))) return [];

  const fresh = touched.filter((order) => !previouslyClued.has(order));
  if (fresh.length === 0) return [];
  const oldestTrash = Math.min(...fresh);

  return handOrders(state, target).filter(
    (order) =>
      order < oldestTrash &&
      !state.cards[order]?.knowledge.clued &&
      thoughts.get(order)?.status !== "chop moved",
  );
}

/** What a clue that touched nothing new turned out to be. */
interface TempoRead {
  /** True when the tempo was worth a whole clue on its own. */
  valuable: boolean;
  /** Why, for the log. */
  reason: string;
  /** Set once the clue has been read as a Tempo Clue Chop Move. */
  chopMoved?: string;
}

function allIn(pool: ReadonlySet<Ord> | undefined, allowed: ReadonlySet<Ord>): boolean {
  if (!pool || pool.size === 0) return false;
  for (const ord of pool) if (!allowed.has(ord)) return false;
  return true;
}

/**
 * The Tempo Clue, level 6, and the chop move that rides on it.
 *
 * A tempo clue is one that "gets" no new cards: every card it touched was
 * already clued, and its whole job is to make one of them playable *now*. That
 * breaks Minimum Clue Value on its own, so H-Group says it has to be paid for.
 * Either the tempo was worth it —
 *
 *  1. two or more clued cards play as a result, across every hand;
 *  2. the card is not a 5 and could not have been prompted, because another
 *     clued card in the same hand would have misplayed first;
 *  3. playing it unlocks a hand that had no chop;
 *
 * — or it was not, and then the clue is carrying something else: a Tempo Clue
 * Stall from a position where the giver could not discard, or, from an ordinary
 * position, a Tempo Clue Chop Move.
 *
 * A clue to a card the table already knew was playable is a burn, not a tempo
 * clue, and a clue whose focus is chop moved is an ordinary 1-for-1: a chop
 * moved card was never promised playable, so getting it played is real work.
 */
function readTempo(
  after: GameState,
  thoughts: Map<number, Thought>,
  target: number,
  touched: readonly number[],
  focus: number,
  previouslyClued: ReadonlySet<number>,
  poolBefore: ReadonlyMap<number, Set<Ord>>,
): TempoRead | undefined {
  if (touched.length === 0) return undefined;
  if (touched.some((order) => !previouslyClued.has(order))) return undefined;

  const focusThought = thoughts.get(focus);
  if (!focusThought || focusThought.status === "chop moved") return undefined;

  const playable = playableOrds(after);
  if (allIn(poolBefore.get(focus), playable)) return undefined; // already going to play: a burn
  if (!allIn(possibilities(focusThought), playable)) return undefined; // gets nothing played

  let gained = 0;
  for (const [order, thought] of thoughts) {
    const card = after.cards[order];
    if (!card || card.holder < 0) continue;
    if (!allIn(possibilities(thought), playable)) continue;
    if (allIn(poolBefore.get(order), playable)) continue;
    gained++;
  }
  if (gained >= 2) return { valuable: true, reason: `gets ${gained} clued cards to play` };

  if (isLocked(after, thoughts, target)) {
    return { valuable: true, reason: `unlocks ${after.players[target]}'s hand` };
  }

  const focusPool = possibilities(focusThought);
  const isFive = [...focusPool].every((ord) => identityOfOrd(ord).rank === 5);
  if (!isFive) {
    const wouldMisplay = handOrders(after, target).some((order) => {
      if (order === focus) return false;
      const card = after.cards[order];
      const thought = thoughts.get(order);
      if (!card?.knowledge.clued || !thought) return false;
      if (allIn(possibilities(thought), playable)) return false;
      for (const ord of possibilities(thought)) if (focusPool.has(ord)) return true;
      return false;
    });
    if (wouldMisplay) {
      return { valuable: true, reason: "the card could not have been prompted safely" };
    }
  }

  return { valuable: false, reason: "gets one already-clued card played" };
}

/**
 * A discard that hands a card to somebody else.
 *
 * Three moves share one shape: the player throws away a card the whole table
 * knew they were holding, and everyone reads that as pointing at the other
 * copy. Which move it is depends on where the other copy is and whether it can
 * play.
 *
 * - **Sarcastic Discard** (level 3): the other copy is *clued*, so the discard
 *   tells its holder what it is. If several clued cards could be it, all anyone
 *   learns is that one of them is — scala-bot's `basics/sarcastic.scala`.
 * - **Gentleman's Discard** (level 10): the other copy is unclued on somebody's
 *   finesse position, and it is playable, so they blind-play it.
 * - **Baton Discard** (level 10): the same, but the card cannot play yet. It
 *   counts as clued from then on, which takes it off its holder's chop and
 *   moves their finesse position past it.
 *
 * @param knownBefore what common knowledge made of the card as it was discarded
 */
function interpretDiscard(
  state: GameState,
  thoughts: Map<number, Thought>,
  order: number,
  actor: number,
  actionIndex: number,
  knownBefore: ReadonlySet<Ord>,
  settings: BotSettings,
): DiscardInterp | undefined {
  if (!levelAllows(settings, 3)) return undefined;

  const card = state.cards[order];
  if (!card || !isKnown(card.identity)) return undefined;

  // Only a card everyone knew you held says anything by leaving.
  const ord = ordOf(card.identity);
  if (knownBefore.size !== 1 || !knownBefore.has(ord)) return undefined;

  // Throwing away something already played is just tidying up.
  if (state.playStacks[card.identity.suitIndex] >= card.identity.rank) return undefined;

  const candidates: number[] = [];
  for (const [candidate, thought] of thoughts) {
    const held = state.cards[candidate];
    if (!held || held.holder < 0 || !held.knowledge.clued) continue;
    if (!thought.possible.has(ord)) continue;
    // A card already pinned to something else is not the one being pointed at.
    if (thought.inferred.size === 1 && !thought.inferred.has(ord)) continue;
    candidates.push(candidate);
  }

  const name = shortId(state, card.identity);

  if (candidates.length === 1) {
    const thought = thoughts.get(candidates[0])!;
    thought.inferred = new Set([ord]);
    thought.narrowed = true;
    thought.status = "called to play";
    return {
      actionIndex,
      kind: "sarcastic",
      orders: candidates,
      identity: ord,
      detail: `sarcastic discard — the other ${name} is here`,
    };
  }

  if (candidates.length > 1) {
    // More than one card could be it, so all anybody knows is that one of them
    // is. Saying which would be inventing information.
    return {
      actionIndex,
      kind: "sarcastic",
      orders: candidates,
      identity: ord,
      detail: `sarcastic discard — one of ${candidates.length} clued cards is the other ${name}`,
    };
  }

  // Nothing clued could be it, so the card was handed to a finesse position
  // instead: a Gentleman's Discard if it can play, a Baton Discard if not.
  if (!levelAllows(settings, 10)) return undefined;
  const receiver = findBaton(state, thoughts, actor, ord);
  if (receiver === undefined) return undefined;

  const thought = thoughts.get(receiver);
  if (!thought) return undefined;
  const holder = state.players[state.cards[receiver]!.holder];
  thought.inferred = new Set([ord]);
  thought.narrowed = true;

  if (playableOrds(state).has(ord)) {
    thought.status = "finessed";
    return {
      actionIndex,
      kind: "gentleman",
      orders: [receiver],
      identity: ord,
      detail: `gentleman's discard — ${holder} blind-plays ${name}`,
    };
  }

  thought.touched = true;
  thought.status = "saved";
  return {
    actionIndex,
    kind: "baton",
    orders: [receiver],
    identity: ord,
    detail: `baton discard — ${holder} now holds a known ${name}`,
  };
}

/**
 * The finesse position the discard handed the card to.
 *
 * Seats are walked in turn order from the discarder, because the move is aimed
 * at whoever holds the copy and the nearest one gets it.
 *
 * The card has to be one the bot can see. A finesse is anchored by a clue
 * everybody watched and by what the focus can be; a discard is anchored by
 * nothing but the discarder's sight of the other copy, so guessing that our own
 * unseen finesse position is the target would turn every thrown-away playable
 * card into a blind play we cannot check. Where the copy really is ours, one
 * card correction says so.
 */
function findBaton(
  state: GameState,
  thoughts: Map<number, Thought>,
  actor: number,
  ord: Ord,
): number | undefined {
  const numPlayers = state.players.length;
  for (let i = 1; i < numPlayers; i++) {
    const seat = (actor + i) % numPlayers;
    const position = finessePosition(state, thoughts, seat);
    if (position === undefined) continue;
    if (visibleOrd(state, position) === ord) return position;
  }
  return undefined;
}

/**
 * Positional Discards and Misplays, level 8.
 *
 * The one convention where the *slot* is the whole message. H-Group allows it
 * in exactly one position: the deck is dead, so every player can name their own
 * hand by subtracting what they see from what was dealt, and the mover's cards
 * are all rubbish to them. Throwing any of them costs nothing, which frees the
 * choice of which one to throw to mean something — "blind-play this slot".
 *
 * That precondition is why the convention needs empathy rather than the table's
 * shared view. What the *table* knows about a hand is usually much less than
 * what its holder knows, and "all rubbish" almost never holds of the shared
 * view even at the very end of a game. Asking `perspectiveOf` instead asks the
 * question H-Group actually asks: could this player tell that nothing they held
 * mattered? The readers can check it too, because they can see the hand.
 *
 * Two shapes:
 *
 * - **Positional Discard**: any slot but the chop. Throwing the chop is what a
 *   player with nothing to say does anyway, so it says nothing.
 * - **Positional Misplay**: the same message when a discard could not carry it,
 *   which is exactly when the slot wanted *is* the chop. Bombing a card the
 *   whole table can see was known rubbish is unmistakable.
 *
 * The receiver is "the final player with the playable card" — seats are walked
 * in turn order from the mover and the last match wins. Our own hand is the one
 * nobody here can check, so it is only read as the target when no visible seat
 * fits: then the mover must have meant us, and that is a deduction rather than
 * a guess.
 */
function interpretPositional(
  before: GameState,
  after: GameState,
  thoughts: Map<number, Thought>,
  order: number,
  actor: number,
  actionIndex: number,
  settings: BotSettings,
  /**
   * The mover's own view of the cards, taken before the board moved: once the
   * card they threw has left, the table has no thought for it to ask about.
   */
  view: ReadonlyMap<number, Set<Ord>> | undefined,
  misplay: boolean,
): DiscardInterp | undefined {
  if (!levelAllows(settings, 8)) return undefined;
  if (before.cardsRemaining > 0 || view === undefined) return undefined;

  const slot = before.cards[order]?.slot ?? 0;
  if (slot === 0) return undefined;

  const hand = handOrders(before, actor);
  if (hand.length === 0) return undefined;
  const trash = trashOrds(before);
  const knownRubbish = hand.every((held) => {
    const pool = view.get(held);
    return pool !== undefined && pool.size > 0 && [...pool].every((ord) => trash.has(ord));
  });
  if (!knownRubbish) return undefined;

  // A discard off the chop is the message; a discard *of* the chop is just a
  // discard. A misplay carries no such ambiguity — it is never the default.
  const chop = chopOf(before, thoughts, actor);
  if (!misplay && chop !== undefined && order === chop) return undefined;

  const receiver = positionalTarget(after, actor, slot);
  if (receiver === undefined) return undefined;
  const thought = thoughts.get(receiver);
  if (!thought) return undefined;

  const holder = after.players[after.cards[receiver]!.holder];
  const seen = visibleOrd(after, receiver);
  const narrowed =
    seen === undefined ? intersect(thought.possible, playableOrds(after)) : new Set([seen]);
  if (narrowed.size > 0) {
    thought.inferred = narrowed;
    thought.narrowed = true;
  }
  thought.status = "finessed";

  const kind: ActionInterpKind = misplay ? "positional misplay" : "positional discard";
  const how = misplay ? "misplayed" : "thrown";
  return {
    actionIndex,
    kind,
    orders: [receiver],
    identity: seen ?? -1,
    detail:
      `${kind} — slot ${slot} ${how} from a hand of rubbish, ` +
      `so ${holder} blind-plays slot ${slot}`,
  };
}

/** The seat a positional move points at: the last one holding a playable card there. */
function positionalTarget(
  state: GameState,
  actor: number,
  slot: number,
): number | undefined {
  const numPlayers = state.players.length;
  const playable = playableOrds(state);
  let visible: number | undefined;
  let ours: number | undefined;

  for (let i = 1; i < numPlayers; i++) {
    const seat = (actor + i) % numPlayers;
    const order = handOrders(state, seat).find((held) => state.cards[held]?.slot === slot);
    if (order === undefined) continue;
    const seen = visibleOrd(state, order);
    if (seen === undefined) ours = order;
    else if (playable.has(seen)) visible = order;
  }
  return visible ?? ours;
}

/**
 * What a player could tell about their own hand before they moved.
 *
 * The alarm discards are all defined by what the player *did not* do, so the
 * reading needs the position they were in: what they knew was playable, what
 * they knew was rubbish, and which card was their chop.
 *
 * This is what the *rest of the table* could see, which is the point of view
 * that reads the move. Everyone except the holder can see the cards, so the
 * table's note and the card itself both have to agree: a note claiming b2 over
 * a card that is really b3 is not something anyone builds a permanent chop move
 * on — they can see the promise is false, and what they are looking at is a fix
 * clue waiting to happen, not an alarm.
 *
 * Our own hand is the one nobody here can see, so nothing counts in it. That
 * costs us reading our *own* alarm discards, which is no loss: we know why we
 * discarded, and if it was a scream the card correction says so in one tap.
 */
interface Standing {
  chop: number | undefined;
  playable: number[];
  trash: number[];
}

function standingOf(state: GameState, thoughts: Map<number, Thought>, seat: number): Standing {
  const playable = playableOrds(state);
  const trash = trashOrds(state);
  const known = (order: number, allowed: ReadonlySet<Ord>): boolean => {
    const thought = thoughts.get(order);
    if (!thought) return false;
    const pool = possibilities(thought);
    if (pool.size === 0 || ![...pool].every((ord) => allowed.has(ord))) return false;
    const seen = visibleOrd(state, order);
    return seen !== undefined && allowed.has(seen);
  };
  const hand = handOrders(state, seat);
  return {
    chop: chopOf(state, thoughts, seat),
    playable: hand.filter((order) => known(order, playable)),
    trash: hand.filter((order) => known(order, trash)),
  };
}

/**
 * The emergency a Scream or Shout Discard is shouting about.
 *
 * The move only exists to stop the next player throwing away something the
 * team cannot spare, so there has to be something there to lose: their chop is
 * either the last copy of a card still wanted, or a card that plays right now.
 * When the chop is in our own hand nobody can check, and the reading stands —
 * that is exactly the case the convention is for.
 */
function nextChopInDanger(
  state: GameState,
  thoughts: Map<number, Thought>,
  seat: number,
): boolean {
  const chop = chopOf(state, thoughts, seat);
  if (chop === undefined) return false;
  const seen = visibleOrd(state, chop);
  if (seen === undefined) return true;
  return criticalOrds(state).has(seen) || playableOrds(state).has(seen);
}

/**
 * The Scream, Shout and Generation discards, level 7.
 *
 * All three are a player declining an obvious play, and the table reads the
 * refusal rather than the card.
 *
 * - **Scream Discard**: they throw away their *chop* while holding something
 *   they know plays — or something they know is rubbish and could have thrown
 *   instead. Nobody does that for fun, so it is an emergency: the next player's
 *   chop is unsafe and permanently moves one card to the left. It is a last
 *   resort, so it only reads as one at 0 clues, or at 1 when the next player is
 *   locked and could not have discarded either.
 * - **Shout Discard**: they throw away known rubbish while holding a known
 *   play. Same signal, same chop move, and allowed at any clue count.
 *
 * Both alarms need something to be alarmed about, so `nextChopInDanger` has to
 * agree: if the next player's chop is a card the team can spare, nobody was
 * screaming and the discard was just a discard.
 * - **Generation Discard**: they throw away the playable card itself, which is
 *   no alarm at all — it buys a clue for the next player and moves nobody's
 *   chop.
 */
function interpretAlarm(
  before: GameState,
  after: GameState,
  thoughts: Map<number, Thought>,
  standing: Standing,
  order: number,
  actor: number,
  actionIndex: number,
  settings: BotSettings,
): DiscardInterp | undefined {
  if (!levelAllows(settings, 7)) return undefined;

  const next = (actor + 1) % before.players.length;
  const chopMove = (kind: "scream" | "shout", why: string): DiscardInterp | undefined => {
    const chop = chopOf(after, thoughts, next);
    if (chop === undefined) return undefined;
    const thought = thoughts.get(chop);
    if (!thought) return undefined;
    thought.status = "chop moved";
    return {
      actionIndex,
      kind,
      orders: [chop],
      identity: -1,
      detail:
        `${kind} discard — ${why}, so ` +
        `${after.players[next]} chop moves slot ${slotOf(after, chop)}`,
    };
  };

  const hadPlay = standing.playable.length > 0;
  const danger = nextChopInDanger(before, thoughts, next);

  if (standing.trash.includes(order)) {
    return hadPlay && danger
      ? chopMove("shout", "known trash thrown away with a play in hand")
      : undefined;
  }

  if (order === standing.chop && danger && (hadPlay || standing.trash.length > 0)) {
    const lastResort =
      before.clueTokens === 0 || (before.clueTokens === 1 && isLocked(before, thoughts, next));
    if (!lastResort) return undefined;
    return chopMove(
      "scream",
      hadPlay ? "the chop went instead of a known play" : "the chop went instead of known trash",
    );
  }

  if (standing.playable.includes(order)) {
    return {
      actionIndex,
      kind: "generation",
      orders: [],
      identity: -1,
      detail: "generation discard — a playable card spent to buy a clue token",
    };
  }

  return undefined;
}

/**
 * The Order Chop Move, level 4.
 *
 * Unknown 1s are played in an agreed order: the ones drawn since the deal go
 * first, newest first, and then the ones from the starting hand, oldest first.
 * Playing out of that order is not a slip — each 1 skipped moves the chop of
 * the player that many seats along.
 *
 * The set only counts cards the table cannot tell apart. A 1 whose identity is
 * known, one carrying a different number of clues, and one already blind-playing
 * are all outside it, because there is a reason to play those out of turn.
 */
function detectOcm(
  before: GameState,
  thoughts: Map<number, Thought>,
  actor: number,
  played: number,
  settings: BotSettings,
): { seat: number; skipped: number } | undefined {
  if (!levelAllows(settings, 4)) return undefined;

  const clueCount = (order: number): number => {
    const knowledge = before.cards[order]?.knowledge;
    return (knowledge?.positiveColors.length ?? 0) + (knowledge?.positiveRanks.length ?? 0);
  };
  const unknownOne = (order: number): boolean => {
    const held = before.cards[order];
    const thought = thoughts.get(order);
    if (!held?.knowledge.clued || !thought) return false;
    if (thought.status === "finessed" || thought.status === "chop moved") return false;
    const pool = possibilities(thought);
    return pool.size > 1 && [...pool].every((ord) => identityOfOrd(ord).rank === 1);
  };

  if (!unknownOne(played)) return undefined;
  const group = handOrders(before, actor).filter(
    (order) => unknownOne(order) && clueCount(order) === clueCount(played),
  );
  if (group.length < 2) return undefined;

  const rank = (order: number): number =>
    (thoughts.get(order)?.drawnTurn ?? 0) === 0 ? order : -order;
  group.sort((a, b) => rank(a) - rank(b));

  const skipped = group.indexOf(played);
  if (skipped <= 0) return undefined;
  return { seat: (actor + skipped) % before.players.length, skipped };
}

interface InterpretInput {
  before: GameState;
  after: GameState;
  thoughts: Map<number, Thought>;
  action: GameAction;
  clue: Clue;
  actionIndex: number;
  touched: number[];
  previouslyClued: Set<number>;
  settings: BotSettings;
  ruledOut: readonly Ord[];
  reading: Ord | undefined;
  /** Orders under a play promise before the clue landed, for the fix check. */
  promisedBefore: ReadonlySet<number>;
  /** True until somebody makes a real chop discard, which gates the 5 chop move. */
  earlyGame: boolean;
  /** What the previous player threw away, for the double-discard position. */
  lastDiscard: Ord | undefined;
  /**
   * What every card could be *before* the clue landed.
   *
   * A tempo clue and a fill-in are both defined by what changed, so the reading
   * needs the previous notes as well as the new ones.
   */
  poolBefore: ReadonlyMap<number, Set<Ord>>;
}

interface InterpretResult {
  interp: ClueInterp;
  waiting: WaitingConnection[];
}

function interpretClue(input: InterpretInput): InterpretResult {
  const { before, after, thoughts, action, clue, actionIndex, touched, settings } = input;
  const target = action.target;
  const giver = before.currentPlayerIndex;
  const { focus, onChop } = determineFocus(
    before,
    thoughts,
    target,
    touched,
    input.previouslyClued,
    clue,
    settings,
    input.poolBefore,
  );

  // How stuck the giver was. It decides whether a 5 clued off chop is a chop
  // move or a stall, whether a clue that gets nothing is a chop move or a burn,
  // and which saves are on the table at all.
  const severity = levelAllows(settings, 9)
    ? stallSeverity({
        state: before,
        thoughts,
        giver,
        clueTokens: before.clueTokens,
        earlyGame: input.earlyGame,
        doubleDiscard: doubleDiscardRisk(before, thoughts, giver, input.lastDiscard),
      })
    : input.earlyGame
      ? Stall.EarlyGame
      : Stall.None;
  const endgame = levelAllows(settings, 8) && inEndgame(before);

  const shell: ClueInterp = {
    actionIndex,
    kind: "unclear",
    target,
    focus,
    touched,
    connections: [],
    alternatives: [],
    chosen: [],
    ruledOut: [...input.ruledOut],
    overridden: input.reading !== undefined,
    detail: "",
  };
  const nothing = (kind: ClueInterpKind, detail: string): InterpretResult => ({
    interp: { ...shell, kind, detail },
    waiting: [],
  });

  if (touched.length === 0) return nothing("useless", "touched nothing");

  const focusThought = thoughts.get(focus);
  if (!focusThought) return nothing("unclear", "focus already gone");

  const stacks = hypoStacks(after, thoughts);
  const trash = trashOrds(after);

  // A fix outranks everything: it is about a card that was already spoken for.
  if (levelAllows(settings, 3)) {
    const fixed = detectFix(thoughts, touched, input.promisedBefore, input.previouslyClued, trash);
    if (fixed.length > 0) {
      for (const order of fixed) {
        const thought = thoughts.get(order);
        if (!thought) continue;
        resetThought(thought);
        thought.reset = true;
      }
      return nothing("fix", "stops a card being misplayed");
    }
  }

  const allTrash = [...focusThought.possible].every((ord) => trash.has(ord));

  // Chop moves: the clue is not about its own focus, it is about what is behind
  // it. Level 8 switches them off in the end-game — there is no future left to
  // hold a card back for, so the clue has to mean something else.
  if (levelAllows(settings, 4) && !endgame) {
    const moved = detectTcm(
      after,
      thoughts,
      target,
      touched,
      focus,
      clue,
      input.previouslyClued,
      trash,
    );
    if (moved.length > 0) {
      for (const order of moved) {
        const thought = thoughts.get(order);
        if (thought) thought.status = "chop moved";
      }
      const names = moved.map((order) => `${after.players[target]} slot ${slotOf(after, order)}`);
      return nothing("chop move", `trash chop move — hold ${names.join(", ")}`);
    }

    const fiveCm = detect5cm(
      before,
      after,
      thoughts,
      target,
      touched,
      clue,
      input.previouslyClued,
      severity,
      trash,
    );
    if (fiveCm !== undefined) {
      const chopThought = thoughts.get(fiveCm);
      if (chopThought) chopThought.status = "chop moved";
      return nothing(
        "chop move",
        `5 chop move — hold ${after.players[target]} slot ${slotOf(after, fiveCm)}`,
      );
    }
  }

  // Tempo clues, level 6: a clue that touched nothing new. It is not asking
  // for a new card, it is asking for one already clued to be played now — and
  // when it was not worth a whole clue on its own, it carries a chop move.
  let tempo: TempoRead | undefined;
  if (levelAllows(settings, 6)) {
    const { previouslyClued, poolBefore } = input;
    tempo = readTempo(after, thoughts, target, touched, focus, previouslyClued, poolBefore);
    if (tempo) {
      if (!tempo.valuable && severity >= Stall.DoubleDiscard) {
        const why = severityName(severity);
        return nothing("stall", `tempo clue stall — ${why}, so it says nothing more`);
      }
      if (!tempo.valuable && !endgame && levelAllows(settings, 4)) {
        const chop = chopOf(before, thoughts, target);
        const chopThought = chop === undefined ? undefined : thoughts.get(chop);
        if (chop !== undefined && chopThought) {
          chopThought.status = "chop moved";
          tempo = {
            ...tempo,
            chopMoved: `, and chop moves ${after.players[target]} slot ${slotOf(after, chop)}`,
          };
        }
      }
    }
  }

  // A clue that could be a save, or any colour clue, reads as being about the
  // card it touched. That is what stops the receiver hunting in their own hand.
  const savePoss = savePossibilities(after, thoughts, clue, focus, onChop, giver);
  const looksDirect =
    possibilities(focusThought).size > 1 && (clue.kind === "color" || savePoss.length > 0);

  const ctx: ConnectContext = {
    state: after,
    before,
    thoughts,
    giver,
    target,
    focus,
    settings,
    looksDirect,
    stacks: [...after.playStacks],
    hypo: stacks,
  };

  // "Playable" means playable *now*. Anything further up has to be justified by
  // naming the cards in between, which is what makes the promise visible.
  const playable = playableOrds(after);
  const playPoss: FocusPossibility[] = [];
  for (const ord of possibilities(focusThought)) {
    if (savePoss.some((fp) => fp.identity === ord)) continue;
    // Somebody else is already known to be holding this one; a clue does not
    // promise a card the table has already placed.
    if (claimedElsewhere(after, thoughts, ord, focus)) continue;
    if (playable.has(ord)) {
      playPoss.push({ identity: ord, connections: [], save: false });
      continue;
    }
    const connections = connect(ctx, ord);
    if (connections) playPoss.push({ identity: ord, connections, save: false });
  }

  const struck = new Set(input.ruledOut);
  const all = [...savePoss, ...playPoss].filter((fp) => !struck.has(fp.identity));
  shell.alternatives = [...savePoss, ...playPoss];

  // Your reading wins over the bot's, and over Occam's razor.
  const forced = input.reading;
  const simplest =
    forced !== undefined
      ? (all.find((fp) => fp.identity === forced) ?? {
          identity: forced,
          connections: [],
          save: false,
        })
      : undefined;
  const readings = simplest ? [simplest] : occamsRazor(all, target, after.ourPlayerIndex);

  if (readings.length === 0) {
    if (allTrash) return nothing("useless", "touched only trash");

    // Nothing gets played by it. H-Group has a whole ladder of clues that are
    // allowed to say nothing, but only from a position where the giver could
    // not discard — and only in order, most informative first.
    //
    // The 5 Stall is the one that is on from level 2, because it is how the
    // early game gets padded out; the rest arrive at level 9 with the stalling
    // conventions proper.
    const fiveStall = isFiveStall(before, thoughts, target, clue, focus, onChop, severity);
    if (levelAllows(settings, 2) && fiveStall) {
      focusThought.status = "saved";
      const why = severityName(severity);
      return nothing("stall", `5 stall — ${why}, and a 5 is the safe thing to clue`);
    }

    if (levelAllows(settings, 9)) {
      const touchedNew = touched.some((order) => !input.previouslyClued.has(order));
      const narrowedSomething = touched.some((order) => {
        const thought = thoughts.get(order);
        const was = input.poolBefore.get(order)?.size ?? Number.POSITIVE_INFINITY;
        return thought !== undefined && possibilities(thought).size < was;
      });

      const why = severityName(severity);

      if (isFillIn(touchedNew, narrowedSomething, severity)) {
        return nothing("stall", `fill-in clue — ${why}, so it only tidies up what is known`);
      }
      if (allowsLockedHandSave(severity, onChop)) {
        focusThought.status = "saved";
        return nothing("save", "locked hand save — no discard is legal, so any chop card may go");
      }
      if (allowsEightClueSave(after, severity, focus)) {
        focusThought.status = "saved";
        return nothing("save", "8 clue save — at 8 clues anything off finesse position may go");
      }
      if (isHardBurn(touchedNew, narrowedSomething, severity)) {
        return nothing("stall", `hard burn — ${why}, and there was nothing left to say`);
      }
      if (severity >= Stall.DoubleDiscard) {
        return nothing("stall", `no reading fits, but ${why} forced a clue — a stall`);
      }
    }
    // Say what is odd about it rather than just shrugging. Far and away the
    // commonest cause is a table saving a critical card that is not on chop,
    // which H-Group does not do but plenty of tables at a real table do.
    const critical = criticalOrds(after);
    const lastCopy = [...possibilities(focusThought)].every((ord) => critical.has(ord));
    return nothing(
      "unclear",
      lastCopy
        ? `no reading found — but the card is the last ${[...possibilities(focusThought)]
            .map((ord) => shortId(after, identityOfOrd(ord)))
            .join(" or ")}, so this may be a save off chop`
        : "no reading found for this clue",
    );
  }

  const chosen = readings.map((fp) => fp.identity);
  focusThought.focused = true;
  focusThought.narrowed = true;
  const narrowed = intersect(focusThought.possible, new Set(chosen));
  // Your word survives a card the clues appear to rule out.
  focusThought.inferred = narrowed.size > 0 ? narrowed : new Set(chosen);

  // scala-bot's rule, and the safe one: if any surviving reading is a save, the
  // clue is a save. A card that might be the last 5 is not played on the chance
  // that it is instead the playable 2.
  const isSave = readings.some((fp) => fp.save);
  const waiting: WaitingConnection[] = [];
  const name = (ord: Ord): string => shortId(after, identityOfOrd(ord));

  if (isSave) {
    focusThought.status = "saved";
    const saves = readings.filter((fp) => fp.save).map((fp) => name(fp.identity));
    const plays = readings.filter((fp) => !fp.save).map((fp) => name(fp.identity));
    const detail =
      plays.length > 0
        ? `save on chop (${saves.join(", ")}) — or a play clue for ${plays.join(", ")}`
        : `save on chop (${saves.join(", ")})`;
    return { interp: { ...shell, kind: "save", chosen, detail }, waiting };
  }

  focusThought.status = "called to play";
  // Every surviving reading is promised, not just an unambiguous one. A finesse
  // is answered on the very next turn, so a reading that asks for a blind play
  // has to be written down even while a simpler reading is still alive — and if
  // the blind play never comes, that is exactly what refutes it later.
  assignConnections(after, thoughts, readings, settings, giver);
  for (const reading of readings) {
    if (!reading.connections.some((link) => link.kind !== "known")) continue;
    waiting.push({
      actionIndex,
      focus,
      identity: reading.identity,
      connections: reading.connections,
      index: 0,
      giver,
      target,
      turn: before.turn,
    });
  }

  const seat = (link: Connection): string =>
    `${after.players[link.playerIndex]} slot ${slotOf(after, link.order)}`;
  const via = (fp: FocusPossibility): string =>
    fp.connections.map((link) => `${link.kind} ${name(link.identity)} (${seat(link)})`).join(" → ");

  const working = readings.filter((fp) => fp.connections.length > 0);
  shell.connections = working[0]?.connections ?? [];

  let detail: string;
  if (tempo) {
    const kind = tempo.chopMoved
      ? "tempo clue chop move"
      : tempo.valuable
        ? "valuable tempo clue"
        : "tempo clue";
    detail = `${kind} — ${tempo.reason}${tempo.chopMoved ?? ""}`;
  } else if (readings.length === 1) {
    detail = working.length > 0 ? `play clue, through ${via(readings[0])}` : "play clue";
  } else {
    const names = chosen.length <= 4 ? ` (${chosen.map(name).join(" or ")})` : "";
    const asks = working.map((fp) => `${name(fp.identity)} would need ${via(fp)}`);
    detail = `play clue${names}${asks.length > 0 ? ` — ${asks.join("; ")}` : ""}`;
  }

  return { interp: { ...shell, kind: tempo ? "tempo" : "play", chosen, detail }, waiting };
}

/**
 * Writes the promise onto every card the surviving readings depend on.
 *
 * When more than one reading survives they are written in turn, and a card two
 * readings both lean on keeps both identities rather than the second overwriting
 * the first — scala-bot's `modified` set. Claiming to know which of them it is
 * would be inventing information the table does not have.
 */
function assignConnections(
  state: GameState,
  thoughts: Map<number, Thought>,
  readings: readonly FocusPossibility[],
  settings: BotSettings,
  giver: number,
): void {
  const playable = playableOrds(state);
  const written = new Set<number>();
  const seat = bluffSeat(state.players.length, giver);

  for (const reading of readings) {
    // A bluff can only be the first blind play of a reading, and only when the
    // reading asks for one — scala-bot's `finalizeConns`. Deeper layers are
    // reached through it, so they are not in doubt the same way.
    //
    // It also has to come from the seat directly after the giver. From anywhere
    // else the same clue is a Layered Finesse and the blind play really is the
    // card that was promised, so widening its note would be inventing doubt.
    const first = reading.connections[0];
    const bluffable =
      levelAllows(settings, 11) &&
      first?.kind === "finesse" &&
      first.playerIndex === seat &&
      reading.connections.filter((link) => link.kind === "finesse").length === 1
        ? first
        : undefined;

    for (const link of reading.connections) {
      if (link.order < 0) continue;
      const thought = thoughts.get(link.order);
      if (!thought || thought.reset) continue;

      thought.status = link.kind === "finesse" ? "finessed" : "called to play";
      thought.hidden = link.hidden;

      // A blind play is promised a specific card, so its note says so even
      // though nothing has touched it. A prompt is held to what the clues allow.
      let pinned =
        link.kind === "finesse"
          ? new Set([link.identity])
          : intersect(thought.possible, new Set([link.identity]));

      // Bluffs, level 11. Told to play blind, you play — but the card need not
      // be the one the clue was pointing at. It only has to be playable, which
      // is exactly what a bluff exploits, so the note keeps every playable
      // identity the card could be rather than claiming to know which. Nobody
      // can see their own hand, so this holds however well *we* can see it.
      if (link === bluffable || link.bluff) {
        const alsoPlayable = intersect(thought.possible, playable);
        if (alsoPlayable.size > 0 && !subsetOf(alsoPlayable, pinned)) {
          pinned = new Set([...pinned, ...alsoPlayable]);
        }
        thought.bluffed = true;
      }

      // A card an earlier reading already spoke for keeps what that reading
      // said as well: between them, all the table knows is that it is one of.
      if (written.has(link.order)) pinned = new Set([...thought.inferred, ...pinned]);
      written.add(link.order);

      if (pinned.size > 0) {
        thought.inferred = pinned;
        thought.narrowed = true;
      }
    }
  }
}

function subsetOf(a: ReadonlySet<Ord>, b: ReadonlySet<Ord>): boolean {
  for (const ord of a) if (!b.has(ord)) return false;
  return true;
}

interface Pass {
  analysis: BotAnalysis;
  disproven: Disproof[];
}

/**
 * Why the convention reader will not touch a variant, or undefined if it will.
 *
 * H-Group is written for ordinary stacks and ordinary clues. Chop, finesse
 * position and "a 1 clue means these are playable" all stop holding when 1s
 * answer to every colour, when a rank clue takes a whole range, when a stack can
 * run downwards, or when the clue's value never reaches the player at all. The
 * conventions for those variants are different, and the bot does not know them —
 * so it stands down rather than producing confident nonsense, and the tracker
 * underneath goes on recording the game exactly as it always does.
 *
 * Suits that behave oddly are fine: Rainbow, Pink, Prism, dual-colour and
 * ambiguous suits all reach the reader through `cardTouched` and need no special
 * handling. It is the variant-level rules that break it.
 */
export function unsupportedVariantReason(variant: Variant): string | undefined {
  const r = variant.rules;
  if (r.upOrDown) return "stacks can run either way in Up or Down";
  if (r.sudoku) return "Sudoku stacks start anywhere and wrap";
  if (variant.suits.some((suit) => suit.reversed)) return "reversed suits run downwards";
  if (r.specialRank) return `${r.specialRank}s follow their own clue rules`;
  if (r.funnels || r.chimneys) return "one rank clue touches a whole range";
  if (r.oddsAndEvens) return "rank clues name parity, not a number";
  if (r.synesthesia) return "colour clues double as rank clues";
  if (r.cowAndPig || r.duck) return "the clue's value never reaches the player";
  if (r.colorCluesTouchNothing || r.rankCluesTouchNothing) return "clues touch nothing";
  if (variant.clueColors.length === 0) return "there are no colour clues";
  if (variant.clueRanks.length === 0) return "there are no rank clues";
  if (r.clueStarved) return "a discard is only worth half a clue";
  if (r.alternatingClues) return "clue types have to alternate";
  if (r.throwItInAHole) return "plays are face down and the score is hidden";
  return undefined;
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
  overrides: BotOverrides = NO_OVERRIDES,
  through = Number.POSITIVE_INFINITY,
): BotAnalysis {
  const variant = getVariant(record.variantName);
  const unsupported = unsupportedVariantReason(variant);
  if (unsupported) return standDown(record, variant, settings, overrides, through, unsupported);

  const ruledOut: RuledOut = {};
  const history: Disproof[] = [];
  let pass = analyseOnce(record, settings, overrides, through, ruledOut);

  // Each refuted reading is struck out and the game read again from the top, so
  // everything downstream of the change follows from the new reading rather
  // than being patched on top of the old one.
  for (let attempt = 0; attempt < MAX_REINTERPRETATIONS && pass.disproven.length > 0; attempt++) {
    let added = false;
    for (const disproof of pass.disproven) {
      const list = (ruledOut[disproof.actionIndex] ??= []);
      if (list.includes(disproof.identity)) continue;
      list.push(disproof.identity);
      history.push(disproof);
      added = true;
    }
    if (!added) break;
    pass = analyseOnce(record, settings, overrides, through, ruledOut);
  }

  return { ...pass.analysis, reinterpretations: history };
}

/**
 * The board, replayed, with no reading on top of it: no thoughts, no clue
 * interpretations, nothing waiting. Everything downstream treats an empty
 * thought map as "nothing to say about this card", which is exactly right here.
 */
function standDown(
  record: GameRecord,
  variant: Variant,
  settings: BotSettings,
  overrides: BotOverrides,
  through: number,
  unsupported: string,
): BotAnalysis {
  const limit = Math.min(record.actions.length, through);
  const state = replay(
    {
      players: record.players,
      ourPlayerIndex: record.ourPlayerIndex,
      variant,
      deck: record.deck,
      actions: record.actions,
      touchedByAction: record.touchedByAction,
      options: record.options,
    },
    limit,
  );
  return {
    state,
    unsupported,
    thoughts: new Map(),
    interps: [],
    discards: [],
    settings,
    overrides,
    waiting: [],
    reinterpretations: [],
    earlyGame: true,
    lastDiscard: undefined,
    actionCount: limit,
  };
}

function analyseOnce(
  record: GameRecord,
  settings: BotSettings,
  overrides: BotOverrides,
  through: number,
  ruledOut: RuledOut,
): Pass {
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
  const discards: DiscardInterp[] = [];
  const disproven: Disproof[] = [];
  let waiting: WaitingConnection[] = [];
  // H-Group's early game: it ends the first time somebody genuinely discards
  // off their chop, and until then a 5 on chop is an ordinary early-game save
  // rather than a chop move.
  let earlyGame = true;
  // What the previous player threw away, which is what puts the next one in a
  // double-discard position.
  let lastDiscard: Ord | undefined;

  for (let actionIndex = 0; actionIndex < limit; actionIndex++) {
    const action = record.actions[actionIndex];
    const before = state;
    const actor = before.currentPlayerIndex;
    const clue = clueOf(action);
    const done = actionIndex + 1;

    // Snapshotted before the board moves. Almost every reading below is about
    // what the action took away or declined to do — a fix by the promise it
    // destroys, a sarcastic discard by what the table knew of the card that
    // left, a scream by the play that was passed over, a tempo clue by the
    // notes it changed — so all of it has to be read while it still stands.
    const promisedBefore = new Set<number>();
    const poolBefore = new Map<number, Set<Ord>>();
    for (const [order, thought] of thoughts) {
      if (isPlayPromised(thought)) promisedBefore.add(order);
      poolBefore.set(order, new Set(possibilities(thought)));
    }
    const movedOrder =
      action.type === ActionType.Play || action.type === ActionType.Discard ? action.target : -1;
    const movedThought = movedOrder >= 0 ? thoughts.get(movedOrder) : undefined;
    const knownBefore = new Set<Ord>(movedThought ? possibilities(movedThought) : []);
    const standing = standingOf(before, thoughts, actor);
    // What the mover could tell about their *own* hand, which is the whole
    // precondition for a positional move. Only worth asking once the deck is
    // dead, which is the only position H-Group allows the move from.
    const ownView =
      levelAllows(settings, 8) && !clue && before.cardsRemaining === 0
        ? perspectiveOf(before, thoughts, actor)
        : undefined;
    const ocm =
      action.type === ActionType.Play
        ? detectOcm(before, thoughts, actor, movedOrder, settings)
        : undefined;
    const wasEarlyGame = earlyGame;
    const gone = trashOrds(before);
    const wasTrash = movedThought
      ? [...possibilities(movedThought)].every((ord) => gone.has(ord))
      : false;
    // The early game ends the first time somebody throws away a card nobody
    // knew anything about. A known-trash discard is not that, and neither is a
    // misplay: both leave the team still owing all its play and save clues.
    if (
      earlyGame &&
      action.type === ActionType.Discard &&
      !before.cards[movedOrder]?.knowledge.clued &&
      movedThought?.status === "none" &&
      !wasTrash
    ) {
      earlyGame = false;
    }

    state = replay(base, done);
    syncThoughts(state, thoughts, state.turn);
    // Only corrections you had already made: a correction recorded *at* this
    // action describes the board once it has been read, not while reading it.
    settle(state, thoughts, settings, overrides, actionIndex);

    // Judge the outstanding promises against what just happened, before reading
    // any new clue: a clue given *instead* of a blind play is itself the refutation.
    const update = updateWaiting(
      before,
      state,
      thoughts,
      waiting,
      action,
      actor,
      actionIndex,
      settings,
    );
    waiting = update.kept;
    disproven.push(...update.disproven);

    if (clue) {
      const touched = touchedOrders(
        before,
        action.target,
        clue,
        record.touchedByAction[actionIndex],
      );
      const previouslyClued = new Set(
        handOrders(before, action.target).filter((order) => before.cards[order]?.knowledge.clued),
      );

      const result = interpretClue({
        before,
        after: state,
        thoughts,
        action,
        clue,
        actionIndex,
        touched,
        previouslyClued,
        settings,
        ruledOut: ruledOut[actionIndex] ?? [],
        reading: overrides.clues[actionIndex]?.identity,
        promisedBefore,
        earlyGame: wasEarlyGame,
        lastDiscard,
        poolBefore,
      });
      interps.push(result.interp);
      waiting = [...waiting, ...result.waiting];
      lastDiscard = undefined;
    } else if (action.type === ActionType.Discard) {
      // In order of how loudly they speak: handing a card over, then sounding
      // the alarm.
      const handover = interpretDiscard(
        state,
        thoughts,
        movedOrder,
        actor,
        actionIndex,
        knownBefore,
        settings,
      );
      const spoke =
        handover ??
        interpretPositional(
          before,
          state,
          thoughts,
          movedOrder,
          actor,
          actionIndex,
          settings,
          ownView,
          false,
        ) ??
        interpretAlarm(
          before,
          state,
          thoughts,
          standing,
          movedOrder,
          actor,
          actionIndex,
          settings,
        );
      if (spoke) discards.push(spoke);
      const gone = state.cards[movedOrder];
      lastDiscard = gone && isKnown(gone.identity) ? ordOf(gone.identity) : undefined;
    } else if (action.type === ActionType.Play) {
      // A card bombed out of a hand its holder knew was worthless is not a
      // slip: it is a Positional Misplay, and the slot is the message.
      if (state.cards[movedOrder]?.failed) {
        const positional = interpretPositional(
          before,
          state,
          thoughts,
          movedOrder,
          actor,
          actionIndex,
          settings,
          ownView,
          true,
        );
        if (positional) discards.push(positional);
      }
      // A card that struck was not the 1 everybody took it for, so the order it
      // came down in says nothing — the fix clue that follows does.
      if (ocm && !state.cards[movedOrder]?.failed) {
        const chop = chopOf(state, thoughts, ocm.seat);
        const thought = chop === undefined ? undefined : thoughts.get(chop);
        if (chop !== undefined && thought) {
          thought.status = "chop moved";
          discards.push({
            actionIndex,
            kind: "order chop move",
            orders: [chop],
            identity: -1,
            detail:
              `order chop move — ${ocm.skipped} skipped, so ` +
              `${state.players[ocm.seat]} chop moves slot ${slotOf(state, chop)}`,
          });
        }
      }
      // A misplayed card lands in the discard pile like any other, so it can
      // leave the next player in a double-discard position just the same.
      const struck = state.cards[movedOrder];
      lastDiscard = struck?.failed && isKnown(struck.identity) ? ordOf(struck.identity) : undefined;
    }

    settle(state, thoughts, settings, overrides, done);
  }

  return {
    analysis: {
      state,
      thoughts,
      interps,
      discards,
      settings,
      overrides,
      waiting,
      reinterpretations: [],
      earlyGame,
      lastDiscard,
      actionCount: limit,
    },
    disproven,
  };
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
  const promisedBefore = new Set<number>();
  const poolBefore = new Map<number, Set<Ord>>();
  for (const [order, thought] of thoughts) {
    if (isPlayPromised(thought)) promisedBefore.add(order);
    poolBefore.set(order, new Set(possibilities(thought)));
  }

  syncThoughts(after, thoughts, after.turn);
  settle(after, thoughts, analysis.settings, analysis.overrides, actions.length);
  const { interp } = interpretClue({
    before,
    after,
    thoughts,
    action,
    clue,
    actionIndex: analysis.actionCount,
    touched,
    previouslyClued,
    settings: analysis.settings,
    ruledOut: [],
    reading: undefined,
    promisedBefore,
    earlyGame: analysis.earlyGame,
    lastDiscard: analysis.lastDiscard,
    poolBefore,
  });
  settle(after, thoughts, analysis.settings, analysis.overrides, actions.length);

  return { interp, thoughts, after };
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

/** The stacks as they will stand once every promise has been kept. */
export function analysisStacks(analysis: BotAnalysis): number[] {
  return hypoStacks(analysis.state, analysis.thoughts);
}

/** Ordinals playable once every promise has been kept. */
export function hypoPlayable(analysis: BotAnalysis): Set<Ord> {
  return playableAgainst(analysisStacks(analysis));
}

export { playableOrds };
