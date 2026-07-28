import { describe, expect, it } from "vitest";
import fixture from "./fixtures/live-game-4p.json";
import { replay, stateOf } from "./engine";
import { fromHanabLive } from "./hanabLive";
import { ActionType, handSize, type GameAction, type Identity } from "./types";
import { getVariant } from "./variants";

// A real four-player game recorded at a table, exported from hanab.live's format.
const record = fromHanabLive(fixture, { ourPlayerIndex: 0 });

describe("replaying a real game", () => {
  const state = stateOf(record);

  it("deals seat blocks in hanab.live's order", () => {
    // Seat 0 holds orders 0-3, and the last of them is slot 1.
    expect(state.hands).toHaveLength(4);
    expect(handSize(4)).toBe(4);
    const dealt = replay({
      players: record.players,
      ourPlayerIndex: 0,
      variant: getVariant(record.variantName),
      deck: record.deck,
      actions: [],
      touchedByAction: {},
      options: record.options,
    });
    expect(dealt.hands[0]).toEqual([3, 2, 1, 0]);
    expect(dealt.hands[1]).toEqual([7, 6, 5, 4]);
    expect(dealt.cardsRemaining).toBe(50 - 16);
  });

  it("runs to the end of the deck and stops after the final round", () => {
    expect(state.cardsRemaining).toBe(0);
    expect(state.finished).toBe(true);
    // Every action in the export is consumed: the game ends exactly as recorded.
    expect(state.log).toHaveLength(fixture.actions.length);
  });

  it("scores the game, counting the two cards that were played twice as strikes", () => {
    expect(state.playStacks).toEqual([5, 3, 4, 5, 3]);
    expect(state.score).toBe(20);
    expect(state.strikes).toBe(2);
  });

  it("keeps clue tokens inside the bank", () => {
    expect(state.clueTokens).toBeGreaterThanOrEqual(0);
    expect(state.clueTokens).toBeLessThanOrEqual(8);
  });

  it("scrubs to any point in the game", () => {
    const early = stateOf(record, 4);
    expect(early.log).toHaveLength(4);
    expect(early.turn).toBe(5);
    expect(early.currentPlayerIndex).toBe(0);
  });
});

describe("clue bookkeeping", () => {
  const players = ["us", "them"];
  const variant = getVariant("No Variant");
  const red1: Identity = { suitIndex: 0, rank: 1 };
  const blue2: Identity = { suitIndex: 3, rank: 2 };

  function build(actions: GameAction[], touchedByAction: Record<number, number[]> = {}) {
    // Two players, five cards each: seat 0 gets 0-4, seat 1 gets 5-9.
    const deck: Identity[] = [
      ...Array.from({ length: 5 }, () => ({ suitIndex: -1, rank: -1 })),
      red1,
      blue2,
      red1,
      blue2,
      red1,
    ];
    return replay({
      players,
      ourPlayerIndex: 0,
      variant,
      deck,
      actions,
      touchedByAction,
      options: { deckPlays: false, emptyClues: false },
    });
  }

  it("derives which of a visible hand a clue touched", () => {
    const state = build([{ type: ActionType.ColorClue, target: 1, value: 0 }]);
    const touched = state.hands[1].filter((order) => state.cards[order].knowledge.clued);
    expect(touched.sort()).toEqual([5, 7, 9]);
    expect(state.clueTokens).toBe(7);
  });

  it("records negative information for the cards a clue missed", () => {
    const state = build([{ type: ActionType.RankClue, target: 1, value: 2 }]);
    expect(state.cards[6].knowledge.positiveRanks).toEqual([2]);
    expect(state.cards[5].knowledge.negativeRanks).toEqual([2]);
  });

  it("uses the recorder's tap-selection for clues aimed at our own hand", () => {
    const state = build([{ type: ActionType.RankClue, target: 0, value: 1 }], { 0: [4, 2] });
    expect(state.cards[4].knowledge.positiveRanks).toEqual([1]);
    expect(state.cards[2].knowledge.positiveRanks).toEqual([1]);
    expect(state.cards[3].knowledge.negativeRanks).toEqual([1]);
  });
});

describe("play and discard", () => {
  const variant = getVariant("No Variant");

  function twoPlayer(deck: Identity[], actions: GameAction[]) {
    return replay({
      players: ["a", "b"],
      ourPlayerIndex: 1,
      variant,
      deck,
      actions,
      touchedByAction: {},
      options: { deckPlays: false, emptyClues: false },
    });
  }

  const deck: Identity[] = [
    { suitIndex: 0, rank: 2 }, // order 0
    { suitIndex: 0, rank: 1 }, // order 1
    { suitIndex: 1, rank: 1 },
    { suitIndex: 2, rank: 1 },
    { suitIndex: 3, rank: 1 },
    ...Array.from({ length: 6 }, () => ({ suitIndex: 4, rank: 1 })),
  ];

  it("advances the stack on a good play and draws a replacement", () => {
    const state = twoPlayer(deck, [{ type: ActionType.Play, target: 1, value: 0 }]);
    expect(state.playStacks[0]).toBe(1);
    expect(state.score).toBe(1);
    expect(state.strikes).toBe(0);
    expect(state.hands[0]).toHaveLength(5);
    expect(state.hands[0][0]).toBe(10); // the drawn card is slot 1
  });

  it("strikes on a misplay and sends the card to the discard pile", () => {
    const state = twoPlayer(deck, [{ type: ActionType.Play, target: 0, value: 0 }]);
    expect(state.strikes).toBe(1);
    expect(state.score).toBe(0);
    expect(state.discards).toContain(0);
    expect(state.cards[0].failed).toBe(true);
  });

  it("returns a clue token on a discard but never above the cap", () => {
    const state = twoPlayer(deck, [
      { type: ActionType.RankClue, target: 1, value: 1 }, // seat 0: 8 -> 7
      { type: ActionType.Discard, target: 9, value: 0 }, // seat 1: 7 -> 8
      { type: ActionType.Discard, target: 4, value: 0 }, // seat 0: already capped
    ]);
    expect(state.clueTokens).toBe(8);
  });

  it("gives a clue token back for a played five", () => {
    const fives: Identity[] = [
      { suitIndex: 0, rank: 5 },
      ...Array.from({ length: 10 }, () => ({ suitIndex: 4, rank: 1 })),
    ];
    const state = replay({
      players: ["a", "b"],
      ourPlayerIndex: 1,
      variant,
      deck: fives,
      actions: [
        { type: ActionType.RankClue, target: 1, value: 1 },
        { type: ActionType.RankClue, target: 0, value: 1 },
        // Seat 0 plays the red 5 onto an empty stack: a misplay, not a bonus clue.
        { type: ActionType.Play, target: 0, value: 0 },
      ],
      touchedByAction: {},
      options: { deckPlays: false, emptyClues: false },
    });
    expect(state.strikes).toBe(1);
    expect(state.clueTokens).toBe(6);
  });
});
