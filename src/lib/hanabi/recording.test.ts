import { describe, expect, it } from "vitest";
import { stateOf } from "./engine";
import {
  createGame,
  initialDeckIndex,
  recordClue,
  recordDiscard,
  recordPlay,
  setDealtCard,
  setupComplete,
  undo,
} from "./recording";
import { ActionType, UNKNOWN, isKnown, type GameRecord, type Identity } from "./types";

const RED_1: Identity = { suitIndex: 0, rank: 1 };
const RED_2: Identity = { suitIndex: 0, rank: 2 };
const BLUE_3: Identity = { suitIndex: 3, rank: 3 };

/** A three-player game where seat 0 is us, with the other two hands entered. */
function dealt(): GameRecord {
  let record = createGame({
    players: ["us", "bo", "cy"],
    ourPlayerIndex: 0,
    variantName: "No Variant",
  });
  for (const playerIndex of [1, 2]) {
    for (let slot = 1; slot <= 5; slot++) {
      record = setDealtCard(record, playerIndex, slot, { suitIndex: (playerIndex + slot) % 5, rank: 1 });
    }
  }
  return record;
}

describe("dealing", () => {
  it("leaves our own hand blank and everyone else's filled", () => {
    const record = dealt();
    expect(setupComplete(record)).toBe(true);
    expect(record.deck).toHaveLength(15);
    expect(record.deck.slice(0, 5).every((card) => !isKnown(card))).toBe(true);
    expect(record.deck.slice(5).every(isKnown)).toBe(true);
  });

  it("puts slot 1 at the top of a seat's block, matching hanab.live's deal", () => {
    expect(initialDeckIndex(3, 0, 1)).toBe(4);
    expect(initialDeckIndex(3, 0, 5)).toBe(0);
    expect(initialDeckIndex(3, 1, 1)).toBe(9);

    const record = setDealtCard(dealt(), 1, 1, BLUE_3);
    expect(stateOf(record).cards[9].identity).toEqual(BLUE_3);
    expect(stateOf(record).cards[9].slot).toBe(1);
  });
});

describe("recording turns", () => {
  it("appends the drawn card to the deck as part of the same turn", () => {
    const record = recordPlay(dealt(), { order: 4, reveal: RED_1 });
    expect(record.actions).toEqual([{ type: ActionType.Play, target: 4, value: 0 }]);
    // Seat 0 is us, so the replacement is one we cannot see.
    expect(record.deck).toHaveLength(16);
    expect(record.deck[15]).toEqual(UNKNOWN);

    const state = stateOf(record);
    expect(state.playStacks[0]).toBe(1);
    expect(state.hands[0][0]).toBe(15);
    expect(state.currentPlayerIndex).toBe(1);
  });

  it("records the card another player draws", () => {
    let record = recordPlay(dealt(), { order: 4, reveal: RED_1 });
    record = recordDiscard(record, { order: 9, drawn: BLUE_3 });
    expect(record.deck[16]).toEqual(BLUE_3);
    expect(stateOf(record).cards[16].holder).toBe(1);
  });

  it("stores which of our own cards a clue touched", () => {
    const record = recordClue(dealt(), 0, { kind: "rank", value: 1 }, [4, 2]);
    expect(record.actions).toEqual([{ type: ActionType.RankClue, target: 0, value: 1 }]);
    expect(record.touchedByAction[0]).toEqual([4, 2]);

    const state = stateOf(record);
    expect(state.cards[4].knowledge.positiveRanks).toEqual([1]);
    expect(state.cards[3].knowledge.negativeRanks).toEqual([1]);
  });

  it("marks the record finished when the game ends", () => {
    let record = createGame({ players: ["us", "bo"], ourPlayerIndex: 0, variantName: "No Variant" });
    for (let slot = 1; slot <= 5; slot++) record = setDealtCard(record, 1, slot, RED_2);
    // Three misplays of the same red 2 in a row ends it.
    record = recordPlay(record, { order: 4, reveal: RED_2, drawn: undefined });
    record = recordPlay(record, { order: 9, drawn: RED_2 });
    record = recordPlay(record, { order: 3, reveal: RED_2 });
    expect(stateOf(record).strikes).toBe(3);
    expect(stateOf(record).finished).toBe(true);
    expect(record.finishedAt).toBeTypeOf("number");
  });
});

describe("undo", () => {
  it("restores the exact state, including the card that was drawn", () => {
    const before = recordPlay(dealt(), { order: 4, reveal: RED_1 });
    const after = recordDiscard(before, { order: 9, drawn: BLUE_3 });
    const back = undo(after);

    expect(back.actions).toEqual(before.actions);
    expect(back.deck).toEqual(before.deck);
    expect(stateOf(back).hands).toEqual(stateOf(before).hands);
  });

  it("forgets the touched-slot answer that went with an undone clue", () => {
    const record = undo(recordClue(dealt(), 0, { kind: "rank", value: 1 }, [4]));
    expect(record.actions).toEqual([]);
    expect(record.touchedByAction).toEqual({});
  });

  it("never shortens the deck past the opening deal", () => {
    const record = undo(dealt());
    expect(record.deck).toHaveLength(15);
  });

  it("reopens a game that had just finished", () => {
    let record = createGame({ players: ["us", "bo"], ourPlayerIndex: 0, variantName: "No Variant" });
    for (let slot = 1; slot <= 5; slot++) record = setDealtCard(record, 1, slot, RED_2);
    record = recordPlay(record, { order: 4, reveal: RED_2 });
    record = recordPlay(record, { order: 9, drawn: RED_2 });
    record = recordPlay(record, { order: 3, reveal: RED_2 });
    expect(record.finishedAt).toBeTypeOf("number");

    const reopened = undo(record);
    expect(stateOf(reopened).finished).toBe(false);
    expect(reopened.finishedAt).toBeUndefined();
  });
});
