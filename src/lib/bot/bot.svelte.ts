/**
 * The bot's reactive state: the convention settings, the corrections you have
 * made, and the analysis of whatever game is open.
 *
 * Analysis is derived, never stored. It is recomputed from `deck` + `actions`
 * the same way the board is, so undo, correcting a card and stepping back
 * through history all carry the notes with them for free.
 */
import type { GameRecord } from "../hanabi/types";
import { analyse, type BotAnalysis } from "./hgroup";
import { botNote } from "./notes";
import { suggestMoves, type Suggestion } from "./suggest";
import { loadBotSettings, saveBotSettings } from "./storage";
import {
  deleteOverrides,
  loadOverrides,
  saveOverrides,
  NO_OVERRIDES,
  type BotOverride,
  type BotOverrides,
} from "./overrides";
import type { Ord } from "./empathy";
import type { BotSettings } from "./conventions";

class BotState {
  settings = $state<BotSettings>(loadBotSettings());
  /** Corrections for the game currently open: cards by order, clues by action. */
  overrides = $state<BotOverrides>(NO_OVERRIDES);

  #gameId: string | undefined;

  update(patch: Partial<BotSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveBotSettings(this.settings);
  }

  /** Loads the corrections belonging to a game, once per game. */
  openGame(gameId: string): void {
    if (this.#gameId === gameId) return;
    this.#gameId = gameId;
    this.overrides = loadOverrides(gameId);
  }

  correct(gameId: string, order: number, override: BotOverride | undefined): void {
    this.openGame(gameId);
    const cards = { ...this.overrides.cards };
    if (override === undefined) delete cards[order];
    else cards[order] = override;
    this.#write(gameId, { ...this.overrides, cards });
  }

  /** Picks which of the readings the bot found is the one your table meant. */
  readClue(gameId: string, actionIndex: number, identity: Ord | undefined): void {
    this.openGame(gameId);
    const clues = { ...this.overrides.clues };
    if (identity === undefined) delete clues[actionIndex];
    else clues[actionIndex] = { identity };
    this.#write(gameId, { ...this.overrides, clues });
  }

  clearCorrections(gameId: string): void {
    this.overrides = { cards: {}, clues: {} };
    deleteOverrides(gameId);
  }

  #write(gameId: string, next: BotOverrides): void {
    this.overrides = next;
    saveOverrides(gameId, next);
  }
}

export const bot = new BotState();

export function analyseGame(
  record: GameRecord,
  settings: BotSettings,
  overrides: BotOverrides,
): BotAnalysis {
  return analyse(record, settings, overrides);
}

/**
 * Every card currently in a hand, with the note the bot would write on it.
 *
 * A card you have corrected is marked with a pencil, so at a glance you can
 * tell your reading from the bot's. That marker is display only — the note
 * itself stays in scala-bot's format.
 */
export function notesFor(analysis: BotAnalysis): Record<number, string> {
  const notes: Record<number, string> = {};
  for (const order of analysis.thoughts.keys()) {
    const note = botNote(analysis, order);
    if (!note) continue;
    notes[order] = analysis.thoughts.get(order)?.overridden ? `✎ ${note}` : note;
  }
  return notes;
}

export function suggestionsFor(record: GameRecord, analysis: BotAnalysis): Suggestion[] {
  return suggestMoves(record, analysis);
}
