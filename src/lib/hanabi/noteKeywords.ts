/**
 * The words hanab.live reads in a card note, copied from its `abbreviations.ts`.
 * A note made of one of these (on its own, in square brackets, or after the last
 * `|`) changes how the card is drawn rather than naming what it is.
 *
 * Kept apart from `notes.ts` because suit letters must avoid them too, and
 * `variants.ts` cannot import the note parser that depends on it.
 */

export const KNOWN_TRASH_NOTES = ["kt", "trash", "stale", "bad"];
export const QUESTION_MARK_NOTES = ["?"];
export const EXCLAMATION_MARK_NOTES = ["!"];

export const CHOP_MOVED_NOTES = [
  "cm",
  "chop move",
  "chop moved",
  "5cm", // 5's Chop Move
  "e5cm", // Early 5's Chop Move
  "tcm", // Trash Chop Move
  "tccm", // Tempo Clue Chop Move
  "sdcm", // Scream Discard Chop Move
  "esdcm", // Echo Scream Discard Chop Move
  "sbpcm", // Scream Blind Play Chop Move
  "ocm", // Order Chop Move
  "tocm", // Trash Order Chop Move
  "mcm", // Misplay Chop Move
  "uutdcm", // Unnecessary Unknown Trash Discharge Chop Move
  "uuddcm", // Unnecessary Unknown Dupe Discharge Chop Move
  "dtccm", // Duplicitous Tempo Clue Chop Move
  "atcm", // Assisted Trash Chop Move
  "ttcm", // Time Travel Chop Move
  "bd", // Baton Discard
];

export const FINESSED_NOTES = [
  "f", // Finesse
  "hf", // Hidden Finesse
  "sf", // Sarcastic Finesse
  "cf", // Certain Finesse / Composition Finesse
  "pf", // Priority Finesse
  "gd", // Gentleman's Discard
];

export const DISCARD_PERMISSION_NOTES = ["ptd", "ctd", "discard"];
export const NEEDS_FIX_NOTES = ["fix", "fixme", "needs fix"];
export const BLANK_NOTES = ["blank", "unknown"];
export const CLUED_NOTES = ["clued", "cl"];
export const UNCLUED_NOTES = ["unclued", "x"];

/** Every keyword above, lowercase. */
export const RESERVED_NOTES: ReadonlySet<string> = new Set([
  ...KNOWN_TRASH_NOTES,
  ...QUESTION_MARK_NOTES,
  ...EXCLAMATION_MARK_NOTES,
  ...CHOP_MOVED_NOTES,
  ...FINESSED_NOTES,
  ...DISCARD_PERMISSION_NOTES,
  ...NEEDS_FIX_NOTES,
  ...BLANK_NOTES,
  ...CLUED_NOTES,
  ...UNCLUED_NOTES,
]);
