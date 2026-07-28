/**
 * Device-local persistence.
 *
 * Games live one-per-key in `localStorage`, so recording a turn rewrites a few
 * kilobytes rather than the whole history, and a crash mid-write can only
 * damage the game being played. Everything is written synchronously as each
 * action is recorded — a refresh, a locked phone or a closed tab loses nothing.
 */
import type { GameRecord } from "../hanabi/types";

const VERSION = "v1";
const GAME_PREFIX = `hanabi-tracker/${VERSION}/game/`;
const SETTINGS_KEY = `hanabi-tracker/${VERSION}/settings`;

export interface Settings {
  /** Pre-fills the new-game screen with your usual table. */
  lastPlayers: string[];
  lastOurPlayerIndex: number;
  lastVariantName: string;
  /** Reopened on launch, so a refresh mid-game lands back on the table. */
  lastOpenGameId?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  lastPlayers: [],
  lastOurPlayerIndex: 0,
  lastVariantName: "No Variant",
};

/** Falls back to memory when localStorage is unavailable (private browsing, iframes). */
function backing(): Storage {
  try {
    const probe = "hanabi-tracker/probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return memoryStorage();
  }
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

let store: Storage | null = null;

function storage(): Storage {
  store ??= backing();
  return store;
}

export class StorageFullError extends Error {}

export function loadGames(): GameRecord[] {
  const s = storage();
  const games: GameRecord[] = [];
  for (let i = 0; i < s.length; i++) {
    const key = s.key(i);
    if (!key?.startsWith(GAME_PREFIX)) continue;
    const raw = s.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as GameRecord;
      if (isGameRecord(parsed)) games.push(parsed);
    } catch {
      // A corrupt entry should not take the rest of the history down with it.
    }
  }
  return games.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveGame(record: GameRecord): void {
  try {
    storage().setItem(GAME_PREFIX + record.id, JSON.stringify(record));
  } catch (error) {
    throw new StorageFullError(
      "Could not save — this device's storage is full. Export the game before continuing.",
      { cause: error },
    );
  }
}

export function deleteGame(id: string): void {
  storage().removeItem(GAME_PREFIX + id);
}

export function loadSettings(): Settings {
  const raw = storage().getItem(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    storage().setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings are a convenience; never block a game over them.
  }
}

/** Everything on the device, for the "back up my history" button. */
export function exportBackup(games: readonly GameRecord[]): string {
  return JSON.stringify({ app: "hanabi-tracker", version: VERSION, games }, null, 2);
}

export function parseBackup(text: string): GameRecord[] {
  const data = JSON.parse(text) as unknown;
  const games = (data as { games?: unknown }).games ?? data;
  if (!Array.isArray(games)) throw new Error("That file does not contain a list of games.");
  const valid = games.filter(isGameRecord);
  if (valid.length === 0) throw new Error("No games found in that file.");
  return valid;
}

function isGameRecord(value: unknown): value is GameRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<GameRecord>;
  return (
    typeof record.id === "string" &&
    Array.isArray(record.players) &&
    Array.isArray(record.deck) &&
    Array.isArray(record.actions) &&
    typeof record.variantName === "string"
  );
}
