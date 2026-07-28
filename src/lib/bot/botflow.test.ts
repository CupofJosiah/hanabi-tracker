// @vitest-environment jsdom
/**
 * The bot page end to end, and — just as importantly — proof that the plain
 * page did not pick any of it up. The two apps share a device and a game
 * library, so the isolation is worth asserting rather than assuming.
 */
import { cleanup, render, screen, within } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../../App.svelte";
import BotApp from "../../BotApp.svelte";
import { loadGames } from "../state/storage";

const user = userEvent.setup();

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** Two players, claire holding a playable r1 in slot 1 and a b5 on chop. */
async function startGame() {
  await user.click(screen.getByRole("button", { name: "New game" }));
  await user.type(screen.getByPlaceholderText("Player 1"), "us");
  await user.type(screen.getByPlaceholderText("Player 2"), "claire");
  await user.click(screen.getByRole("button", { name: "Deal" }));

  await user.click(screen.getByRole("button", { name: "claire slot 1" }));
  for (const name of ["Red 1", "Green 2", "Blue 3", "Yellow 4", "Blue 5"]) {
    await user.click(screen.getByRole("button", { name }));
  }
  await user.click(screen.getByRole("button", { name: "Start the game" }));
}

describe("the bot page", () => {
  it("suggests moves with a value and shows the arithmetic behind one", async () => {
    render(BotApp);
    await startGame();

    const panel = within(screen.getByRole("region", { name: "Bot suggestions" }));
    // A playable r1 sitting in claire's hand is worth cluing.
    const red = panel.getByRole("button", { name: /Clue Red to claire/ });
    expect(red).toBeDefined();

    // The value is on the button, and tapping it explains where it came from.
    await user.click(red);
    expect(panel.getByText(/sets up r1/)).toBeDefined();
    expect(panel.getByText(/spends a clue token/)).toBeDefined();
  });

  it("writes a note under a card once a clue has touched it", async () => {
    render(BotApp);
    await startGame();

    await user.click(screen.getByRole("button", { name: "Clue" }));
    await user.click(screen.getByRole("button", { name: "Red" }));
    await user.click(screen.getByRole("button", { name: "Record clue" }));

    // scala-bot's own format: called to play, and it can only be r1.
    expect(await screen.findByText("[f] [r1]")).toBeDefined();
  });

  it("keeps the bot's note out of the note you type and out of the game", async () => {
    render(BotApp);
    await startGame();

    await user.click(screen.getByRole("button", { name: "Clue" }));
    await user.click(screen.getByRole("button", { name: "Red" }));
    await user.click(screen.getByRole("button", { name: "Record clue" }));

    await user.click(screen.getByRole("button", { name: "r1" }));
    const sheet = within(screen.getByRole("dialog", { name: /claire/ }));

    // Both notes are on screen, under headings that say whose they are.
    expect(sheet.getByText("Bot's note")).toBeDefined();
    expect(sheet.getByText(/Note \(exported with the game\)/)).toBeDefined();

    const field = sheet.getByRole("textbox");
    expect((field as HTMLTextAreaElement).value).toBe("");
    await user.type(field, "mine");

    // The stored game carries only what was typed; the bot's note is derived.
    const saved = loadGames()[0];
    expect(saved.notes).toEqual({ 9: "mine" });
    expect(JSON.stringify(saved)).not.toContain("[f]");
  });

  it("lets you overrule a card's reading from its own sheet", async () => {
    render(BotApp);
    await startGame();

    await user.click(screen.getByRole("button", { name: "Clue" }));
    await user.click(screen.getByRole("button", { name: "Red" }));
    await user.click(screen.getByRole("button", { name: "Record clue" }));

    await user.click(screen.getByRole("button", { name: "r1" }));
    const sheet = within(screen.getByRole("dialog", { name: /claire/ }));
    expect(sheet.getByText("[f] [r1]")).toBeDefined();

    // At this table that clue meant something else: the card is chop moved.
    await user.click(sheet.getByRole("button", { name: "The bot has this wrong" }));
    await user.click(sheet.getByRole("button", { name: "Chop moved" }));

    expect(sheet.getByText("[cm] [r1]")).toBeDefined();
    expect(sheet.getByText("yours")).toBeDefined();

    // And it can be taken back.
    await user.click(sheet.getByRole("button", { name: "Clear correction" }));
    expect(sheet.getByText("[f] [r1]")).toBeDefined();
  });

  it("keeps corrections off the game record and out of the export", async () => {
    render(BotApp);
    await startGame();

    await user.click(screen.getByRole("button", { name: "Clue" }));
    await user.click(screen.getByRole("button", { name: "Red" }));
    await user.click(screen.getByRole("button", { name: "Record clue" }));

    await user.click(screen.getByRole("button", { name: "r1" }));
    const sheet = within(screen.getByRole("dialog", { name: /claire/ }));
    await user.click(sheet.getByRole("button", { name: "The bot has this wrong" }));
    await user.click(sheet.getByRole("button", { name: "Chop moved" }));

    const saved = loadGames()[0];
    expect(JSON.stringify(saved)).not.toContain("chop moved");
    expect(saved.notes).toEqual({});
    // It is on the device, just not in the game.
    expect(window.localStorage.getItem(`hanabi-tracker/v1/bot-overrides/${saved.id}`)).toContain(
      "chop moved",
    );
  });

  it("shows what it made of each clue and lets you pick another reading", async () => {
    render(BotApp);
    await startGame();

    await user.click(screen.getByRole("button", { name: "Clue" }));
    await user.click(screen.getByRole("button", { name: "Red" }));
    await user.click(screen.getByRole("button", { name: "Record clue" }));

    const log = within(screen.getByRole("region", { name: "Bot clue readings" }));
    await user.click(log.getByRole("button", { name: "show" }));

    // The clue is listed with what the bot took it to mean.
    const entry = log.getByRole("button", { name: /to claire/ });
    expect(entry.textContent).toContain("play clue");

    // And opening it offers the readings it found, with the one it took marked.
    await user.click(entry);
    expect(log.getByRole("button", { name: /r1 — play it/ })).toBeDefined();
  });

  it("lets the conventions be changed, and says what it cannot do", async () => {
    render(BotApp);
    await startGame();

    await user.click(screen.getByRole("button", { name: "HGroup11" }));
    const sheet = within(screen.getByRole("dialog", { name: "Conventions" }));

    expect(sheet.getByText(/will not spot/)).toBeDefined();
    expect(sheet.getByText("Bluffs")).toBeDefined();
    expect(sheet.getByText("Finesses")).toBeDefined();
  });
});

describe("the plain page", () => {
  it("has no bot on it at all", async () => {
    render(App);
    await startGame();

    await user.click(screen.getByRole("button", { name: "Clue" }));
    await user.click(screen.getByRole("button", { name: "Red" }));
    await user.click(screen.getByRole("button", { name: "Record clue" }));

    expect(screen.queryByRole("region", { name: /bot/i })).toBeNull();
    expect(screen.queryByText("[f] [r1]")).toBeNull();
    expect(screen.queryByRole("button", { name: /HGroup/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "r1" }));
    const sheet = within(screen.getByRole("dialog", { name: /claire/ }));
    expect(sheet.queryByText("Bot's note")).toBeNull();
    // The card sheet it always had is still exactly there.
    expect(sheet.getByText("What claire can tell")).toBeDefined();
  });
});
