/**
 * Card notes, read the way hanab.live reads them.
 *
 * A note is free text, but some of it means something to hanab.live: `r1` or
 * `r,b` names what the card could be, and words like `f`, `cm` or `kt` mark it
 * finessed, chop moved or known trash. Only the part after the last `|` counts,
 * and inside that, any `[bracketed]` parts, or else the whole of it. So
 * `told by bo | [r1] maybe` reads as `r1`, and `maybe r1` reads as nothing.
 *
 * `parseNote` ports hanab.live's `parseNote` and `noteIdentity.ts`, and
 * `noteView` its `cardPresentation.ts`. Like there, a note never changes what
 * the tracker records or deduces, only how the card is drawn.
 */
import type { CardKnowledge } from "./engine";
import {
  BLANK_NOTES,
  CHOP_MOVED_NOTES,
  CLUED_NOTES,
  DISCARD_PERMISSION_NOTES,
  EXCLAMATION_MARK_NOTES,
  FINESSED_NOTES,
  KNOWN_TRASH_NOTES,
  NEEDS_FIX_NOTES,
  QUESTION_MARK_NOTES,
  RESERVED_NOTES,
  UNCLUED_NOTES,
} from "./noteKeywords";
import { UNKNOWN_RANK, UNKNOWN_SUIT, isKnown, sameIdentity, type Identity } from "./types";
import { START_RANK, type Variant } from "./variants";

export interface CardNote {
  /** Identities the note allows. Every identity when it names none. */
  possibilities: Identity[];
  knownTrash: boolean;
  needsFix: boolean;
  questionMark: boolean;
  exclamationMark: boolean;
  chopMoved: boolean;
  finessed: boolean;
  discardPermission: boolean;
  blank: boolean;
  unclued: boolean;
  clued: boolean;
}

export function parseNote(variant: Variant, text: string): CardNote {
  const fullNote = text
    .slice(text.lastIndexOf("|") + 1)
    .toLowerCase()
    .trim();
  const keywords = noteKeywords(fullNote);
  const has = (words: readonly string[]) => keywords.some((keyword) => words.includes(keyword));

  return {
    possibilities: possibilitiesFromKeywords(variant, keywords),
    knownTrash: has(KNOWN_TRASH_NOTES),
    needsFix: has(NEEDS_FIX_NOTES),
    questionMark: has(QUESTION_MARK_NOTES),
    exclamationMark: has(EXCLAMATION_MARK_NOTES),
    chopMoved: has(CHOP_MOVED_NOTES),
    finessed: has(FINESSED_NOTES),
    discardPermission: has(DISCARD_PERMISSION_NOTES),
    blank: has(BLANK_NOTES),
    unclued: has(UNCLUED_NOTES),
    clued: has(CLUED_NOTES),
  };
}

/**
 * The bracketed parts of a note, or the text after its last pipe, or the whole
 * note when it has neither.
 */
function noteKeywords(note: string): string[] {
  const regexp = /\[(.*?)]|\|([^[|]*$)|(^[^[|]+$)/g;
  const keywords: string[] = [];
  for (const match of note.matchAll(regexp)) {
    const keyword = match[1] ?? match[2] ?? match[3];
    if (keyword !== undefined) keywords.push(keyword.trim());
  }
  return keywords;
}

/**
 * Each keyword narrows the last; one that rules everything out starts again on
 * its own, so `[r1] [b2]` reads as `b2`.
 */
function possibilitiesFromKeywords(variant: Variant, keywords: string[]): Identity[] {
  let possibilities: Identity[] = [];
  for (const keyword of keywords.length > 0 ? keywords : [""]) {
    if (keyword === "!") continue;
    const next = possibilitiesFromKeyword(variant, keyword);
    const both = next.filter((a) => possibilities.some((b) => sameIdentity(a, b)));
    possibilities = both.length === 0 ? next : both;
  }
  return possibilities;
}

interface Named {
  suits: number[];
  ranks: number[];
}

/**
 * One keyword's identities: a comma-separated list where each item adds to the
 * set and a `!` item takes away from it, e.g. `r,!r1` for red but not red 1.
 * An item that names nothing (plain prose) stands for every card.
 */
function possibilitiesFromKeyword(variant: Variant, keyword: string): Identity[] {
  const positives: Named[] = [];
  const negatives: Named[] = [];
  for (const raw of keyword.split(",")) {
    const segment = raw.trim();
    const negative = segment.startsWith("!");
    const named = namedIn(variant, negative ? segment.slice(1).trim() : segment);
    (negative ? negatives : positives).push(named);
  }

  const allSuits = variant.suits.map((_suit, index) => index);
  const allowed = new Map<string, boolean>();
  const key = (suitIndex: number, rank: number) => `${suitIndex}:${rank}`;
  for (const [list, value] of [
    [positives, true],
    [negatives, false],
  ] as const) {
    for (const named of list) {
      for (const rank of named.ranks.length > 0 ? named.ranks : variant.ranks) {
        for (const suitIndex of named.suits.length > 0 ? named.suits : allSuits) {
          allowed.set(key(suitIndex, rank), value);
        }
      }
    }
  }

  // With nothing named outright, everything not taken away is allowed.
  const fallback = positives.length === 0;
  const possibilities: Identity[] = [];
  for (const rank of variant.ranks) {
    for (const suitIndex of allSuits) {
      if (allowed.get(key(suitIndex, rank)) ?? fallback) possibilities.push({ suitIndex, rank });
    }
  }
  return possibilities;
}

/** The suits and ranks one list item names: `r1`, `red 1`, `1 r`, `r`, `1`, or `rb23`. */
function namedIn(variant: Variant, text: string): Named {
  const match = identityPattern(variant).exec(text);
  if (!match) return { suits: [], ranks: [] };

  // Squished letters, e.g. `rb23` for red or blue, 2 or 3.
  const squish = match[7]?.trim();
  if (squish !== undefined && !RESERVED_NOTES.has(squish)) {
    const suits: number[] = [];
    const ranks: number[] = [];
    for (const letter of squish) {
      const suitIndex = parseSuit(variant, letter);
      const rank = parseRank(letter);
      if (suitIndex !== undefined) suits.push(suitIndex);
      else if (rank !== undefined) ranks.push(rank);
    }
    if (suits.length + ranks.length > 0) return { suits, ranks };
  }

  const suitText = match[1] ?? match[4] ?? match[5];
  const rankText = match[2] ?? match[3] ?? match[6];
  const suitIndex = suitText === undefined ? undefined : parseSuit(variant, suitText);
  const rank = rankText === undefined ? undefined : parseRank(rankText);
  return {
    suits: suitIndex === undefined ? [] : [suitIndex],
    ranks: rank === undefined ? [] : [rank],
  };
}

function parseSuit(variant: Variant, text: string): number | undefined {
  const byLetter = variant.abbreviations.findIndex((letter) => letter.toLowerCase() === text);
  if (byLetter !== -1) return byLetter;
  const byName = variant.suits.findIndex((suit) => suit.display.toLowerCase() === text);
  return byName === -1 ? undefined : byName;
}

function parseRank(text: string): number | undefined {
  if (text === "0" || text === "s" || text === "start") return START_RANK;
  return /^[1-5]$/.test(text) ? Number(text) : undefined;
}

const patterns = new Map<string, RegExp>();

/**
 * Ports `getIdentityNotePatternForVariant`. The capture groups are positional
 * and read by `namedIn`: 1–2 suit then rank, 3–4 rank then suit, 5 suit, 6 rank,
 * 7 squished letters.
 */
function identityPattern(variant: Variant): RegExp {
  const cached = patterns.get(variant.name);
  if (cached) return cached;

  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suitWords = variant.suits.flatMap((suit, index) => [
    escape(variant.abbreviations[index].toLowerCase()),
    escape(suit.display.toLowerCase()),
  ]);
  const ranks = variant.ranks.filter((rank) => rank !== START_RANK).map(String);
  const startWords = variant.rules.upOrDown ? ["0", "s"] : [];
  const rankWords = [...ranks, ...startWords, ...(variant.rules.upOrDown ? ["start"] : [])];
  const letters = [...ranks, ...startWords, ...variant.abbreviations.map((a) => a.toLowerCase())];

  const suit = `(${suitWords.join("|")})`;
  const rank = `(${rankWords.join("|")})`;
  const squish = `([${escape(letters.join(""))}]+)`;
  const pattern = new RegExp(`^(?:${suit} ?${rank}|${rank} ?${suit}|${suit}|${rank}|${squish})$`);
  patterns.set(variant.name, pattern);
  return pattern;
}

export type NoteBorder = "clued" | "finessed" | "discard-permission" | "chop-moved";
export type NoteMark = "trash" | "question" | "exclamation" | "fix";

export interface NoteView {
  /** What a hidden card could be once its note is counted. */
  possibilities: Identity[] | undefined;
  /** The note ruled out some of what the card could otherwise be. */
  narrowed: boolean;
  /** Drawn face down, whatever is known about it. */
  blank: boolean;
  border: NoteBorder | undefined;
  marks: NoteMark[];
  faded: boolean;
}

/**
 * How a card in a hand is drawn given its note, after hanab.live's
 * `getCardBorderPresentation` and `HanabiCard.showCardElements`.
 *
 * A note narrows a hidden card to the identities it names that the card could
 * still be. When the card can be none of them, say the note was `r1` and both
 * red 1s are now in sight, the note is ignored, which is how hanab.live
 * "unmorphs" a disproved note. Once the game is over only real clues show.
 */
export function noteView(
  note: CardNote | undefined,
  card: { identity: Identity; knowledge?: CardKnowledge },
  possibilities: Identity[] | undefined,
  finished: boolean,
): NoteView {
  const live = !finished;
  let shown = possibilities;
  let narrowed = false;
  if (note && possibilities && !isKnown(card.identity)) {
    const both = possibilities.filter((a) => note.possibilities.some((b) => sameIdentity(a, b)));
    if (both.length > 0 && both.length < possibilities.length) {
      shown = both;
      narrowed = true;
    }
  }

  const knowledge = card.knowledge;
  const clued =
    !(note?.unclued && live) && (knowledge?.clued === true || (note?.clued === true && live));
  let border: NoteBorder | undefined;
  if (clued) border = "clued";
  else if (live && note?.finessed) border = "finessed";
  else if (live && note?.discardPermission) border = "discard-permission";
  else if (live && note?.chopMoved) border = "chop-moved";

  const marks: NoteMark[] = [];
  if (live && note) {
    if (note.knownTrash) marks.push("trash");
    if (note.questionMark) marks.push("question");
    if (note.exclamationMark) marks.push("exclamation");
    if (note.needsFix) marks.push("fix");
  }

  const positiveClues = (knowledge?.positiveColors.length ?? 0) + (knowledge?.positiveRanks.length ?? 0);
  return {
    possibilities: shown,
    narrowed,
    blank: live && note?.blank === true,
    border,
    marks,
    faded: live && note?.knownTrash === true && positiveClues === 0,
  };
}

/** The suit and rank every candidate shares, each `UNKNOWN` where they differ. */
export function sharedIdentity(candidates: readonly Identity[]): Identity {
  const [first] = candidates;
  if (!first) return { suitIndex: UNKNOWN_SUIT, rank: UNKNOWN_RANK };
  return {
    suitIndex: candidates.every((c) => c.suitIndex === first.suitIndex) ? first.suitIndex : UNKNOWN_SUIT,
    rank: candidates.every((c) => c.rank === first.rank) ? first.rank : UNKNOWN_RANK,
  };
}
