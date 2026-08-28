/**
 * The conventions above level 5, tested the way the level-1-to-5 ones are: by
 * building the smallest table that forces the reading, and asserting on what
 * the bot says the clue meant.
 *
 * Every game here is dealt the way hanab.live deals — seat 0's whole hand, then
 * seat 1's, and within a seat the *highest* order is slot 1. Seat 0 is us, so
 * our own cards are hidden from the reader even where the deck names them.
 */
import { describe, expect, it } from "vitest";
import fixture from "../hanabi/fixtures/live-game-4p.json";
import { fromHanabLive } from "../hanabi/hanabLive";
import { ActionType, type GameAction, type GameRecord, type Identity } from "../hanabi/types";
import { DEFAULT_BOT_SETTINGS, type BotSettings } from "./conventions";
import { analyse, determineFocus } from "./hgroup";
import { occamsRazor, type Connection, type FocusPossibility } from "./connect";
import { ordOf, possibilities, type Ord } from "./empathy";
import { botNote } from "./notes";
import { suggestMoves } from "./suggest";

const RED = 0;
const YELLOW = 1;
const GREEN = 2;
const BLUE = 3;
const PURPLE = 4;

function id(suitIndex: number, rank: number): Identity {
  return { suitIndex, rank };
}

const UNSEEN: Identity = { suitIndex: -1, rank: -1 };

function at(level: number): BotSettings {
  return { ...DEFAULT_BOT_SETTINGS, level };
}

/** Cards nobody in these games ever draws, so their faces never matter. */
function pad(count: number): Identity[] {
  return Array.from({ length: count }, () => id(YELLOW, 3));
}

interface Table {
  /** Seat hands, oldest card first — so the last entry of each is slot 1. */
  hands: Identity[][];
  actions: GameAction[];
  /** Cards drawn later, in order, starting at the first order past the deal. */
  draws?: Identity[];
  touchedByAction?: Record<number, number[]>;
}

function table({ hands, actions, draws = [], touchedByAction = {} }: Table): GameRecord {
  return {
    id: "test",
    createdAt: 0,
    updatedAt: 0,
    title: "test",
    players: ["us", "bo", "cy"].slice(0, hands.length),
    ourPlayerIndex: 0,
    variantName: "No Variant",
    deck: [...hands.flat(), ...draws, ...pad(12)],
    actions,
    touchedByAction,
    notes: {},
    options: { deckPlays: false, emptyClues: false },
  };
}

/** A five-card hand we cannot see, with `known` planted at the given slot. */
function ourHand(planted: Record<number, Identity> = {}): Identity[] {
  // Index 0 is the oldest card; slot 1 is the last entry.
  return Array.from({ length: 5 }, (_, i) => planted[5 - i] ?? UNSEEN);
}

const play = (order: number): GameAction => ({ type: ActionType.Play, target: order, value: 0 });
const discard = (order: number): GameAction => ({
  type: ActionType.Discard,
  target: order,
  value: 0,
});
const rank = (target: number, value: number): GameAction => ({
  type: ActionType.RankClue,
  target,
  value,
});
const color = (target: number, value: number): GameAction => ({
  type: ActionType.ColorClue,
  target,
  value,
});

describe("bluffs, level 11", () => {
  /**
   * Alice plays b1, Bob passes the turn back, and Alice clues "3" on Bob's b3
   * with blue on 1. Nobody can supply b2, so the clue only makes sense if Bob's
   * finesse position — a g1 — is meant to come down as a lie.
   */
  function bluffTable(finessePosition: Identity, behind: Identity): GameRecord {
    return table({
      hands: [
        ourHand({ 1: id(BLUE, 1) }),
        [id(YELLOW, 5), id(GREEN, 5), behind, finessePosition, id(BLUE, 3)],
      ],
      draws: [UNSEEN],
      actions: [play(4), rank(0, 5), rank(1, 3)],
      touchedByAction: { 1: [0] },
    });
  }

  it("reads a blind play that cannot be the promised card as a bluff", () => {
    const record = bluffTable(id(GREEN, 1), id(PURPLE, 5));
    const interp = analyse(record, at(11)).interps.at(-1)!;

    expect(interp.kind).toBe("play");
    expect(interp.chosen).toEqual([ordOf(id(BLUE, 3))]);
    expect(interp.connections).toHaveLength(1);
    expect(interp.connections[0]).toMatchObject({
      kind: "finesse",
      bluff: true,
      playerIndex: 1,
      order: 8,
      identity: ordOf(id(GREEN, 1)),
    });
  });

  it("has no reading for the same clue below level 11", () => {
    const record = bluffTable(id(GREEN, 1), id(PURPLE, 5));
    expect(analyse(record, at(10)).interps.at(-1)?.kind).toBe("unclear");
  });

  /**
   * The same clue, but the card the chain really needs is sitting one slot
   * behind the finesse position. That is a layered finesse below level 11 and a
   * bluff at 11, because the giver is in bluff seat — H-Group's "bluffs take
   * precedence over layered finesses from bluff seat".
   */
  it("prefers the bluff to a layered finesse when the giver is in bluff seat", () => {
    const record = bluffTable(id(GREEN, 1), id(BLUE, 2));

    const layered = analyse(record, at(10)).interps.at(-1)!;
    expect(layered.kind).toBe("play");
    expect(layered.connections.map((c) => c.kind)).toEqual(["finesse", "finesse"]);
    expect(layered.connections.every((c) => !c.bluff)).toBe(true);

    const bluffed = analyse(record, at(11)).interps.at(-1)!;
    expect(bluffed.connections).toHaveLength(1);
    expect(bluffed.connections[0].bluff).toBe(true);
  });

  it("marks the blind play as playable-something rather than the promised card", () => {
    const analysis = analyse(bluffTable(id(GREEN, 1), id(PURPLE, 5)), at(11));
    // Bob cannot see his own hand, so all he knows is that he holds something
    // that plays — which is exactly what a bluff exploits.
    expect(analysis.thoughts.get(8)?.bluffed).toBe(true);
    expect(botNote(analysis, 8)).toContain("g1");
    expect(botNote(analysis, 8)).toContain("r1");
  });

  it("takes the truthful finesse over the lie when both are on offer", () => {
    const link = (bluff: boolean): Connection => ({
      kind: "finesse",
      playerIndex: 1,
      order: 8,
      identity: ordOf(id(GREEN, 1)),
      hidden: false,
      bluff,
      assumed: false,
    });
    const truth: FocusPossibility = {
      identity: ordOf(id(GREEN, 2)),
      connections: [link(false)],
      save: false,
    };
    const lie: FocusPossibility = {
      identity: ordOf(id(BLUE, 3)),
      connections: [link(true)],
      save: false,
    };

    // Both ask one player who is neither the receiver nor us for one blind
    // play, so the razor cannot separate them on effort alone.
    expect(occamsRazor([lie, truth], 2, 0)).toEqual([truth]);
  });
});

describe("stalling, level 9", () => {
  it("reads a 5 clued off chop with nothing to say as a 5 stall", () => {
    const record = table({
      hands: [
        ourHand(),
        [id(YELLOW, 4), id(GREEN, 4), id(BLUE, 4), id(PURPLE, 4), id(GREEN, 5)],
      ],
      actions: [rank(1, 5)],
    });

    const interp = analyse(record, at(11)).interps.at(-1)!;
    expect(interp.kind).toBe("stall");
    expect(interp.detail).toContain("5 stall");
    // The 5 is being held, not played.
    expect(analyse(record, at(11)).thoughts.get(9)?.status).toBe("saved");
  });

  it("has no reading for that 5 at level 1, where stalls do not exist", () => {
    const record = table({
      hands: [
        ourHand(),
        [id(YELLOW, 4), id(GREEN, 4), id(BLUE, 4), id(PURPLE, 4), id(GREEN, 5)],
      ],
      actions: [rank(1, 5)],
    });
    expect(analyse(record, at(1)).interps.at(-1)?.kind).toBe("unclear");
  });

  it("reads a clue given at 8 clues as an 8 clue save", () => {
    const record = table({
      hands: [
        ourHand(),
        [id(YELLOW, 5), id(GREEN, 5), id(BLUE, 5), id(RED, 4), id(PURPLE, 5)],
      ],
      actions: [rank(1, 4)],
    });

    const stalled = analyse(record, at(9)).interps.at(-1)!;
    expect(stalled.kind).toBe("save");
    expect(stalled.detail).toContain("8 clue save");
    expect(analyse(record, at(9)).thoughts.get(8)?.status).toBe("saved");

    // Below the stalling conventions there is nothing to say about it.
    expect(analyse(record, at(8)).interps.at(-1)?.kind).toBe("unclear");
  });
});

describe("tempo clues, level 6", () => {
  /**
   * "2" saves Bob's chop, red gets to 1, and then a red clue on that same card
   * tells him it is the r2 — a clue that touched nothing new. One card played
   * is not worth a whole clue, so it carries a chop move with it.
   */
  const tempoGame = table({
    hands: [
      ourHand({ 1: id(RED, 1) }),
      [id(RED, 2), id(YELLOW, 5), id(GREEN, 5), id(BLUE, 5), id(PURPLE, 5)],
    ],
    draws: [UNSEEN],
    actions: [rank(1, 2), rank(0, 5), play(4), rank(0, 4), color(1, RED)],
    touchedByAction: { 1: [0], 3: [1] },
  });

  it("reads a re-clue that gets one card played as a tempo clue chop move", () => {
    const analysis = analyse(tempoGame, at(11));
    const interp = analysis.interps.at(-1)!;

    expect(interp.kind).toBe("tempo");
    expect(interp.detail).toContain("tempo clue chop move");
    expect(interp.chosen).toEqual([ordOf(id(RED, 2))]);
    // Bob's chop — the y5 behind the r2 — is what he is being told to keep.
    expect(analysis.thoughts.get(6)?.status).toBe("chop moved");
  });

  it("reads the same clue as an ordinary play clue below level 6", () => {
    const analysis = analyse(tempoGame, at(5));
    expect(analysis.interps.at(-1)?.kind).toBe("play");
    expect(analysis.thoughts.get(6)?.status).toBe("none");
  });

  it("shifts the focus past a card the table already knew would play", () => {
    // Bob's slot 1 is a known r1 and his slot 3 is a clued "2" that could be
    // any of them. A clue touching both is not about the r1.
    const record = table({
      hands: [
        ourHand(),
        [id(YELLOW, 5), id(GREEN, 5), id(YELLOW, 2), id(BLUE, 5), id(RED, 1)],
      ],
      actions: [color(1, RED), rank(0, 5), rank(1, 2)],
      touchedByAction: { 1: [0] },
    });

    const analysis = analyse(record, at(11));
    expect(analysis.thoughts.get(9)?.inferred).toEqual(new Set([ordOf(id(RED, 1))]));

    const poolBefore = new Map(
      [...analysis.thoughts].map(([order, thought]) => [order, new Set<Ord>(possibilities(thought))]),
    );
    const touched = [9, 7];
    const clued = new Set(touched);
    const red = { kind: "color", value: RED } as const;
    const args = [analysis.state, analysis.thoughts, 1, touched, clued, red] as const;

    expect(determineFocus(...args, at(6), poolBefore).focus).toBe(7);
    expect(determineFocus(...args, at(5), poolBefore).focus).toBe(9);
  });
});

describe("order chop moves, level 4", () => {
  /**
   * Both of Bob's 1s carry the same single clue, so the table cannot tell them
   * apart and they are played oldest first. Playing the newer one skips one 1,
   * which moves the chop of the player one seat along — us.
   */
  const skipped = table({
    hands: [
      ourHand(),
      [id(YELLOW, 5), id(RED, 1), id(GREEN, 5), id(BLUE, 1), id(PURPLE, 5)],
    ],
    draws: [id(GREEN, 4)],
    actions: [rank(1, 1), play(8)],
  });

  it("moves a chop when unknown 1s are played out of order", () => {
    const analysis = analyse(skipped, at(11));
    const ocm = analysis.discards.find((d) => d.kind === "order chop move");

    expect(ocm?.detail).toContain("1 skipped");
    expect(analysis.thoughts.get(0)?.status).toBe("chop moved");
  });

  it("does not read one below level 4", () => {
    const analysis = analyse(skipped, at(3));
    expect(analysis.discards.some((d) => d.kind === "order chop move")).toBe(false);
    expect(analysis.thoughts.get(0)?.status).toBe("none");
  });
});

describe("alarm discards, level 7", () => {
  /**
   * Eight clues are spent getting the team to zero, with Bob's r2 pinned along
   * the way. Then Bob throws his chop instead of playing it: at zero clues,
   * with nothing else he could do, that is a scream — and our chop moves.
   */
  const screamed = table({
    hands: [
      ourHand({ 1: id(RED, 1) }),
      [id(YELLOW, 5), id(GREEN, 5), id(BLUE, 5), id(RED, 2), id(PURPLE, 5)],
    ],
    draws: [UNSEEN],
    actions: [
      play(4),
      rank(0, 5),
      color(1, RED),
      rank(0, 5),
      color(1, RED),
      rank(0, 5),
      color(1, RED),
      rank(0, 5),
      color(1, RED),
      discard(5),
    ],
    touchedByAction: { 1: [0], 3: [0], 5: [0], 7: [0] },
  });

  it("reads a chop thrown away at zero clues as a scream", () => {
    const analysis = analyse(screamed, at(11));
    expect(analysis.state.clueTokens).toBe(1);

    const scream = analysis.discards.at(-1);
    expect(scream?.kind).toBe("scream");
    expect(scream?.detail).toContain("chop moves");
    // Our own chop — order 0 is already clued, so it is the card behind it.
    expect(analysis.thoughts.get(1)?.status).toBe("chop moved");
  });

  it("says nothing about the same discard below level 7", () => {
    const analysis = analyse(screamed, at(6));
    expect(analysis.discards).toEqual([]);
    expect(analysis.thoughts.get(1)?.status).toBe("none");
  });
});

describe("discards that hand a card over", () => {
  /**
   * Bob is clued "1" and then red, which leaves the whole table knowing he
   * holds r1 — and then he throws it away. Cathy has the other copy on her
   * finesse position, which is what the discard is pointing at.
   *
   * Both clues are needed. One alone leaves the card as "some 1" or "some red",
   * and a discard only says anything when everyone knew exactly what it was.
   */
  const handedOver = table({
    hands: [
      ourHand(),
      [id(YELLOW, 5), id(GREEN, 5), id(BLUE, 5), id(RED, 1), id(PURPLE, 5)],
      [id(YELLOW, 4), id(GREEN, 4), id(BLUE, 4), id(PURPLE, 4), id(RED, 1)],
    ],
    draws: [id(GREEN, 3)],
    actions: [rank(1, 1), rank(0, 5), rank(0, 4), color(1, RED), discard(8)],
    touchedByAction: { 1: [0], 2: [1] },
  });

  it("reads a gentleman's discard onto the next finesse position", () => {
    const analysis = analyse(handedOver, at(11));
    const gd = analysis.discards.at(-1);

    expect(gd?.kind).toBe("gentleman");
    expect(gd?.orders).toEqual([14]);
    expect(analysis.thoughts.get(14)?.status).toBe("finessed");
    expect(botNote(analysis, 14)).toBe("[f] [r1]");
  });

  it("reads it as a generation discard below level 10", () => {
    const analysis = analyse(handedOver, at(9));
    expect(analysis.discards.at(-1)?.kind).toBe("generation");
    expect(analysis.thoughts.get(14)?.status).toBe("none");
  });

  it("says nothing about a discard below level 7", () => {
    const analysis = analyse(handedOver, at(6));
    expect(analysis.discards).toEqual([]);
  });
});

/**
 * The levels above 5 add readings; they must not take any away.
 *
 * The recorded four-player game is a level-5 table, so turning the level up to
 * 11 must not change what any clue *means*. It may fill a gap — the levels
 * above 5 exist to read moves level 5 shrugs at — but wherever level 5 found a
 * play, a save or a chop move, level 11 has to agree word for word. Anything
 * else is one of the new techniques firing where it should not, which is the
 * failure mode that matters: a wrong chop move or a wrong blind play poisons
 * every note after it.
 */
describe("running a real game at every level", () => {
  const record = fromHanabLive(fixture as never, { ourPlayerIndex: 0 });

  it("never overrules a level-5 reading at level 11", () => {
    const low = analyse(record, at(5));
    const high = analyse(record, at(11));
    expect(high.interps).toHaveLength(low.interps.length);

    for (let i = 0; i < low.interps.length; i++) {
      if (low.interps[i].kind === "unclear" || low.interps[i].kind === "useless") continue;
      expect(high.interps[i].kind).toBe(low.interps[i].kind);
      expect(high.interps[i].detail).toBe(low.interps[i].detail);
    }
  });

  /**
   * The one gap level 9 fills on this game, and a check that it fills it for
   * the stated reason: on turn 42 the last y3 has just been thrown away, so
   * whoever moves next may not discard blind. The clue they gave instead says
   * nothing, and at level 9 that is a position rather than a mistake.
   */
  it("reads the one clue level 5 gives up on as a stall", () => {
    const low = analyse(record, at(5));
    const high = analyse(record, at(11));
    const filled = high.interps.filter((interp, i) => interp.kind !== low.interps[i].kind);

    expect(filled.map((interp) => interp.kind)).toEqual(["stall"]);
    expect(filled[0].detail).toContain("double discard position");
  });

  it("gives every suggestion a real number on every one of our turns", () => {
    for (let through = 1; through < record.actions.length; through++) {
      const analysis = analyse(record, at(11), undefined, through);
      const board = analysis.state;
      if (board.finished || board.currentPlayerIndex !== board.ourPlayerIndex) continue;
      for (const suggestion of suggestMoves(record, analysis)) {
        expect(Number.isFinite(suggestion.value)).toBe(true);
        expect(suggestion.reasons.length).toBeGreaterThan(0);
      }
    }
  });
});
