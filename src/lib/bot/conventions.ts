/**
 * Which conventions the bot plays by.
 *
 * The level numbers and their gating are scala-bot's (`hgroup/hgroup.scala`,
 * `object Level`) and H-Group's own pages at hanabi.github.io, so setting
 * "HGroup 5" here means the same set of techniques it would mean when you hand
 * the exported game to the analyser.
 *
 * `implemented` is the honest part. A technique is only marked as implemented
 * when the *reader* acts on it — when a clue or a discard is read differently
 * because of it. H-Group's general principles (Clarity, Directness, Urgency,
 * lines, the all-4s test) shape which move a player should choose rather than
 * what a move means, so they are not listed: they are the sort of thing the
 * suggestion panel gestures at and cannot promise.
 */

export type ConventionFamily = "hgroup";

export interface Technique {
  name: string;
  /** Lowest HGroup level at which this technique is on. */
  level: number;
  implemented: boolean;
  blurb: string;
}

/** Ordered by level; mirrors scala-bot's `Level` constants. */
export const TECHNIQUES: readonly Technique[] = [
  {
    name: "Play & save clues",
    level: 1,
    implemented: true,
    blurb: "Focus is the chop if touched, else the newest card the clue just touched.",
  },
  {
    name: "Good Touch Principle",
    level: 1,
    implemented: true,
    blurb: "A touched card is not trash, so trash identities drop out of its note.",
  },
  {
    name: "Early game",
    level: 1,
    implemented: true,
    blurb: "Ends at the first discard of a card nobody knew anything about.",
  },
  {
    name: "Prompts",
    level: 2,
    implemented: true,
    blurb: "A missing card is looked for among already-clued cards first.",
  },
  {
    name: "Finesses",
    level: 2,
    implemented: true,
    blurb: "Failing a prompt, the leftmost unclued card is asked to blind-play.",
  },
  {
    name: "5 stalls",
    level: 2,
    implemented: true,
    blurb: "A 5 clued off chop with nothing else to say is passing the turn, not a play clue.",
  },
  {
    name: "Fix clues",
    level: 3,
    implemented: true,
    blurb: "A clue that stops a card being misplayed rather than starting a play.",
  },
  {
    name: "Sarcastic discards",
    level: 3,
    implemented: true,
    blurb: "Throwing away a card you were known to hold points at the other copy.",
  },
  {
    name: "Play order of 1s",
    level: 3,
    implemented: true,
    blurb: "Freshly drawn 1s first, then the starting hand's, oldest first.",
  },
  {
    name: "Chop moves",
    level: 4,
    implemented: true,
    blurb: "5 Chop Move and Trash Chop Move shift the chop one card left.",
  },
  {
    name: "Order chop moves",
    level: 4,
    implemented: true,
    blurb: "Playing unknown 1s out of order moves a chop, one seat per 1 skipped.",
  },
  {
    name: "Layered finesses",
    level: 5,
    implemented: true,
    blurb: "A blind play may sit behind other unclued cards in the same hand.",
  },
  {
    name: "Ambiguous finesses",
    level: 5,
    implemented: true,
    blurb: "When two hands could answer a finesse, the first passing does not break it.",
  },
  {
    name: "Tempo clues",
    level: 6,
    implemented: true,
    blurb: "A clue that touched nothing new gets a card played — and pays for itself.",
  },
  {
    name: "Focus shifting",
    level: 6,
    implemented: true,
    blurb: "The focus slides past a card the table already knew was playable.",
  },
  {
    name: "Scream & shout discards",
    level: 7,
    implemented: true,
    blurb: "A discard taken instead of a known play is an alarm; the next chop moves.",
  },
  {
    name: "Generation discards",
    level: 7,
    implemented: true,
    blurb: "Throwing away the playable card itself buys a clue and moves no chop.",
  },
  {
    name: "End-game chop moves are off",
    level: 8,
    implemented: true,
    blurb: "Once pace runs out there is no future to hold a card back for.",
  },
  {
    name: "Positional discards & misplays",
    level: 8,
    implemented: true,
    blurb: "With the deck out and a hand of rubbish, the slot thrown names a slot to play.",
  },
  {
    name: "Distribution clues",
    level: 8,
    implemented: false,
    blurb: "Deliberately duplicating a playable card to spread the plays around.",
  },
  {
    name: "Stalling situations",
    level: 9,
    implemented: true,
    blurb: "Locked hands, 8 clues and double-discard positions license a clue that says nothing.",
  },
  {
    name: "Locked hand & 8 clue saves",
    level: 9,
    implemented: true,
    blurb: "Where no discard is legal, any chop card may be saved with any clue.",
  },
  {
    name: "Anxiety plays",
    level: 9,
    implemented: false,
    blurb: "Leaving a locked player at zero clues to force a blind play.",
  },
  {
    name: "Gentleman's & baton discards",
    level: 10,
    implemented: true,
    blurb: "A known card thrown away hands its twin to somebody's finesse position.",
  },
  {
    name: "Sarcastic & certain finesses",
    level: 10,
    implemented: false,
    blurb: "Finesses that risk duplicating a card, and passing it back.",
  },
  {
    name: "Bluffs",
    level: 11,
    implemented: true,
    blurb: "From the seat before the blind play, a one-away card can be clued as a lie.",
  },
  {
    name: "Self-bluffs",
    level: 11,
    implemented: true,
    blurb: "A rank clue can send the receiver's own finesse position off blind.",
  },
];

export const MAX_LEVEL = 11;

/**
 * The highest level at which every technique below it is actually reasoned
 * about, derived from the table rather than kept in step with it by hand.
 */
export const FULLY_IMPLEMENTED_THROUGH = TECHNIQUES.reduce(
  (best, technique) => (technique.implemented ? best : Math.min(best, technique.level - 1)),
  MAX_LEVEL,
);

export interface BotSettings {
  family: ConventionFamily;
  level: number;
  /**
   * Assume the table plays Good Touch. Off makes the bot stop pruning trash
   * from notes, which matches conventions that do not promise it.
   */
  goodTouch: boolean;
  /** Show the bot's note under every card, not just clued ones. */
  noteEveryCard: boolean;
}

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  family: "hgroup",
  level: 11,
  goodTouch: true,
  noteEveryCard: false,
};

export function conventionName(settings: BotSettings): string {
  return `HGroup${settings.level}`;
}

/** True when a technique is both switched on by the level and actually coded. */
export function active(settings: BotSettings, technique: Technique): boolean {
  return technique.implemented && settings.level >= technique.level;
}

/** The techniques the level asks for that are not in the reasoning yet. */
export function missingTechniques(settings: BotSettings): Technique[] {
  return TECHNIQUES.filter((t) => !t.implemented && settings.level >= t.level);
}

export function levelAllows(settings: BotSettings, level: number): boolean {
  return settings.level >= level;
}
