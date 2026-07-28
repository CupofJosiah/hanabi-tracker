/**
 * The bot reads a table the way scala-bot does, so these tests are written in
 * terms of the notes it writes: `[f] [r1]` for a card called to play, `kt` for
 * known trash, and so on. If a note here changes, the convention reading
 * changed with it.
 */
import { describe, expect, it } from "vitest";
import fixture from "../hanabi/fixtures/live-game-4p.json";
import { fromHanabLive } from "../hanabi/hanabLive";
import { ActionType, type GameAction, type GameRecord, type Identity } from "../hanabi/types";
import { DEFAULT_BOT_SETTINGS, missingTechniques, type BotSettings } from "./conventions";
import { analyse } from "./hgroup";
import { botNote } from "./notes";
import { suggestMoves } from "./suggest";

const SETTINGS: BotSettings = { ...DEFAULT_BOT_SETTINGS, level: 5 };

const RED = 0;
const YELLOW = 1;
const GREEN = 2;
const BLUE = 3;

function id(suitIndex: number, rank: number): Identity {
  return { suitIndex, rank };
}

/**
 * A two-player game with a deck we control. Seat 0 is us (hand hidden from the
 * app's point of view), seat 1 is "bo"; orders 0-4 are ours, 5-9 are bo's, and
 * within each block the *last* order is slot 1.
 */
function game(deck: Identity[], actions: GameAction[] = []): GameRecord {
  return {
    id: "test",
    createdAt: 0,
    updatedAt: 0,
    title: "test",
    players: ["us", "bo"],
    ourPlayerIndex: 0,
    variantName: "No Variant",
    deck,
    actions,
    touchedByAction: {},
    notes: {},
    options: { deckPlays: false, emptyClues: false },
  };
}

const UNSEEN: Identity = { suitIndex: -1, rank: -1 };
const ourHand = Array.from({ length: 5 }, () => UNSEEN);

/** Filler for bo's hand that no clue in these tests touches. */
function bo(...cards: Identity[]): Identity[] {
  return cards;
}

describe("reading a clue", () => {
  it("calls a card playable and writes the note scala-bot would", () => {
    // bo's slot 1 (order 9) is r1; a red clue touches only it.
    const record = game(
      [
        ...ourHand,
        ...bo(id(BLUE, 4), id(BLUE, 3), id(YELLOW, 4), id(GREEN, 4), id(RED, 1)),
        ...Array.from({ length: 10 }, () => id(GREEN, 5)),
      ],
      [{ type: ActionType.ColorClue, target: 1, value: RED }],
    );

    const analysis = analyse(record, SETTINGS);
    // Occam's razor: red on an empty stack means r1, not r2 off a finesse.
    expect(botNote(analysis, 9)).toBe("[f] [r1]");
  });

  it("reads a clue on the chop as a save and promises no play", () => {
    // Order 5 is bo's oldest card and his chop: a 5, so "5" saves it.
    const record = game(
      [
        ...ourHand,
        ...bo(id(BLUE, 5), id(BLUE, 3), id(YELLOW, 4), id(GREEN, 4), id(RED, 4)),
        ...Array.from({ length: 10 }, () => id(GREEN, 3)),
      ],
      [{ type: ActionType.RankClue, target: 1, value: 5 }],
    );

    const analysis = analyse(record, SETTINGS);
    const interp = analysis.interps.at(-1);
    expect(interp?.kind).toBe("save");
    expect(interp?.focus).toBe(5);
    // A save says "hold this", not "play this", so there is no [f].
    expect(botNote(analysis, 5)).not.toContain("[f]");
    expect(botNote(analysis, 5)).toContain("5");
  });

  it("finds the finesse that makes an unplayable card make sense", () => {
    // A rank clue cannot be read as "the playable one" the way a colour clue
    // can, so "2" on an empty board has to be explained. bo's slot 2 is g1 and
    // his slot 1 is g2: the 2 only plays if he blind-plays the 1 underneath.
    const record = game(
      [
        ...ourHand,
        ...bo(id(BLUE, 4), id(BLUE, 3), id(YELLOW, 4), id(GREEN, 1), id(GREEN, 2)),
        ...Array.from({ length: 10 }, () => id(YELLOW, 3)),
      ],
      [{ type: ActionType.RankClue, target: 1, value: 2 }],
    );

    const analysis = analyse(record, SETTINGS);
    const interp = analysis.interps.at(-1);
    expect(interp?.kind).toBe("play");
    expect(interp?.connections.map((c) => c.kind)).toEqual(["finesse"]);
    // The 2 is pinned to green because that is the only 1 anyone can produce.
    expect(botNote(analysis, 9)).toBe("[f] [g2]");
    // And the card asked to blind-play says so, with nothing having touched it.
    expect(botNote(analysis, 8)).toBe("[f] [g1]");
  });

  it("drops played identities from a card's note under Good Touch", () => {
    // Two red 1s in bo's hand, both clued as 1s; he plays one. The other is
    // still clued as a 1, and Good Touch says a touched card is not trash, so
    // r1 drops out of its note even though a third copy exists.
    const record = game(
      [
        ...ourHand,
        ...bo(id(BLUE, 4), id(BLUE, 3), id(YELLOW, 4), id(RED, 1), id(RED, 1)),
        ...Array.from({ length: 10 }, () => id(GREEN, 3)),
      ],
      [
        { type: ActionType.RankClue, target: 1, value: 1 },
        { type: ActionType.Play, target: 9, value: 0 }, // bo plays r1
      ],
    );

    const analysis = analyse(record, SETTINGS);
    const note = botNote(analysis, 8);
    expect(note).not.toContain("r1");
    expect(note).toContain("y1");

    // With Good Touch off, r1 comes back: nothing rules it out by counting.
    const loose = analyse(record, { ...SETTINGS, goodTouch: false });
    expect(botNote(loose, 8)).toContain("r1");
  });
});

describe("suggesting a move", () => {
  it("puts a certain play at the top, worth about a point", () => {
    // We are told "1" on our slot 1, which on an empty board is a play clue.
    const record = game(
      [
        ...ourHand,
        ...bo(id(BLUE, 4), id(BLUE, 3), id(YELLOW, 4), id(GREEN, 4), id(RED, 4)),
        ...Array.from({ length: 10 }, () => id(GREEN, 3)),
      ],
      [
        { type: ActionType.RankClue, target: 1, value: 4 }, // us -> bo, passes the turn
        { type: ActionType.RankClue, target: 0, value: 1 }, // bo -> us
      ],
    );
    record.touchedByAction = { 1: [4] };

    const analysis = analyse(record, SETTINGS);
    const suggestions = suggestMoves(record, analysis);
    const best = suggestions[0];

    expect(best.move).toEqual({ kind: "play", order: 4 });
    expect(best.value).toBeGreaterThan(0.9);
    expect(best.risky).toBe(false);
    expect(best.reasons.join(" ")).toContain("certain to play");
  });

  it("scores a clue that sets up a play above one that touches nothing useful", () => {
    const record = game([
      ...ourHand,
      ...bo(id(BLUE, 4), id(BLUE, 3), id(YELLOW, 4), id(GREEN, 4), id(RED, 1)),
      ...Array.from({ length: 10 }, () => id(GREEN, 3)),
    ]);

    const analysis = analyse(record, SETTINGS);
    const suggestions = suggestMoves(record, analysis);
    const red = suggestions.find(
      (s) => s.move.kind === "clue" && s.move.clue.kind === "color" && s.move.clue.value === RED,
    );
    const blue = suggestions.find(
      (s) => s.move.kind === "clue" && s.move.clue.kind === "color" && s.move.clue.value === BLUE,
    );

    expect(red).toBeDefined();
    expect(blue).toBeDefined();
    // Red sets up the playable r1; blue touches two cards that go nowhere yet.
    expect(red!.value).toBeGreaterThan(blue!.value);
    expect(red!.reasons.join(" ")).toContain("sets up r1");
  });

  it("prefers discarding known trash over the chop", () => {
    const record = game(
      [
        ...ourHand,
        ...bo(id(BLUE, 4), id(BLUE, 3), id(YELLOW, 4), id(GREEN, 4), id(RED, 1)),
        ...Array.from({ length: 10 }, () => id(GREEN, 3)),
      ],
      [
        { type: ActionType.ColorClue, target: 1, value: RED },
        { type: ActionType.Play, target: 9, value: 0 }, // bo plays r1, red is at 1
        { type: ActionType.RankClue, target: 0, value: 1 }, // us: pointless, passes turn
        { type: ActionType.RankClue, target: 1, value: 1 },
      ],
    );

    const analysis = analyse(record, SETTINGS);
    const suggestions = suggestMoves(record, analysis);
    const discards = suggestions.filter((s) => s.move.kind === "discard");
    expect(discards.length).toBeGreaterThan(0);
    // Every discard reason should account for what it costs.
    for (const discard of discards) {
      expect(discard.reasons.join(" ")).toContain("clue token");
    }
  });
});

describe("running over a real game", () => {
  const record = fromHanabLive(fixture, { ourPlayerIndex: 0 });

  it("reads all 4 players' hands without falling over", () => {
    const analysis = analyse(record, SETTINGS);
    expect(analysis.state.score).toBe(20);
    // Every clue got some reading, even if the reading is "unclear".
    const clues = record.actions.filter(
      (action) => action.type === ActionType.ColorClue || action.type === ActionType.RankClue,
    );
    expect(analysis.interps).toHaveLength(clues.length);
  });

  it("reads almost every clue as a real convention rather than giving up", () => {
    const analysis = analyse(record, SETTINGS);
    const kinds = analysis.interps.reduce<Record<string, number>>((tally, interp) => {
      tally[interp.kind] = (tally[interp.kind] ?? 0) + 1;
      return tally;
    }, {});

    // A real table playing H-Group: 23 of the 24 clues get a reading, and the
    // mix is what you would expect — mostly play clues, a few saves on chop,
    // and a couple of clues whose job was to stop a misplay.
    expect(kinds).toEqual({ play: 18, save: 3, fix: 2, unclear: 1 });
  });

  it("never writes into the game's own notes", () => {
    const before = JSON.stringify(record);
    const analysis = analyse(record, SETTINGS);
    for (const order of analysis.thoughts.keys()) botNote(analysis, order);
    expect(JSON.stringify(record)).toBe(before);
    expect(record.notes).toEqual({});
  });
});

describe("convention settings", () => {
  it("is honest about the techniques it does not implement", () => {
    expect(missingTechniques({ ...DEFAULT_BOT_SETTINGS, level: 1 })).toEqual([]);
    expect(missingTechniques({ ...DEFAULT_BOT_SETTINGS, level: 5 })).toHaveLength(1);
    const atEleven = missingTechniques({ ...DEFAULT_BOT_SETTINGS, level: 11 }).map((t) => t.name);
    expect(atEleven).toContain("Bluffs");
    expect(atEleven).toContain("Tempo clues");
  });

  it("stops looking for finesses below level 2", () => {
    const record = game(
      [
        ...ourHand,
        ...bo(id(BLUE, 4), id(BLUE, 3), id(YELLOW, 4), id(GREEN, 1), id(GREEN, 2)),
        ...Array.from({ length: 10 }, () => id(YELLOW, 3)),
      ],
      [{ type: ActionType.RankClue, target: 1, value: 2 }],
    );

    const beginner = analyse(record, { ...DEFAULT_BOT_SETTINGS, level: 1 });
    const intermediate = analyse(record, { ...DEFAULT_BOT_SETTINGS, level: 5 });

    expect(intermediate.interps.at(-1)?.connections.map((c) => c.kind)).toContain("finesse");
    expect(beginner.interps.at(-1)?.connections).toEqual([]);
  });
});
