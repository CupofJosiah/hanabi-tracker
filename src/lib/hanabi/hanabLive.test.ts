import { describe, expect, it } from "vitest";
import fixture from "./fixtures/live-game-4p.json";
import { ImportError, exportIssues, fromHanabLive, serialize, toHanabLive } from "./hanabLive";
import { createGame, setNote } from "./recording";
import { UNKNOWN } from "./types";

describe("round-tripping hanab.live JSON", () => {
  it("re-exports an imported game byte for byte", () => {
    const record = fromHanabLive(fixture, { ourPlayerIndex: 0 });
    expect(JSON.parse(serialize(record))).toEqual(fixture);
  });

  it("keeps hidden cards hidden rather than inventing faces", () => {
    const hidden = {
      ...fixture,
      deck: fixture.deck.map((card, index) => (index < 4 ? { suitIndex: -1, rank: -1 } : card)),
    };
    const record = fromHanabLive(hidden, { ourPlayerIndex: 0 });
    expect(record.deck.slice(0, 4)).toEqual([UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN]);
    expect(toHanabLive(record).deck.slice(0, 4)).toEqual([
      { suitIndex: -1, rank: -1 },
      { suitIndex: -1, rank: -1 },
      { suitIndex: -1, rank: -1 },
      { suitIndex: -1, rank: -1 },
    ]);
  });

  it("rejects files that are not games", () => {
    expect(() => fromHanabLive({ players: ["a", "b"] })).toThrow(ImportError);
    expect(() => fromHanabLive({ ...fixture, players: ["solo"] })).toThrow(ImportError);
    expect(() => fromHanabLive({ ...fixture, options: { variant: "Chimneys" } })).toThrow(
      ImportError,
    );
  });
});

describe("export shape", () => {
  const base = createGame({
    players: ["ana", "bo", "cy"],
    ourPlayerIndex: 1,
    variantName: "Black (6 Suits)",
  });

  it("writes the variant name hanab.live expects", () => {
    expect(toHanabLive(base).options).toEqual({ variant: "Black (6 Suits)" });
  });

  it("only mentions house rules when they are on", () => {
    const houseRules = createGame({
      players: ["ana", "bo"],
      ourPlayerIndex: 0,
      variantName: "No Variant",
      options: { deckPlays: true, emptyClues: false },
    });
    expect(toHanabLive(houseRules).options).toEqual({ variant: "No Variant", deckPlays: true });
  });

  it("files notes under the seat that wrote them", () => {
    const noted = setNote(base, 4, "probably b1");
    const exported = toHanabLive(noted);
    expect(exported.notes).toHaveLength(3);
    expect(exported.notes[1]).toEqual(["", "", "", "", "probably b1"]);
    expect(exported.notes[0]).toEqual([]);
  });
});

describe("exportIssues", () => {
  it("warns while cards are still hidden", () => {
    const record = createGame({
      players: ["ana", "bo"],
      ourPlayerIndex: 0,
      variantName: "No Variant",
    });
    const issues = exportIssues(record);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("10 cards still unidentified");
  });

  it("is quiet about a complete game", () => {
    expect(exportIssues(fromHanabLive(fixture))).toEqual([]);
  });

  it("catches a card entered more times than the variant has copies", () => {
    const record = fromHanabLive(fixture);
    // The red 5 is unique; a second one means a slip somewhere.
    record.deck[0] = { suitIndex: 0, rank: 5 };
    record.deck[1] = { suitIndex: 0, rank: 5 };
    const errors = exportIssues(record).filter((issue) => issue.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Red 5");
  });
});
