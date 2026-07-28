/**
 * The note the bot would write on a card.
 *
 * The format is scala-bot's (`Game.getNote`), so a note here reads the same as
 * one you would see on hanab.live with the bot in the seat:
 *
 * - `r1,r4,r5` — the identities it still thinks the card could be
 * - `[f]`      — called to play, either directly or off a finesse
 * - `[cm]`     — chop moved
 * - `kt`       — known trash
 * - `??`       — the clue made no sense; no inferences left
 * - `...`      — too many candidates to be worth listing
 *
 * These are the *bot's* notes and are kept well away from the notes you type.
 * They are derived from the game record, never stored in it, and never go into
 * the exported JSON.
 */
import type { GameState } from "../hanabi/engine";
import { identityOfOrd, possibilities, trashOrds, type Ord, type Thought } from "./empathy";
import { shortId, type BotAnalysis } from "./hgroup";

const MAX_LISTED = 6;

function nameOf(state: GameState, ord: Ord): string {
  return shortId(state, identityOfOrd(ord));
}

/** Ordinals sorted the way scala-bot sorts them: by suit, then rank. */
function sorted(ords: ReadonlySet<Ord>): Ord[] {
  return [...ords].sort((a, b) => a - b);
}

export function isKnownTrash(state: GameState, thought: Thought): boolean {
  const trash = trashOrds(state);
  const pool = possibilities(thought);
  return pool.size > 0 && [...pool].every((ord) => trash.has(ord));
}

/**
 * The note itself. Empty string means "nothing worth writing", which is what
 * the bot does for an untouched card carrying no conventional meaning.
 */
export function botNote(analysis: BotAnalysis, order: number): string {
  const { state, thoughts } = analysis;
  const thought = thoughts.get(order);
  const card = state.cards[order];
  if (!thought || !card || card.holder < 0) return "";

  const uninformed = !card.knowledge.clued && thought.status === "none";
  if (uninformed && !analysis.settings.noteEveryCard) return "";

  if (isKnownTrash(state, thought)) return "kt";

  const inferred = thought.inferred;
  const body =
    inferred.size === 0
      ? "??"
      : inferred.size <= MAX_LISTED
        ? sorted(inferred)
            .map((ord) => nameOf(state, ord))
            .join(",")
        : "...";

  switch (thought.status) {
    case "called to play":
    case "finessed":
      return body ? `[f] [${body}]` : "[f]";
    case "chop moved":
      return body ? `[cm] [${body}]` : "[cm]";
    case "called to discard":
      return "dc";
    default:
      return body;
  }
}

export interface NoteDetail {
  note: string;
  /** Long-form reading, for the card sheet rather than the card itself. */
  summary: string;
  candidates: string[];
  status: Thought["status"];
  /** True when the bot has it down to exactly one identity. */
  certain: boolean;
}

export function noteDetail(analysis: BotAnalysis, order: number): NoteDetail | undefined {
  const { state, thoughts } = analysis;
  const thought = thoughts.get(order);
  if (!thought) return undefined;

  const pool = possibilities(thought);
  const candidates = sorted(pool).map((ord) => nameOf(state, ord));
  const note = botNote(analysis, order);

  let summary: string;
  if (thought.inferred.size === 0) {
    summary = "No reading fits the clues on this card.";
  } else if (thought.possible.size === 1) {
    // Narrowed by the clues and the count alone — nothing conventional needed.
    summary = `Known to be ${candidates[0]}.`;
  } else if (pool.size === 1) {
    // Only one identity survives the convention; the clues alone allow more.
    summary = `Read as ${candidates[0]} — the clues alone still allow ${thought.possible.size}.`;
  } else if (isKnownTrash(state, thought)) {
    summary = "Known trash — safe to discard.";
  } else {
    switch (thought.status) {
      case "called to play":
        summary = `Called to play (${candidates.join(", ")}).`;
        break;
      case "finessed":
        summary = `Finessed — expected to blind-play ${candidates.join(", ")}.`;
        break;
      case "chop moved":
        summary = "Chop moved — held back from the discard pile.";
        break;
      default:
        summary = `Could be ${candidates.join(", ")}.`;
    }
  }

  return {
    note,
    summary,
    candidates,
    status: thought.status,
    certain: pool.size === 1,
  };
}
