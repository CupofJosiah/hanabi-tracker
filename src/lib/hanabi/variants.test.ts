import { describe, expect, it } from "vitest";
import {
  DEFAULT_VARIANT_NAME,
  VARIANT_NAMES,
  allIdentities,
  cardTouched,
  getVariant,
  searchVariants,
} from "./variants";

describe("variant data", () => {
  it("bundles the standard variants under hanab.live's own names", () => {
    for (const name of ["No Variant", "6 Suits", "Black (6 Suits)", "Rainbow (5 Suits)"]) {
      expect(VARIANT_NAMES).toContain(name);
    }
  });

  it("counts the deck the way hanab.live does", () => {
    expect(getVariant("No Variant").totalCards).toBe(50);
    expect(getVariant("6 Suits").totalCards).toBe(60);
    // Black is one-of-each, so its suit contributes 5 rather than 10.
    expect(getVariant("Black (6 Suits)").totalCards).toBe(55);
    expect(getVariant("4 Suits").totalCards).toBe(40);
  });

  it("offers a colour clue only for suits a colour clue can name", () => {
    expect(getVariant(DEFAULT_VARIANT_NAME).clueColors.map((c) => c.name)).toEqual([
      "Red",
      "Yellow",
      "Green",
      "Blue",
      "Purple",
    ]);
    // Rainbow is touched by every colour, so it gets no button of its own.
    expect(getVariant("Rainbow (6 Suits)").clueColors).toHaveLength(5);
    // Black is an ordinary colour, just scarce.
    expect(getVariant("Black (6 Suits)").clueColors).toHaveLength(6);
  });
});

describe("cardTouched", () => {
  const noVariant = getVariant("No Variant");

  it("matches colour and rank in the base game", () => {
    expect(cardTouched(noVariant, { suitIndex: 2, rank: 3 }, { kind: "color", value: 2 })).toBe(true);
    expect(cardTouched(noVariant, { suitIndex: 2, rank: 3 }, { kind: "color", value: 1 })).toBe(false);
    expect(cardTouched(noVariant, { suitIndex: 2, rank: 3 }, { kind: "rank", value: 3 })).toBe(true);
    expect(cardTouched(noVariant, { suitIndex: 2, rank: 3 }, { kind: "rank", value: 4 })).toBe(false);
  });

  it("touches rainbow with every colour and white with none", () => {
    const rainbow = getVariant("Rainbow (6 Suits)");
    for (let value = 0; value < rainbow.clueColors.length; value++) {
      expect(cardTouched(rainbow, { suitIndex: 5, rank: 1 }, { kind: "color", value })).toBe(true);
    }

    const white = getVariant("White (6 Suits)");
    for (let value = 0; value < white.clueColors.length; value++) {
      expect(cardTouched(white, { suitIndex: 5, rank: 1 }, { kind: "color", value })).toBe(false);
    }
  });

  it("touches pink with every rank and brown with none", () => {
    const pink = getVariant("Pink (6 Suits)");
    expect(cardTouched(pink, { suitIndex: 5, rank: 2 }, { kind: "rank", value: 4 })).toBe(true);

    const brown = getVariant("Brown (6 Suits)");
    expect(cardTouched(brown, { suitIndex: 5, rank: 2 }, { kind: "rank", value: 2 })).toBe(false);
  });

  it("cycles prism through the colours by rank", () => {
    const prism = getVariant("Prism (6 Suits)");
    const colours = prism.clueColors.length;
    for (const rank of [1, 2, 3, 4, 5]) {
      const expected = (rank - 1) % colours;
      for (let value = 0; value < colours; value++) {
        expect(cardTouched(prism, { suitIndex: 5, rank }, { kind: "color", value })).toBe(
          value === expected,
        );
      }
    }
  });

  it("gives every suit a distinct letter", () => {
    for (const name of VARIANT_NAMES) {
      const variant = getVariant(name);
      expect(new Set(variant.abbreviations).size).toBe(variant.suits.length);
    }
  });

  it("enumerates five ranks per suit", () => {
    const variant = getVariant("6 Suits");
    expect(allIdentities(variant)).toHaveLength(30);
  });
});

describe("searchVariants", () => {
  it("matches on every word, in any order", () => {
    expect(searchVariants("black 6")).toContain("Black (6 Suits)");
    expect(searchVariants("6 black")).toContain("Black (6 Suits)");
    expect(searchVariants("zzz")).toEqual([]);
  });
});
