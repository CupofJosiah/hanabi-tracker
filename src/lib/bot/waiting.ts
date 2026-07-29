/**
 * Promises the table is still waiting on, and what it means when one fails.
 *
 * scala-bot's `hgroup/updateWcs.scala`. A clue that asks someone to blind-play
 * is not finished when it is given: it is a claim about the next few turns, and
 * the turns that follow either bear it out or refute it.
 *
 * Refutation is the interesting half. If Bob was asked to blind-play and gives
 * a clue instead, the reading was wrong — not Bob. The bot drops that reading
 * and works out what else the clue could have meant. That is the difference
 * between a bot that reads clues and one that only reads them once.
 */
import type { GameState } from "../hanabi/engine";
import { ActionType, type GameAction } from "../hanabi/types";
import type { Connection } from "./connect";
import { isPlayPromised, ordOf, type Ord, type Thought } from "./empathy";
import { isKnown } from "../hanabi/types";

export interface WaitingConnection {
  /** Index into `record.actions` of the clue that made the promise. */
  actionIndex: number;
  focus: number;
  /** What the focus was read as, if the promise holds. */
  identity: Ord;
  connections: Connection[];
  /** How many links have already been settled. */
  index: number;
  giver: number;
  target: number;
  /** Turn the promise was made, so it is never judged on the turn it was made. */
  turn: number;
}

/** Why a reading stopped being tenable — shown to you, so the bot has to justify itself. */
export interface Disproof {
  actionIndex: number;
  identity: Ord;
  /** The action that refuted it. */
  atAction: number;
  reason: string;
}

export function currentLink(wc: WaitingConnection): Connection | undefined {
  return wc.connections[wc.index];
}

export interface WaitingUpdate {
  kept: WaitingConnection[];
  disproven: Disproof[];
  /** Orders whose promise came good, so the note can stop claiming it. */
  settled: number[];
}

/**
 * Judges every outstanding promise against one action.
 *
 * @param before  the board as the actor found it
 * @param after   the board once the action was taken
 */
export function updateWaiting(
  before: GameState,
  after: GameState,
  thoughts: Map<number, Thought>,
  waiting: readonly WaitingConnection[],
  action: GameAction,
  actor: number,
  actionIndex: number,
): WaitingUpdate {
  const kept: WaitingConnection[] = [];
  const disproven: Disproof[] = [];
  const settled: number[] = [];

  for (const wc of waiting) {
    // Never judged on the turn it was made: the promise is about what happens next.
    if (wc.turn >= before.turn) {
      kept.push(wc);
      continue;
    }

    const link = currentLink(wc);
    if (!link) continue; // nothing left to wait for

    const drop = (reason: string): void => {
      disproven.push({ actionIndex: wc.actionIndex, identity: wc.identity, atAction: actionIndex, reason });
    };

    // The focus itself can no longer be what the reading claimed.
    const focusThought = thoughts.get(wc.focus);
    if (focusThought && !focusThought.possible.has(wc.identity)) {
      drop("the card cannot be that identity any more");
      continue;
    }

    // A link's card can no longer be what the connection needs it to be.
    const linkThought = link.order >= 0 ? thoughts.get(link.order) : undefined;
    if (link.order >= 0 && linkThought && !linkThought.possible.has(link.identity)) {
      drop("the connecting card cannot be that identity any more");
      continue;
    }

    const isPlay = action.type === ActionType.Play;
    const isDiscard = action.type === ActionType.Discard;
    const movedOrder = isPlay || isDiscard ? action.target : -1;

    // The connecting card itself left the hand.
    if (link.order >= 0 && movedOrder === link.order) {
      if (isPlay) {
        settled.push(link.order);
        const advanced = advance(wc);
        if (advanced) kept.push(advanced);
      } else {
        drop("the card it was waiting on was discarded");
      }
      continue;
    }

    if (actor !== link.playerIndex) {
      // Somebody else played the very card we were waiting for, so the promise
      // is met from a different hand.
      if (isPlay && playedIdentityMatches(after, movedOrder, link.identity)) {
        settled.push(movedOrder);
        const advanced = advance(wc);
        if (advanced) kept.push(advanced);
      } else {
        kept.push(wc);
      }
      continue;
    }

    // It was their turn and they did something else.
    if (isPlay) {
      // Playing into an older promise is allowed; they get to it in order.
      const played = thoughts.get(movedOrder);
      if (played && isPlayPromised(played)) {
        kept.push(wc);
        continue;
      }
      if (link.kind === "known" || link.kind === "playable") {
        kept.push(wc);
        continue;
      }
      drop(`${before.players[actor]} played something else instead`);
      continue;
    }

    // Only a prompt or a blind play has to be answered on the spot; that
    // urgency is what makes silence a refutation. A card the table already
    // expects to play in due course — known, or known-playable without knowing
    // which — is under no such obligation, and its holder passing the turn says
    // nothing about the reading.
    if (link.kind === "known" || link.kind === "playable") {
      kept.push(wc);
      continue;
    }

    drop(
      isDiscard
        ? `${before.players[actor]} discarded instead of playing`
        : `${before.players[actor]} gave a clue instead of playing`,
    );
  }

  return { kept, disproven, settled };
}

function advance(wc: WaitingConnection): WaitingConnection | undefined {
  const next = wc.index + 1;
  if (next >= wc.connections.length) return undefined;
  return { ...wc, index: next };
}

function playedIdentityMatches(state: GameState, order: number, identity: Ord): boolean {
  const card = state.cards[order];
  if (!card || !isKnown(card.identity)) return false;
  return ordOf(card.identity) === identity;
}
