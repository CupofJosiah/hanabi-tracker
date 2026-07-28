/**
 * Which conventions the bot plays by.
 *
 * The level numbers and their gating are scala-bot's (`hgroup/hgroup.scala`,
 * `object Level`), so setting "HGroup 5" here means the same set of techniques
 * it would mean when you hand the exported game to the analyser.
 *
 * `implemented` is the honest part: this app understands levels 1-5. Choosing a
 * higher level is still worth doing — it is recorded with the game and matches
 * what your table plays — but the techniques above 5 are not in the reasoning
 * yet, and the settings screen says which.
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
    blurb: "Clue before the first discard while anything useful is left to say.",
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
    name: "Chop moves",
    level: 4,
    implemented: true,
    blurb: "5 Chop Move and Trash Chop Move shift the chop one card left.",
  },
  {
    name: "Layered finesses",
    level: 5,
    implemented: true,
    blurb: "A blind play may sit behind other unclued cards in the same hand.",
  },
  {
    name: "Tempo clues",
    level: 6,
    implemented: false,
    blurb: "Re-cluing a card purely to get it played now.",
  },
  { name: "Last resorts", level: 7, implemented: false, blurb: "Locked-hand escapes." },
  { name: "Endgame solving", level: 8, implemented: false, blurb: "Exact endgame lines." },
  {
    name: "Stalling",
    level: 9,
    implemented: true,
    blurb: "A clue with nothing to say at 8 tokens is read as a stall, not a mistake.",
  },
  {
    name: "Special discards",
    level: 10,
    implemented: false,
    blurb: "Gentleman's and baton discards.",
  },
  {
    name: "Bluffs",
    level: 11,
    implemented: true,
    blurb: "A blind play is read as playable-something, not necessarily the promised card.",
  },
];

export const MAX_LEVEL = 11;
/** The highest level at which every technique below it is actually reasoned about. */
export const FULLY_IMPLEMENTED_THROUGH = 5;

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
