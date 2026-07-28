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
import { clueOf, replay, touchedOrders, type GameState } from "../hanabi/engine";
import { getVariant, identityName } from "../hanabi/variants";
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
  handOrders,
  hypoStacks,
  identityOfOrd,
  intersect,
  isPlayPromised,
  newThought,
  ordOf,
  playableAgainst,
  playableOrds,
  possibilities,
  refreshPossible,
  resetThought,
  settled,
  trashOrds,
  worthSavingOrds,
  type Ord,
  type Thought,
} from "./empathy";
import {
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

/** Something a discard said, which in H-Group can be as loud as a clue. */
export interface DiscardInterp {
  actionIndex: number;
  kind: "sarcastic";
  /** Cards the discard pointed at. */
  orders: number[];
  identity: Ord;
  detail: string;
}

export interface BotAnalysis {
  state: GameState;
  thoughts: Map<number, Thought>;
  interps: ClueInterp[];
  /** Discards that meant something beyond getting a clue token back. */
  discards: DiscardInterp[];
  settings: BotSettings;
  overrides: BotOverrides;
  /** Promises the table is still waiting on. */
  waiting: WaitingConnection[];
  /** Readings the bot abandoned mid-game, with what refuted them. */
  reinterpretations: Disproof[];
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

/**
 * Another card the whole table has already pinned to this identity.
 *
 * A save is not a save if everyone can see the copy is safe elsewhere, and a
 * play clue does not promise a card someone is already known to be holding.
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
    if (pool.size === 1 && pool.has(ord)) return true;
  }
  return false;
}

/**
 * The readings under which the clue means "hold onto this".
 *
 * Only ever on chop, and scala-bot's three rules apply: the card has to still
 * be wanted, no copy may already be accounted for elsewhere, and the clue has
 * to be one that saves that card — 5s and 2s by rank, anything critical by
 * either. A 1 is never saved; there are five of them.
 */
function savePossibilities(
  state: GameState,
  thoughts: Map<number, Thought>,
  clue: Clue,
  focus: number,
  onChop: boolean,
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
        ? isCritical
        : clue.value === identity.rank && (identity.rank === 5 || identity.rank === 2 || isCritical);

    if (saves) out.push({ identity: ord, connections: [], save: true });
  }
  return out;
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
 * A card that was promised playable and can no longer be any playable identity
 * has been fixed; the clue promises nothing new.
 *
 * `promisedBefore` is the set of orders that were under a play promise *before*
 * the clue landed, because the promise is the first thing the clue destroys —
 * reading it off the current state would find nothing to have fixed.
 */
function detectFix(
  state: GameState,
  thoughts: Map<number, Thought>,
  target: number,
  stacks: readonly number[],
  promisedBefore: ReadonlySet<number>,
): number[] {
  const playable = playableAgainst(stacks);
  const fixed: number[] = [];
  for (const order of handOrders(state, target)) {
    if (!promisedBefore.has(order)) continue;
    const thought = thoughts.get(order);
    if (!thought) continue;
    if (intersect(thought.possible, playable).size === 0) fixed.push(order);
  }
  return fixed;
}

/**
 * The Sarcastic Discard, level 3.
 *
 * Throwing away a card the whole table knew you were holding is not a waste —
 * it says the other copy is out there, and points at whichever clued card could
 * be it. scala-bot's `basics/sarcastic.scala`.
 *
 * @param knownBefore what common knowledge made of the card as it was discarded
 */
function interpretDiscard(
  state: GameState,
  thoughts: Map<number, Thought>,
  order: number,
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
  if (candidates.length === 0) return undefined;

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
}

interface InterpretResult {
  interp: ClueInterp;
  waiting: WaitingConnection[];
}

function interpretClue(input: InterpretInput): InterpretResult {
  const { before, after, thoughts, action, clue, actionIndex, touched, settings } = input;
  const target = action.target;
  const giver = before.currentPlayerIndex;
  const { focus, onChop } = determineFocus(before, thoughts, target, touched, input.previouslyClued);

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

  // A fix outranks everything: it is about a card that was already promised.
  if (levelAllows(settings, 3)) {
    const fixed = detectFix(after, thoughts, target, after.playStacks, input.promisedBefore);
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
        return nothing("chop move", five ? "5 chop move" : "trash chop move");
      }
    }
  }

  // A clue that could be a save, or any colour clue, reads as being about the
  // card it touched. That is what stops the receiver hunting in their own hand.
  const savePoss = savePossibilities(after, thoughts, clue, focus, onChop);
  const looksDirect =
    possibilities(focusThought).size > 1 && (clue.kind === "color" || savePoss.length > 0);

  const ctx: ConnectContext = {
    state: after,
    thoughts,
    giver,
    target,
    focus,
    settings,
    looksDirect,
    stacks,
  };

  const playable = playableAgainst(stacks);
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
  const readings = simplest ? [simplest] : occamsRazor(all);

  if (readings.length === 0) {
    if (allTrash) return nothing("useless", "touched only trash");
    // Nothing fits — but at 8 clues a discard is illegal, so the giver had to
    // say *something*. That is a stall, not a mistake, and worth distinguishing.
    if (levelAllows(settings, 9) && before.clueTokens >= MAX_CLUE_TOKENS) {
      return nothing("stall", "no reading fits, but at 8 clues a clue was forced — a stall");
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
  // Only write connections when the reading is unambiguous. Two readings that
  // disagree about who blind-plays promise nothing to anyone yet.
  const agreed = readings.length === 1 ? readings[0] : undefined;
  if (agreed) {
    assignConnections(after, thoughts, agreed, settings);
    if (agreed.connections.some((link) => link.kind !== "known")) {
      waiting.push({
        actionIndex,
        focus,
        identity: agreed.identity,
        connections: agreed.connections,
        index: 0,
        giver,
        target,
        turn: before.turn,
      });
    }
  }
  shell.connections = agreed?.connections ?? [];

  const links = shell.connections;
  const detail =
    links.length > 0
      ? `play clue, through ${links
          .map((link) => `${link.kind} ${name(link.identity)}`)
          .join(" → ")}`
      : chosen.length > 1 && chosen.length <= 3
        ? `play clue (${chosen.map(name).join(" or ")})`
        : "play clue";

  return { interp: { ...shell, kind: "play", chosen, detail }, waiting };
}

/** Writes the promise onto every card a reading depends on. */
function assignConnections(
  state: GameState,
  thoughts: Map<number, Thought>,
  reading: FocusPossibility,
  settings: BotSettings,
): void {
  const playable = playableOrds(state);
  // A bluff can only be the first blind play of a reading, and only when the
  // reading asks for one — scala-bot's `finalizeConns`. Deeper layers are
  // reached through it, so they are not in doubt the same way.
  const bluffable =
    levelAllows(settings, 11) &&
    reading.connections.filter((link) => link.kind === "finesse").length === 1 &&
    reading.connections[0]?.kind === "finesse"
      ? reading.connections[0]
      : undefined;

  for (const link of reading.connections) {
    if (link.order < 0) continue;
    const thought = thoughts.get(link.order);
    if (!thought || thought.reset) continue;

    thought.status = link.kind === "finesse" ? "finessed" : "called to play";
    thought.hidden = link.hidden;

    // A blind play is promised a specific card, so its note says so even though
    // nothing has touched it. A prompt is held to what the clues already allow.
    let pinned =
      link.kind === "finesse"
        ? new Set([link.identity])
        : intersect(thought.possible, new Set([link.identity]));

    // Bluffs, level 11. Told to play blind, you play — but the card need not be
    // the one the clue was pointing at. It only has to be playable, which is
    // exactly what a bluff exploits, so the note keeps every playable identity
    // the card could be rather than claiming to know which. Nobody can see
    // their own hand, so this holds however well *we* can see the card.
    if (link === bluffable) {
      const alsoPlayable = intersect(thought.possible, playable);
      if (alsoPlayable.size > 0 && !subsetOf(alsoPlayable, pinned)) {
        pinned = new Set([...pinned, ...alsoPlayable]);
        thought.bluffed = true;
      }
    }

    if (pinned.size > 0) {
      thought.inferred = pinned;
      thought.narrowed = true;
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

  for (let actionIndex = 0; actionIndex < limit; actionIndex++) {
    const action = record.actions[actionIndex];
    const before = state;
    const actor = before.currentPlayerIndex;
    const clue = clueOf(action);
    const done = actionIndex + 1;

    // Snapshotted before the board moves: a fix clue is recognised by what it
    // takes away, and a sarcastic discard by what the table knew of the card
    // that left, so both have to be read while they still stand.
    const promisedBefore = new Set<number>();
    for (const [order, thought] of thoughts) {
      if (isPlayPromised(thought)) promisedBefore.add(order);
    }
    const movedOrder =
      action.type === ActionType.Play || action.type === ActionType.Discard ? action.target : -1;
    const movedThought = movedOrder >= 0 ? thoughts.get(movedOrder) : undefined;
    const knownBefore = new Set<Ord>(movedThought ? possibilities(movedThought) : []);

    state = replay(base, done);
    syncThoughts(state, thoughts, state.turn);
    // Only corrections you had already made: a correction recorded *at* this
    // action describes the board once it has been read, not while reading it.
    settle(state, thoughts, settings, overrides, actionIndex);

    // Judge the outstanding promises against what just happened, before reading
    // any new clue: a clue given *instead* of a blind play is itself the refutation.
    const update = updateWaiting(before, state, thoughts, waiting, action, actor, actionIndex);
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
      });
      interps.push(result.interp);
      waiting = [...waiting, ...result.waiting];
    } else if (action.type === ActionType.Discard) {
      const discard = interpretDiscard(
        state,
        thoughts,
        movedOrder,
        actionIndex,
        knownBefore,
        settings,
      );
      if (discard) discards.push(discard);
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
  for (const [order, thought] of thoughts) {
    if (isPlayPromised(thought)) promisedBefore.add(order);
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
