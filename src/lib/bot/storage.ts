/**
 * Where the bot's own settings live.
 *
 * A separate key from the tracker's, so the plain app at `/` neither reads nor
 * writes any of this and behaves exactly as it did before the bot existed.
 * Games themselves are shared: both apps read the same `hanabi-tracker/v1/game/*`
 * entries, so a game recorded on one shows up on the other.
 *
 * Bot notes are not stored at all — they are recomputed from the record, which
 * is why they can never drift from the game or leak into the export.
 */
import { DEFAULT_BOT_SETTINGS, type BotSettings } from "./conventions";

const KEY = "hanabi-tracker/v1/bot-settings";

function storage(): Storage | undefined {
  try {
    const probe = "hanabi-tracker/probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadBotSettings(): BotSettings {
  const raw = storage()?.getItem(KEY);
  if (!raw) return { ...DEFAULT_BOT_SETTINGS };
  try {
    return { ...DEFAULT_BOT_SETTINGS, ...(JSON.parse(raw) as Partial<BotSettings>) };
  } catch {
    return { ...DEFAULT_BOT_SETTINGS };
  }
}

export function saveBotSettings(settings: BotSettings): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Settings are a convenience; never block a game over them.
  }
}
