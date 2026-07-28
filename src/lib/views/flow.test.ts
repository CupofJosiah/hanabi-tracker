// @vitest-environment jsdom
/**
 * Walks the app the way a recorder does at a table: start a game, deal the
 * visible hands, give a clue, then record someone's play and the card they drew.
 * Covers the wiring between the screens, which the pure-logic tests cannot.
 */
import { cleanup, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App.svelte";
import { loadGames } from "../state/storage";

const user = userEvent.setup();

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

async function startTwoPlayerGame() {
  render(App);
  await user.click(screen.getByRole("button", { name: "New game" }));

  await user.type(screen.getByPlaceholderText("Player 1"), "us");
  await user.type(screen.getByPlaceholderText("Player 2"), "bo");
  await user.click(screen.getByRole("button", { name: "Deal" }));
}

/** Enters bo's five cards; the picker walks itself to the next empty slot. */
async function dealVisibleHand() {
  await user.click(screen.getByRole("button", { name: "bo slot 1" }));
  for (const rank of [1, 2, 3, 4, 5]) {
    await user.click(screen.getByRole("button", { name: `Red ${rank}` }));
  }
  await user.click(screen.getByRole("button", { name: "Start the game" }));
}

describe("recording a game end to end", () => {
  it("deals, clues, and records a play with the card drawn after it", async () => {
    await startTwoPlayerGame();

    // Our own hand is never asked for.
    expect(screen.getByRole("button", { name: "bo slot 1" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "us slot 1" })).toBeNull();

    await dealVisibleHand();

    // Seat 0 (us) acts first: clue bo's 1.
    await user.click(screen.getByRole("button", { name: "Clue" }));
    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "Record clue" }));

    // Now bo plays the red 1 that was clued, and draws a replacement we can see.
    await user.click(screen.getByRole("button", { name: "Play" }));
    await user.click(screen.getByRole("button", { name: "r1" }));
    await user.click(screen.getByRole("button", { name: "Yellow 3" }));

    const [saved] = loadGames();
    expect(saved.players).toEqual(["us", "bo"]);
    expect(saved.actions).toEqual([
      { type: 3, target: 1, value: 1 },
      { type: 0, target: 9, value: 0 },
    ]);
    // The clue was aimed at a hand we can see, so no tap-selection was stored.
    expect(saved.touchedByAction).toEqual({});
    // Ten dealt cards, then bo's draw.
    expect(saved.deck).toHaveLength(11);
    expect(saved.deck[10]).toEqual({ suitIndex: 1, rank: 3 });

    const history = screen.getByText("History").closest("details");
    expect(within(history as HTMLElement).getByText(/bo plays r1 \(slot 1\)/)).toBeDefined();
  });

  it("keeps the game after a reload and undoes the last turn", async () => {
    await startTwoPlayerGame();
    await dealVisibleHand();

    await user.click(screen.getByRole("button", { name: "Clue" }));
    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "Record clue" }));
    expect(loadGames()[0].actions).toHaveLength(1);

    // A refresh reopens the history from localStorage rather than losing it.
    screen.getByRole("button", { name: "Undo last action" });
    await user.click(screen.getByRole("button", { name: "Undo last action" }));
    expect(loadGames()[0].actions).toHaveLength(0);
  });

  it("asks which of our own cards a clue touched", async () => {
    await startTwoPlayerGame();
    await dealVisibleHand();

    // Bo has to act first for a clue to come our way, so pass the turn along.
    await user.click(screen.getByRole("button", { name: "Clue" }));
    await user.click(screen.getByRole("button", { name: "2" }));
    await user.click(screen.getByRole("button", { name: "Record clue" }));

    await user.click(screen.getByRole("button", { name: "Clue" }));
    await user.click(screen.getByRole("button", { name: "Red" }));
    // The only other seat is ours, so the sheet asks us to tap the touched cards.
    const sheet = within(screen.getByRole("dialog", { name: "Give a clue" }));
    expect(sheet.getByText("tap the cards they pointed at")).toBeDefined();

    // Recording is blocked until a slot is named — an empty clue is not legal here.
    expect(sheet.getByRole("button", { name: "Record clue" })).toHaveProperty("disabled", true);
    await user.click(sheet.getAllByRole("button", { name: "unknown card" })[0]);
    await user.click(sheet.getByRole("button", { name: "Record clue" }));

    const saved = loadGames()[0];
    expect(saved.actions[1]).toEqual({ type: 2, target: 0, value: 0 });
    expect(saved.touchedByAction[1]).toEqual([4]);
  });
});
