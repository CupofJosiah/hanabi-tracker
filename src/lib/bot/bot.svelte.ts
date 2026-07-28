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
  type BotOverride,
  type BotOverrides,
} from "./overrides";
import type { BotSettings } from "./conventions";

class BotState {
  settings = $state<BotSettings>(loadBotSettings());
  /** Corrections for the game currently open, keyed by card order. */
  overrides = $state<BotOverrides>({});

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
    const next = { ...this.overrides };
    if (override === undefined) delete next[order];
    else next[order] = override;
    this.overrides = next;
    saveOverrides(gameId, next);
  }

  clearCorrections(gameId: string): void {
    this.overrides = {};
    deleteOverrides(gameId);
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
