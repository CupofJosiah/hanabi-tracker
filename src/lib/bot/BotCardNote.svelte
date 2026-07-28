<script lang="ts">
  /**
   * The bot's reading of one card, and the controls to overrule it.
   *
   * Deliberately kept apart from the note field below it: that one is yours and
   * is exported with the game, this one is the bot's and never leaves the app.
   *
   * Corrections are chips rather than a second sheet, because a sheet opened
   * from inside a sheet shares the Escape key with its parent, and because two
   * taps at a table beats four.
   */
  import { identityName } from "../hanabi/variants";
  import type { GameRecord } from "../hanabi/types";
  import { identityOfOrd, type CardStatus, type Ord } from "./empathy";
  import type { BotAnalysis } from "./hgroup";
  import { noteDetail } from "./notes";
  import { conventionName } from "./conventions";
  import { bot } from "./bot.svelte";

  interface Props {
    record: GameRecord;
    analysis: BotAnalysis;
    order: number;
  }

  let { record, analysis, order }: Props = $props();

  let detail = $derived(noteDetail(analysis, order));
  let thought = $derived(analysis.thoughts.get(order));
  let override = $derived(bot.overrides[order]);
  let clue = $derived(analysis.interps.filter((interp) => interp.touched.includes(order)).at(-1));
  let correcting = $state(false);

  /** Identities worth offering as "it is really this", newest reading first. */
  let candidates = $derived.by<Ord[]>(() => {
    const pool = thought ? [...thought.possible] : [];
    return pool.sort((a, b) => a - b);
  });
  let showAll = $state(false);
  let shown = $derived(showAll ? candidates : candidates.slice(0, 10));

  const STATUS_LABEL: Record<string, string> = {
    "called to play": "called to play",
    finessed: "finessed",
    "chop moved": "chop moved",
    "called to discard": "called to discard",
  };

  /** The corrections worth having: what a card is doing at your table. */
  const CHOICES: { status: CardStatus; label: string; blurb: string }[] = [
    { status: "called to play", label: "Playing", blurb: "This card is going to be played." },
    { status: "finessed", label: "Blind playing", blurb: "Playing without having been touched." },
    { status: "chop moved", label: "Chop moved", blurb: "Held back from the discard pile." },
    { status: "called to discard", label: "Trash", blurb: "Safe to throw away." },
    { status: "none", label: "Nothing special", blurb: "Carries no instruction." },
  ];

  function setStatus(status: CardStatus) {
    const next = override?.status === status ? undefined : status;
    apply({ status: next, identity: override?.identity });
  }

  function setIdentity(ord: Ord | undefined) {
    apply({ status: override?.status, identity: override?.identity === ord ? undefined : ord });
  }

  function apply(patch: { status?: CardStatus; identity?: Ord }) {
    const empty = patch.status === undefined && patch.identity === undefined;
    bot.correct(
      record.id,
      order,
      empty ? undefined : { ...patch, fromAction: override?.fromAction ?? record.actions.length },
    );
  }

  function clear() {
    bot.correct(record.id, order, undefined);
    correcting = false;
  }
</script>

{#if detail}
  <section class="stack bot-note">
    <div class="head">
      <h3>Bot's note</h3>
      <span class="tag">{conventionName(analysis.settings)}</span>
      {#if thought?.overridden}<span class="tag yours">yours</span>{/if}
    </div>

    {#if detail.note}
      <p class="note" class:corrected={thought?.overridden}>{detail.note}</p>
    {:else}
      <p class="small muted">Nothing to write — no clue has touched this card.</p>
    {/if}

    <p class="small">{detail.summary}</p>

    {#if detail.status !== "none"}
      <p class="small muted">Status: {STATUS_LABEL[detail.status] ?? detail.status}</p>
    {/if}

    {#if clue && !thought?.overridden}
      <p class="small muted">Last clue on it: {clue.detail}.</p>
    {/if}

    {#if thought?.overridden}
      <p class="small muted">
        You told the bot what this card means, so it is reasoning from that rather than from the
        convention.
      </p>
    {/if}

    {#if !correcting}
      <button class="btn btn-block" onclick={() => (correcting = true)}>
        {thought?.overridden ? "Change your correction" : "The bot has this wrong"}
      </button>
    {:else}
      <div class="correct stack">
        <p class="small muted">What is this card actually doing?</p>
        <div class="chips">
          {#each CHOICES as choice (choice.status)}
            <button
              class="chip"
              class:on={override?.status === choice.status}
              title={choice.blurb}
              onclick={() => setStatus(choice.status)}
            >
              {choice.label}
            </button>
          {/each}
        </div>

        <p class="small muted">And is it a card you know?</p>
        <div class="chips">
          {#each shown as ord (ord)}
            <button
              class="chip mono"
              class:on={override?.identity === ord}
              onclick={() => setIdentity(ord)}
            >
              {identityName(analysis.state.variant, identityOfOrd(ord))}
            </button>
          {/each}
          {#if candidates.length > shown.length}
            <button class="chip ghost" onclick={() => (showAll = true)}>
              +{candidates.length - shown.length} more
            </button>
          {/if}
        </div>

        <div class="row">
          <button class="btn grow" onclick={clear} disabled={override === undefined}>
            Clear correction
          </button>
          <button class="btn grow" onclick={() => (correcting = false)}>Done</button>
        </div>
        <p class="small muted">
          Corrections apply from now on, not backwards, and everything downstream follows — the
          notes, the clues the bot reads next, and what it suggests. They are kept on this device,
          apart from the game, so they never reach the export.
        </p>
      </div>
    {/if}

    {#if !correcting}
      <p class="small muted">
        This is common knowledge only — what the whole table can work out — so it matches what the
        holder sees. It is never exported and never mixed into your own note.
      </p>
    {/if}
  </section>
{/if}

<style>
  .bot-note {
    gap: 6px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .head h3 {
    margin: 0;
  }

  .tag {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
    border-radius: 999px;
    padding: 1px 7px;
  }

  .tag.yours {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 55%, transparent);
  }

  .note {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 1rem;
    color: var(--accent);
    word-break: break-word;
  }

  .note.corrected {
    color: var(--warn);
  }

  .correct {
    gap: 6px;
    padding: 10px;
    border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
    border-radius: 10px;
    background: var(--panel-3);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--text);
    font-size: 0.8rem;
    padding: 6px 11px;
    cursor: pointer;
    min-height: 34px;
  }

  .chip.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .chip.ghost {
    color: var(--muted);
  }

  .chip.on {
    border-color: var(--warn);
    background: color-mix(in srgb, var(--warn) 18%, var(--panel));
    color: var(--warn);
  }

  .grow {
    flex: 1;
  }
</style>
