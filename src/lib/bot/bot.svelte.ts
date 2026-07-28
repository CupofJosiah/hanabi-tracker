/**
 * The bot's reactive state: the convention settings, and the analysis of
 * whatever game is open.
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
import type { BotSettings } from "./conventions";

class BotState {
  settings = $state<BotSettings>(loadBotSettings());
  /** Set while a suggestion run is in flight, so the panel can say so. */
  thinking = $state(false);

  update(patch: Partial<BotSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveBotSettings(this.settings);
  }
}

export const bot = new BotState();

export function analyseGame(record: GameRecord, settings: BotSettings): BotAnalysis {
  return analyse(record, settings);
}

/** Every card currently in a hand, with the note the bot would write on it. */
export function notesFor(analysis: BotAnalysis): Record<number, string> {
  const notes: Record<number, string> = {};
  for (const order of analysis.thoughts.keys()) {
    const note = botNote(analysis, order);
    if (note) notes[order] = note;
  }
  return notes;
}

export function suggestionsFor(record: GameRecord, analysis: BotAnalysis): Suggestion[] {
  return suggestMoves(record, analysis);
}
