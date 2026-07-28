import { describe, expect, it } from "vitest";
import { stateOf } from "./engine";
import { autoResolve, holderView, possibleIdentities, unseenCopies } from "./deduce";
import { createGame, recordClue, revealCard, setDealtCard } from "./recording";
import type { GameRecord, Identity } from "./types";
import { identityName, getVariant } from "./variants";

const variant = getVariant("No Variant");
const show = (ids: Identity[]) => ids.map((id) => identityName(variant, id)).sort();

/** Two players; seat 1's whole hand is visible, seat 0 (us) is hidden. */
function table(theirHand: Identity[]): GameRecord {
  let record = createGame({ players: ["us", "bo"], ourPlayerIndex: 0, variantName: "No Variant" });
  theirHand.forEach((identity, index) => {
    record = setDealtCard(record, 1, index + 1, identity);
  });
  return record;
}

const R1 = { suitIndex: 0, rank: 1 };
const R5 = { suitIndex: 0, rank: 5 };

describe("unseen copies", () => {
  it("counts what nobody has shown us", () => {
    const state = stateOf(table([R1, R1, R1, R5, { suitIndex: 1, rank: 1 }]));
    // All three red 1s are on the table, so ours cannot be one.
    expect(unseenCopies(state, R1)).toBe(0);
    expect(unseenCopies(state, R5)).toBe(0);
    expect(unseenCopies(state, { suitIndex: 1, rank: 1 })).toBe(2);
  });
});

describe("possibleIdentities", () => {
  it("narrows a hidden card by the clues it did and did not get", () => {
    let record = table([R1, R1, R1, R5, { suitIndex: 1, rank: 1 }]);
    // Seat 1 clues us "1", touching only our slot 1 (order 4).
    record = recordClue(record, 0, { kind: "rank", value: 1 }, [4]);
    // ...then "red", touching the same card.
    record = recordClue(record, 0, { kind: "color", value: 0 }, [4]);

    const state = stateOf(record);
    // Red 1 is a red card and a 1 — but all three copies are already visible.
    expect(possibleIdentities(state, 4)).toEqual([]);

    // Our slot 2 was missed by both clues, so it is neither red nor a 1.
    const other = show(possibleIdentities(state, 3));
    expect(other).not.toContain("r2");
    expect(other).not.toContain("y1");
    expect(other).toContain("y2");
  });

  it("says nothing about a card that has never been clued", () => {
    const state = stateOf(table([R1, R1, R1, R5, { suitIndex: 1, rank: 1 }]));
    // 25 identities minus the five we can see copies of being exhausted.
    expect(possibleIdentities(state, 0)).toHaveLength(23);
  });
});

describe("holderView", () => {
  const Y1 = { suitIndex: 1, rank: 1 };
  const B1 = { suitIndex: 3, rank: 1 };

  it("does not let a player see their own hand", () => {
    let record = table([R1, R1, R1, R5, Y1]);
    record = recordClue(record, 1, { kind: "rank", value: 1 });
    const state = stateOf(record);

    // We can see all three red 1s, so we know nobody else holds one.
    expect(unseenCopies(state, R1)).toBe(0);

    // Bo cannot: they are his own cards, so from his seat any 1 is still on.
    const view = holderView(state, 9)!;
    expect(view.viewer).toBe(1);
    expect(show(view.possibilities)).toEqual(["b1", "g1", "p1", "r1", "y1"]);
  });

  it("uses our seat's own reading for our own cards", () => {
    const record = table([R1, R1, R1, R5, Y1]);
    const state = stateOf(record);
    const view = holderView(state, 4)!;
    expect(view.viewer).toBe(0);
    expect(view.approximate).toBe(false);
    expect(show(view.possibilities)).toEqual(show(possibleIdentities(state, 4)));
  });

  it("flags that a player may know more while our own hand is hidden", () => {
    let record = table([R1, R1, R1, R5, Y1]);
    record = recordClue(record, 1, { kind: "rank", value: 1 });
    expect(holderView(stateOf(record), 9)!.approximate).toBe(true);

    // Once our cards are filled in, what bo can see is exactly known — and the
    // three blue 1s in our hand come off his list.
    for (const [order, identity] of [
      [0, B1],
      [1, B1],
      [2, B1],
      [3, { suitIndex: 3, rank: 2 }],
      [4, { suitIndex: 3, rank: 3 }],
    ] as const) {
      record = revealCard(record, order, identity);
    }

    const view = holderView(stateOf(record), 9)!;
    expect(view.approximate).toBe(false);
    expect(show(view.possibilities)).toEqual(["g1", "p1", "r1", "y1"]);
  });

  it("has no view of a card that has left every hand", () => {
    const record = table([R1, R1, R1, R5, Y1]);
    const state = stateOf(record);
    expect(holderView(state, 99)).toBeUndefined();
  });
});

describe("autoResolve", () => {
  it("settles cards once only one identity can fit", () => {
    let record = createGame({
      players: ["us", "bo"],
      ourPlayerIndex: 0,
      variantName: "3 Suits",
    });
    // 3 Suits has 30 cards; with five in each hand the rest are still in the deck,
    // so nothing is forced until clues narrow it down.
    for (let slot = 1; slot <= 5; slot++) {
      record = setDealtCard(record, 1, slot, { suitIndex: 0, rank: slot });
    }
    // A "5" clue on our slot 1, and red 5 is already visible in their hand.
    record = recordClue(record, 0, { kind: "rank", value: 5 }, [4]);
    record = recordClue(record, 0, { kind: "color", value: 1 }, [4]);

    const resolved = autoResolve(stateOf(record));
    expect(resolved.get(4)).toEqual({ suitIndex: 1, rank: 5 });
    // Nothing else is pinned down yet.
    expect(resolved.size).toBe(1);
  });
});
