import { describe, expect, it } from "vitest";
import type { CardKnowledge } from "./engine";
import { noteView, parseNote, sharedIdentity } from "./notes";
import { UNKNOWN, type Identity } from "./types";
import { START_RANK, allIdentities, getVariant, identityName } from "./variants";

const noVariant = getVariant("No Variant");

function names(text: string, variant = noVariant): string[] {
  return parseNote(variant, text).possibilities.map((p) => identityName(variant, p));
}

const everything = allIdentities(noVariant).length;

function knowledge(overrides: Partial<CardKnowledge> = {}): CardKnowledge {
  return {
    positiveColors: [],
    negativeColors: [],
    positiveRanks: [],
    negativeRanks: [],
    clued: false,
    ...overrides,
  };
}

const r = (rank: number): Identity => ({ suitIndex: 0, rank });
const b = (rank: number): Identity => ({ suitIndex: 3, rank });

describe("parseNote identities", () => {
  it("reads one card in any of hanab.live's spellings", () => {
    for (const text of ["r1", "R1", "red 1", "red1", "1r", "1 red", " r1 "]) {
      expect(names(text)).toEqual(["r1"]);
    }
  });

  it("reads a whole suit or a whole rank", () => {
    expect(names("r")).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(names("3")).toEqual(["r3", "y3", "g3", "b3", "p3"]);
  });

  it("reads lists, squished letters and exclusions", () => {
    expect(names("r1, b1")).toEqual(["r1", "b1"]);
    expect(names("rb23")).toEqual(["r2", "b2", "r3", "b3"]);
    expect(names("r,!r1,!r2")).toEqual(["r3", "r4", "r5"]);
    expect(names("!5")).toHaveLength(everything - 5);
  });

  it("only reads brackets, or the text after the last pipe", () => {
    expect(names("bo said so [r1]")).toEqual(["r1"]);
    expect(names("r1 | b2")).toEqual(["b2"]);
    expect(names("[r] [1]")).toEqual(["r1"]);
    // Keywords that conflict start again rather than ruling everything out.
    expect(names("[r1] [b2]")).toEqual(["b2"]);
  });

  it("treats prose as naming nothing", () => {
    expect(names("maybe r1")).toHaveLength(everything);
    expect(names("")).toHaveLength(everything);
  });

  it("reads Up or Down's START cards", () => {
    const upOrDown = getVariant("Up or Down (5 Suits)");
    expect(parseNote(upOrDown, "rs").possibilities).toEqual([{ suitIndex: 0, rank: START_RANK }]);
    expect(parseNote(upOrDown, "r start").possibilities).toEqual([{ suitIndex: 0, rank: START_RANK }]);
  });

  it("knows a variant's suits by name and by hanab.live's letter", () => {
    const variant = getVariant("Muddy Rainbow & Dark Rainbow (6 Suits)");
    expect(variant.abbreviations).toEqual(["R", "Y", "G", "B", "M", "A"]);
    expect(parseNote(variant, "a3").possibilities).toEqual([{ suitIndex: 5, rank: 3 }]);
    expect(parseNote(variant, "dark rainbow 3").possibilities).toEqual([{ suitIndex: 5, rank: 3 }]);
  });
});

describe("parseNote keywords", () => {
  it("picks out each special word", () => {
    expect(parseNote(noVariant, "f").finessed).toBe(true);
    expect(parseNote(noVariant, "5cm").chopMoved).toBe(true);
    expect(parseNote(noVariant, "kt").knownTrash).toBe(true);
    expect(parseNote(noVariant, "ptd").discardPermission).toBe(true);
    expect(parseNote(noVariant, "?").questionMark).toBe(true);
    expect(parseNote(noVariant, "!").exclamationMark).toBe(true);
    expect(parseNote(noVariant, "fix").needsFix).toBe(true);
    expect(parseNote(noVariant, "blank").blank).toBe(true);
    expect(parseNote(noVariant, "cl").clued).toBe(true);
    expect(parseNote(noVariant, "x").unclued).toBe(true);
  });

  it("combines a keyword with an identity in brackets", () => {
    const note = parseNote(noVariant, "[f] [r1]");
    expect(note.finessed).toBe(true);
    expect(note.possibilities).toEqual([r(1)]);
  });

  it("ignores keywords inside prose and before the last pipe", () => {
    expect(parseNote(noVariant, "not a f").finessed).toBe(false);
    expect(parseNote(noVariant, "f | r1").finessed).toBe(false);
  });
});

describe("noteView", () => {
  const hidden = { identity: UNKNOWN, knowledge: knowledge() };

  it("narrows a hidden card to what its note names", () => {
    const view = noteView(parseNote(noVariant, "r"), hidden, [r(1), r(2), b(1)], false);
    expect(view.narrowed).toBe(true);
    expect(view.possibilities).toEqual([r(1), r(2)]);
  });

  it("ignores a note the card can no longer match", () => {
    const view = noteView(parseNote(noVariant, "r1"), hidden, [r(2), b(1)], false);
    expect(view.narrowed).toBe(false);
    expect(view.possibilities).toEqual([r(2), b(1)]);
  });

  it("never narrows a card whose face is known", () => {
    const view = noteView(parseNote(noVariant, "b1"), { identity: r(1) }, undefined, false);
    expect(view.narrowed).toBe(false);
  });

  it("borders a card the way hanab.live ranks them", () => {
    const border = (text: string, clued = false) =>
      noteView(parseNote(noVariant, text), { identity: r(1), knowledge: knowledge({ clued }) }, undefined, false)
        .border;
    expect(border("f")).toBe("finessed");
    expect(border("cm")).toBe("chop-moved");
    expect(border("ptd")).toBe("discard-permission");
    expect(border("[cm] [f]")).toBe("finessed");
    expect(border("f", true)).toBe("clued");
    expect(border("cl")).toBe("clued");
    expect(border("x", true)).toBeUndefined();
    expect(border("")).toBeUndefined();
    expect(noteView(undefined, { identity: r(1), knowledge: knowledge({ clued: true }) }, undefined, false).border).toBe(
      "clued",
    );
  });

  it("marks known trash, and fades it unless a clue touched it", () => {
    const trash = parseNote(noVariant, "kt");
    const plain = noteView(trash, { identity: r(1), knowledge: knowledge() }, undefined, false);
    expect(plain.marks).toEqual(["trash"]);
    expect(plain.faded).toBe(true);

    const clued = knowledge({ clued: true, positiveRanks: [1] });
    expect(noteView(trash, { identity: r(1), knowledge: clued }, undefined, false).faded).toBe(false);
  });

  it("drops note-only marks and borders once the game is over", () => {
    const view = noteView(parseNote(noVariant, "[f] [kt] [blank]"), { identity: r(1) }, undefined, true);
    expect(view.border).toBeUndefined();
    expect(view.marks).toEqual([]);
    expect(view.faded).toBe(false);
    expect(view.blank).toBe(false);
  });
});

describe("sharedIdentity", () => {
  it("keeps whatever every candidate agrees on", () => {
    expect(sharedIdentity([r(1), r(2)])).toEqual({ suitIndex: 0, rank: -1 });
    expect(sharedIdentity([r(3), b(3)])).toEqual({ suitIndex: -1, rank: 3 });
    expect(sharedIdentity([r(3)])).toEqual(r(3));
    expect(sharedIdentity([])).toEqual(UNKNOWN);
  });
});
