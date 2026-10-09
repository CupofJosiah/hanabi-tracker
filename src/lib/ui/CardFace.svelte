<script lang="ts">
  import { UNKNOWN, isKnown, type Identity } from "../hanabi/types";
  import type { CardKnowledge } from "../hanabi/engine";
  import { noteView, parseNote, sharedIdentity, type NoteBorder } from "../hanabi/notes";
  import {
    clueName,
    identityName,
    rankLabel,
    suitAbbreviation,
    type Variant,
  } from "../hanabi/variants";
  import { suitBackground, suitInk } from "./colors";

  interface Props {
    variant: Variant;
    identity?: Identity;
    knowledge?: CardKnowledge;
    /** For a hidden card: what it could still be. One candidate is shown as the card. */
    possibilities?: Identity[];
    size?: "sm" | "md" | "lg";
    slot?: number;
    selected?: boolean;
    dim?: boolean;
    highlight?: boolean;
    /** The card's note, drawn the way hanab.live draws it. Only pass it for a card in a hand. */
    note?: string;
    /** Once the game is over, a note no longer marks or borders its card. */
    finished?: boolean;
    onclick?: () => void;
    label?: string;
  }

  let {
    variant,
    identity = UNKNOWN,
    knowledge,
    possibilities,
    size = "md",
    slot,
    selected = false,
    dim = false,
    highlight = false,
    note,
    finished = false,
    onclick,
    label,
  }: Props = $props();

  const borderWording: Partial<Record<NoteBorder, string>> = {
    finessed: "finessed",
    "chop-moved": "chop moved",
    "discard-permission": "may be discarded",
  };
  const markWording = {
    trash: "known trash",
    question: "question mark",
    exclamation: "exclamation mark",
    fix: "needs a fix",
  };

  let view = $derived(
    noteView(note ? parseNote(variant, note) : undefined, { identity, knowledge }, possibilities, finished),
  );
  let candidates = $derived(view.possibilities);

  // A note that narrows a hidden card shows it as whatever suit and rank the
  // note pins down, in full colour, as hanab.live does.
  let noted = $derived(
    !view.blank && view.narrowed && candidates ? sharedIdentity(candidates) : undefined,
  );
  // Otherwise a hidden card with a single remaining candidate is effectively
  // known; show it greyed out so it reads as "deduced" rather than "seen".
  let deduced = $derived(
    !view.blank && !view.narrowed && !isKnown(identity) && candidates?.length === 1
      ? candidates[0]
      : undefined,
  );
  let face = $derived(
    view.blank ? UNKNOWN : isKnown(identity) ? identity : (noted ?? deduced ?? UNKNOWN),
  );
  let suit = $derived(face.suitIndex >= 0 ? variant.suits[face.suitIndex] : undefined);

  function notedName(shared: Identity): string {
    if (isKnown(shared)) return `noted ${identityName(variant, shared)}`;
    if (shared.suitIndex >= 0) return `noted ${variant.suits[shared.suitIndex].display}`;
    if (shared.rank >= 0) return `noted ${rankLabel(shared.rank)}`;
    return "unknown card, noted";
  }

  let accessibleName = $derived.by(() => {
    if (label) return label;
    const name = view.blank
      ? "blank card"
      : isKnown(identity)
        ? identityName(variant, identity)
        : noted
          ? notedName(noted)
          : deduced
            ? `probably ${identityName(variant, deduced)}`
            : "unknown card";
    const extra = view.border ? borderWording[view.border] : undefined;
    return [name, extra, ...view.marks.map((mark) => markWording[mark])].filter(Boolean).join(", ");
  });
</script>

<svelte:element
  this={onclick ? "button" : "div"}
  type={onclick ? "button" : undefined}
  class="card {size} {view.border ?? ''}"
  class:selected
  class:dim
  class:highlight
  class:faded={view.faded}
  class:deduced={deduced !== undefined}
  class:unknown={!suit}
  style:background={suit ? suitBackground(suit) : undefined}
  style:color={suit ? suitInk(suit) : undefined}
  role={onclick ? "button" : "img"}
  aria-label={accessibleName}
  aria-pressed={onclick ? selected : undefined}
  {onclick}
>
  <span class="rank" class:faint={face.rank < 0}>{rankLabel(face.rank)}</span>
  {#if suit}
    <span class="suit">{suitAbbreviation(variant, face.suitIndex)}</span>
  {/if}
  {#if !isKnown(face) && !view.blank}
    {#if knowledge && (knowledge.positiveRanks.length > 0 || knowledge.positiveColors.length > 0)}
      <span class="chips">
        {#each knowledge.positiveRanks as rank (rank)}
          <span class="chip">{clueName(variant, { kind: "rank", value: rank })}</span>
        {/each}
        {#each knowledge.positiveColors as color (color)}
          <!-- The colour's own swatch, not a suit's: one colour may name several
               suits (Ambiguous) and one suit several colours (Dual-Color). -->
          <span class="chip dot" style:background={variant.clueColors[color]?.fill}></span>
        {/each}
      </span>
    {/if}
    {#if !suit && candidates && candidates.length > 1 && candidates.length <= 4}
      <span class="maybe">{candidates.map((p) => identityName(variant, p)).join(" ")}</span>
    {/if}
  {/if}

  {#if view.marks.length > 0}
    <span class="marks" aria-hidden="true">
      {#each view.marks as mark (mark)}
        <span class="mark">
          {#if mark === "trash"}
            <svg viewBox="0 0 24 24"
              ><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg
            >
          {:else if mark === "fix"}
            <svg viewBox="0 0 24 24"
              ><path
                d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"
              /></svg
            >
          {:else}
            {mark === "question" ? "?" : "!"}
          {/if}
        </span>
      {/each}
    </span>
  {/if}

  {#if slot !== undefined}
    <span class="slot">{slot}</span>
  {/if}
  {#if note}
    <span class="note-dot" title={note}></span>
  {/if}
</svelte:element>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: var(--panel-3);
    color: var(--text);
    border: 1px solid rgba(255, 255, 255, 0.28);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
    flex: none;
    overflow: hidden;
    padding: 0;
    text-align: center;
    transition:
      transform 0.1s ease,
      box-shadow 0.1s ease;
  }

  .sm {
    width: 34px;
    height: 48px;
  }
  .md {
    width: 44px;
    height: 62px;
  }
  .lg {
    width: 58px;
    height: 82px;
  }

  .rank {
    font-weight: 800;
    line-height: 1;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  }
  .sm .rank {
    font-size: 1.1rem;
  }
  .md .rank {
    font-size: 1.5rem;
  }
  .lg .rank {
    font-size: 2rem;
  }

  .faint {
    color: var(--muted);
  }

  .suit {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    opacity: 0.85;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  }

  .deduced {
    filter: saturate(0.55) brightness(0.8);
    border-style: dashed;
  }

  .unknown {
    background:
      repeating-linear-gradient(
        135deg,
        rgba(255, 255, 255, 0.03) 0 6px,
        transparent 6px 12px
      ),
      var(--panel-3);
  }

  .clued {
    border-color: var(--warn);
    box-shadow: 0 0 0 1px var(--warn);
  }

  /* hanab.live's colours for the borders a note can draw. */
  .finessed {
    border-color: aqua;
    box-shadow: 0 0 0 1px aqua;
  }

  .discard-permission {
    border-color: #c03a3a;
    box-shadow: 0 0 0 1px #c03a3a;
  }

  .chop-moved {
    border-color: #fffce6;
    box-shadow: 0 0 0 1px #fffce6;
  }

  .selected {
    transform: translateY(-4px);
    box-shadow: 0 0 0 3px var(--accent);
  }

  .highlight {
    box-shadow: 0 0 0 3px var(--good);
  }

  /* Known trash nobody has clued, after hanab.live's fade. */
  .faded {
    opacity: 0.6;
  }

  .dim {
    opacity: 0.35;
  }

  .chips {
    position: absolute;
    top: 2px;
    left: 2px;
    right: 2px;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    justify-content: center;
  }

  .chip {
    min-width: 12px;
    height: 12px;
    border-radius: 4px;
    background: var(--panel);
    border: 1px solid var(--line);
    font-size: 0.6rem;
    font-weight: 700;
    line-height: 10px;
  }

  .chip.dot {
    width: 12px;
    border-radius: 999px;
  }

  .maybe {
    position: absolute;
    bottom: 1px;
    left: 0;
    right: 0;
    font-size: 0.5rem;
    line-height: 1.15;
    color: var(--muted);
    word-break: break-all;
  }

  .slot {
    position: absolute;
    bottom: 1px;
    right: 3px;
    font-size: 0.55rem;
    font-weight: 700;
    opacity: 0.65;
  }

  .marks {
    position: absolute;
    inset: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    align-content: center;
    gap: 2px;
    pointer-events: none;
  }
  .sm .marks {
    font-size: 0.7rem;
  }
  .md .marks {
    font-size: 0.9rem;
  }
  .lg .marks {
    font-size: 1.2rem;
  }

  .mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.6em;
    height: 1.6em;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-weight: 800;
    line-height: 1;
  }

  .mark svg {
    width: 1.05em;
    height: 1.05em;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .note-dot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--accent);
  }
</style>
