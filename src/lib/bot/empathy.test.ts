/**
 * Empathy: what each player can work out, as opposed to what the table can.
 *
 * The two views come apart because nobody sees their own hand. When the last
 * blue 3 is sitting in Bob's hand, everybody else may strike b3 off their notes
 * and Bob may not — he is the one person who cannot look at it. Getting that
 * exemption right is the difference between counting cards and doing empathy,
 * and getting it wrong hands a player a deduction they had no way of making.
 *
 * The strongest test here is the last one: over a whole recorded game, at every
 * turn, from every seat, the identity a card *really is* must stay possible. An
 * empathy bug shows up as ruling out the truth.
 */
import { describe, expect, it } from "vitest";
import fixture from "../hanabi/fixtures/live-game-4p.json";
import { fromHanabLive } from "../hanabi/hanabLive";
import {
  ActionType,
  isKnown,
  type GameAction,
  type GameRecord,
  type Identity,
} from "../hanabi/types";
import { identityName } from "../hanabi/variants";
import { DEFAULT_BOT_SETTINGS, type BotSettings } from "./conventions";
import { analyse } from "./hgroup";
import { identityOfOrd, ordOf, perspectiveOf, type Ord } from "./empathy";

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

const rank = (target: number, value: number): GameAction => ({
  type: ActionType.RankClue,
  target,
  value,
});

interface Table {
  hands: Identity[][];
  actions: GameAction[];
  draws?: Identity[];
  variantName?: string;
  /** Cards nobody draws. Only needed to pad a deck out to a legal length. */
  spare?: Identity[];
}

function table({
  hands,
  actions,
  draws = [],
  variantName = "No Variant",
  spare = [],
}: Table): GameRecord {
  return {
    id: "test",
    createdAt: 0,
    updatedAt: 0,
    title: "test",
    players: ["us", "bo", "cy"].slice(0, hands.length),
    ourPlayerIndex: 0,
    variantName,
    deck: [...hands.flat(), ...draws, ...spare],
    actions,
    touchedByAction: {},
    notes: {},
    options: { deckPlays: false, emptyClues: false },
  };
}

/** The table's note on a card, as a sorted list of identity names. */
function poss(record: GameRecord, settings: BotSettings, order: number): string[] {
  const analysis = analyse(record, settings);
  const thought = analysis.thoughts.get(order);
  return [...(thought?.possible ?? [])]
    .sort((a, b) => a - b)
    .map((ord) => identityName(analysis.state.variant, identityOfOrd(ord)));
}

describe("counting the copies everybody can see", () => {
  /**
   * All three red 1s are in bo's hand, where everyone but bo can see them.
   *
   * That makes the three cases come apart cleanly. Our clued 1 cannot be red
   * and neither can cy's, because we can both count the copies. bo's clued 1s
   * still can be, because bo is looking at the backs of them.
   */
  const seenAllTheReds = table({
    hands: [
      [UNSEEN, UNSEEN, UNSEEN, UNSEEN, id(YELLOW, 1)],
      [id(RED, 1), id(RED, 1), id(RED, 1), id(GREEN, 5), id(PURPLE, 5)],
      [id(YELLOW, 1), id(YELLOW, 5), id(GREEN, 4), id(BLUE, 4), id(PURPLE, 4)],
    ],
    actions: [rank(1, 5), rank(0, 1), rank(1, 1)],
  });

  it("rules out an identity once every copy is visible elsewhere", () => {
    // Our slot 1 is a clued 1 with all three red 1s accounted for.
    expect(poss(seenAllTheReds, at(5), 4)).toEqual(["y1", "g1", "b1", "p1"]);
  });

  it("rules it out for a third player who can see them too", () => {
    // cy's yellow 1 was never clued, so this is the count doing all the work.
    expect(poss(seenAllTheReds, at(5), 10)).not.toContain("r1");
  });

  it("leaves the identity open for the player holding the copies", () => {
    // bo's 1s are clued as 1s, and bo cannot see a single red 1. Striking r1
    // off his note would be reading his own cards for him.
    for (const order of [5, 6, 7]) {
      expect(poss(seenAllTheReds, at(5), order)).toContain("r1");
    }
  });
});

describe("naked groups", () => {
  /**
   * scala-bot's `performCrossElim`, and the case that needs it: five clued 5s
   * and exactly five 5s left. No amount of counting copies one at a time gets
   * there — it takes noticing that two cards *between them* have used a pair up.
   *
   * We hold two of them and can see the other three, so the table pins ours to
   * the leftover pair. That pair then tells bo and cy what theirs are, which is
   * the step that only a group can make: from bo's seat the r5 and y5 are
   * invisible, and it is our two cards holding them that says so.
   */
  const allTheFives = table({
    hands: [
      [id(BLUE, 1), id(BLUE, 2), id(BLUE, 3), id(RED, 5), id(YELLOW, 5)],
      [id(RED, 1), id(RED, 2), id(RED, 3), id(GREEN, 5), id(BLUE, 5)],
      [id(YELLOW, 1), id(YELLOW, 2), id(YELLOW, 3), id(YELLOW, 4), id(PURPLE, 5)],
    ],
    actions: [rank(1, 5), rank(2, 5), rank(0, 5)],
    spare: Array.from({ length: 20 }, () => id(GREEN, 1)),
  });

  it("narrows our own pair to the 5s nobody else can be holding", () => {
    expect(poss(allTheFives, at(5), 3)).toEqual(["r5", "y5"]);
    expect(poss(allTheFives, at(5), 4)).toEqual(["r5", "y5"]);
  });

  it("uses that pair to name the 5s in the other hands", () => {
    expect(poss(allTheFives, at(5), 8)).toEqual(["g5", "b5"]);
    expect(poss(allTheFives, at(5), 9)).toEqual(["g5", "b5"]);
    expect(poss(allTheFives, at(5), 14)).toEqual(["p5"]);
  });
});

/**
 * A three-suit game played down to the last card.
 *
 * Six plays put the stacks at r3/g2/b1 and nine discards empty the deck, which
 * leaves every player able to name their own hand by subtraction. bo's five
 * cards are then r1, r2, g1, b1 and g2 — every one of them already on a stack.
 *
 * `tail` is what happens after that, which is what each test is about.
 */
function endgame(tail: GameAction[], swap = false): GameRecord {
  // "3 Suits" is red, green, blue — blue is index 2 here, not the 3 it is in a
  // five-suit deck.
  const r = (value: number): Identity => id(0, value);
  const g = (value: number): Identity => id(1, value);
  const b = (value: number): Identity => id(2, value);

  const play = (order: number): GameAction => ({ type: ActionType.Play, target: order, value: 0 });
  const drop = (order: number): GameAction => ({
    type: ActionType.Discard,
    target: order,
    value: 0,
  });

  // bo's slot 1 and cy's slot 2, swapped: it hands bo a green 4 the stacks
  // still want, so his hand is no longer all rubbish.
  const boSlot1 = swap ? g(4) : g(2);
  const cySlot2 = swap ? g(2) : g(4);

  return table({
    variantName: "3 Suits",
    hands: [
      [r(1), r(2), r(3), r(1), r(3)],
      [r(4), g(1), g(5), b(1), b(2)],
      [g(1), g(2), b(1), b(3), b(4)],
    ],
    draws: [
      b(4), // 15  us,  slot 5 at the end
      r(1), // 16  bo,  slot 5
      g(3), // 17  cy,  slot 5 — playable
      g(3), // 18  us,  slot 4
      r(2), // 19  bo,  slot 4
      b(2), // 20  cy,  slot 4
      b(3), // 21  us,  slot 3
      g(1), // 22  bo,  slot 3
      r(4), // 23  cy,  slot 3 — playable
      r(5), // 24  us,  slot 2
      b(1), // 25  bo,  slot 2
      cySlot2, // 26 cy, slot 2
      b(5), // 27  us,  slot 1
      boSlot1, // 28 bo, slot 1
      g(4), // 29  cy,  slot 1
    ],
    actions: [
      play(0), // r1
      drop(5),
      play(10), // g1
      play(1), // r2
      drop(6),
      play(11), // g2
      play(2), // r3
      drop(7),
      play(12), // b1
      drop(3),
      drop(8),
      drop(13),
      drop(4),
      drop(9),
      drop(14), // the deck is empty from here
      drop(15), // us: our own chop, which says nothing
      ...tail,
    ],
  });
}

describe("positional discards and misplays, level 8", () => {
  /** bo throws slot 3 from a hand of pure rubbish; cy's slot 3 is the red 4. */
  const positional = endgame([{ type: ActionType.Discard, target: 22, value: 0 }]);

  it("reads the slot thrown as the slot to blind-play", () => {
    const analysis = analyse(positional, at(8));
    const spoke = analysis.discards.at(-1);

    expect(spoke?.kind).toBe("positional discard");
    expect(spoke?.orders).toEqual([23]);
    expect(spoke?.detail).toContain("slot 3");
    expect(analysis.thoughts.get(23)?.status).toBe("finessed");
  });

  it("rests on what bo could work out about his own hand", () => {
    // Not one of bo's cards was ever clued. What lets him act is subtraction:
    // a dead deck, two hands in front of him and two piles, leaving r1, r2,
    // g1, g2 and b1. He cannot say which slot is which — and does not need to,
    // because every one of them is already on a stack.
    const before = analyse(positional, at(8), undefined, 16);
    const view = perspectiveOf(before.state, before.thoughts, 1);
    const stacked = [id(0, 1), id(0, 2), id(1, 1), id(1, 2), id(2, 1)]
      .map(ordOf)
      .sort((a, b) => a - b);

    for (const order of before.state.hands[1]) {
      expect(before.state.cards[order]!.knowledge.clued).toBe(false);
      expect([...view.get(order)!].sort((a, b) => a - b)).toEqual(stacked);
    }
  });

  it("is a question the shared view cannot answer earlier in the game", () => {
    // Halfway through, with the deck still alive, bo can name every card in
    // front of him and the table can name almost none of them. That gap is the
    // whole of empathy, and it is why the precondition has to be asked of bo
    // rather than of the notes.
    const midway = analyse(positional, at(8), undefined, 8);
    const view = perspectiveOf(midway.state, midway.thoughts, 1);

    for (const seat of [0, 2]) {
      for (const order of midway.state.hands[seat]) {
        const shared = midway.thoughts.get(order)!.possible.size;
        if (seat === 2) expect(view.get(order)!.size).toBe(1);
        expect(view.get(order)!.size).toBeLessThanOrEqual(shared);
      }
    }
    // And the table, on the same cards, is still guessing.
    const table = midway.state.hands[2].map((o) => midway.thoughts.get(o)!.possible.size);
    expect(Math.min(...table)).toBeGreaterThan(1);
  });

  it("says nothing below level 8", () => {
    expect(analyse(positional, at(7)).discards).toEqual([]);
  });

  it("says nothing while bo still holds something worth keeping", () => {
    const useful = endgame([{ type: ActionType.Discard, target: 22, value: 0 }], true);
    expect(analyse(useful, at(8)).discards).toEqual([]);
  });

  it("says nothing about a discard taken while the deck is still alive", () => {
    // Every discard before the deck ran out, and not one of them speaks.
    const analysis = analyse(positional, at(8));
    for (const spoke of analysis.discards) expect(spoke.actionIndex).toBeGreaterThan(14);
  });

  it("reads a misplay the same way when the chop is the slot wanted", () => {
    // bo's chop *is* slot 5, so throwing it would read as an ordinary discard.
    // Bombing it instead is unmistakable: everyone can see the card was known
    // rubbish. cy's slot 5 is the green 3, which plays.
    const misplay = endgame([{ type: ActionType.Play, target: 16, value: 0 }]);
    const analysis = analyse(misplay, at(8));
    const spoke = analysis.discards.at(-1);

    expect(spoke?.kind).toBe("positional misplay");
    expect(spoke?.orders).toEqual([17]);
    expect(spoke?.detail).toContain("slot 5");
    expect(analysis.thoughts.get(17)?.status).toBe("finessed");
  });
});

describe("empathy over a recorded game", () => {
  const record = fromHanabLive(fixture as never, { ourPlayerIndex: 0 });

  /**
   * The invariant that catches every empathy bug there is.
   *
   * Narrowing a note is only ever sound if the card's real identity survives
   * it. Ruling out the truth means somebody was credited with a deduction they
   * could not make — most often by counting a copy that the holder of the card
   * is the one person unable to see.
   */
  it("never rules out what a card really is, from any seat", () => {
    const wrong: string[] = [];

    for (let through = 1; through <= record.actions.length; through++) {
      const analysis = analyse(record, at(11), undefined, through);
      const state = analysis.state;
      const truth = (order: number): Ord | undefined => {
        const card = state.cards[order];
        if (!card || card.holder < 0 || !isKnown(card.identity)) return undefined;
        return ordOf(card.identity);
      };

      for (const [order, thought] of analysis.thoughts) {
        const real = truth(order);
        if (real !== undefined && !thought.possible.has(real)) {
          wrong.push(`turn ${through}: the table ruled out what card ${order} is`);
        }
      }

      for (let seat = 0; seat < state.players.length; seat++) {
        for (const [order, pool] of perspectiveOf(state, analysis.thoughts, seat)) {
          const real = truth(order);
          if (real !== undefined && !pool.has(real)) {
            wrong.push(`turn ${through}: ${state.players[seat]} ruled out what card ${order} is`);
          }
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it("tells each player at least as much as the table knows", () => {
    const analysis = analyse(record, at(11));
    for (let seat = 0; seat < analysis.state.players.length; seat++) {
      const view = perspectiveOf(analysis.state, analysis.thoughts, seat);
      for (const [order, pool] of view) {
        const shared = analysis.thoughts.get(order);
        if (!shared) continue;
        expect(pool.size).toBeLessThanOrEqual(shared.possible.size);
      }
    }
  });
});
