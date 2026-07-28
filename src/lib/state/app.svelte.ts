/**
 * Application state: the game list, which screen is showing, and the toast
 * queue. Every mutation writes straight through to localStorage so the on-disk
 * history is never behind what is on screen.
 */
import type { GameRecord } from "../hanabi/types";
import {
  DEFAULT_SETTINGS,
  StorageFullError,
  deleteGame,
  loadGames,
  loadSettings,
  saveGame,
  saveSettings,
  type Settings,
} from "./storage";

export type View =
  | { name: "home" }
  | { name: "setup" }
  | { name: "game"; id: string }
  | { name: "review"; id: string };

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
}

class AppState {
  games = $state<GameRecord[]>([]);
  view = $state<View>({ name: "home" });
  settings = $state<Settings>({ ...DEFAULT_SETTINGS });
  toasts = $state<Toast[]>([]);

  #nextToastId = 1;

  load(): void {
    this.games = loadGames();
    this.settings = loadSettings();

    // A refresh, a locked phone or a browser tab eviction should drop you back
    // where you were rather than at the library.
    const resuming = this.games.find((game) => game.id === this.settings.lastOpenGameId);
    this.view = resuming
      ? { name: resuming.finishedAt === undefined ? "game" : "review", id: resuming.id }
      : { name: "home" };
  }

  get current(): GameRecord | undefined {
    const view = this.view;
    if (view.name !== "game" && view.name !== "review") return undefined;
    return this.games.find((game) => game.id === view.id);
  }

  /** Saves a new or updated game and keeps the list newest-first. */
  put(record: GameRecord): void {
    const index = this.games.findIndex((game) => game.id === record.id);
    if (index === -1) this.games = [record, ...this.games];
    else this.games = [record, ...this.games.slice(0, index), ...this.games.slice(index + 1)];

    try {
      saveGame(record);
    } catch (error) {
      this.toast(
        error instanceof StorageFullError ? error.message : "Could not save to this device.",
        "error",
      );
    }
  }

  remove(id: string): void {
    this.games = this.games.filter((game) => game.id !== id);
    deleteGame(id);
    if (this.current?.id === id) this.view = { name: "home" };
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
  }

  go(view: View): void {
    this.view = view;
    const id = view.name === "game" || view.name === "review" ? view.id : undefined;
    if (id !== this.settings.lastOpenGameId) this.updateSettings({ lastOpenGameId: id });
  }

  toast(text: string, tone: Toast["tone"] = "info"): void {
    const toast: Toast = { id: this.#nextToastId++, text, tone };
    this.toasts = [...this.toasts, toast];
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== toast.id);
    }, tone === "error" ? 6000 : 3000);
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
  }
}

export const app = new AppState();
