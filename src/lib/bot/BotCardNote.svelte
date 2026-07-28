<script lang="ts">
  /**
   * The bot's reading of one card, shown in the card's detail sheet.
   *
   * Deliberately kept apart from the note field below it: that one is yours and
   * is exported with the game, this one is the bot's and never leaves the app.
   */
  import type { BotAnalysis } from "./hgroup";
  import { noteDetail } from "./notes";
  import { conventionName } from "./conventions";

  interface Props {
    analysis: BotAnalysis;
    order: number;
  }

  let { analysis, order }: Props = $props();

  let detail = $derived(noteDetail(analysis, order));
  let clue = $derived(
    analysis.interps.filter((interp) => interp.touched.includes(order)).at(-1),
  );

  const STATUS_LABEL: Record<string, string> = {
    "called to play": "called to play",
    finessed: "finessed",
    "chop moved": "chop moved",
    "called to discard": "called to discard",
  };
</script>

{#if detail}
  <section class="stack bot-note">
    <div class="head">
      <h3>Bot's note</h3>
      <span class="tag">{conventionName(analysis.settings)}</span>
    </div>

    {#if detail.note}
      <p class="note">{detail.note}</p>
    {:else}
      <p class="small muted">Nothing to write — no clue has touched this card.</p>
    {/if}

    <p class="small">{detail.summary}</p>

    {#if detail.status !== "none"}
      <p class="small muted">Status: {STATUS_LABEL[detail.status] ?? detail.status}</p>
    {/if}

    {#if clue}
      <p class="small muted">Last clue on it: {clue.detail}.</p>
    {/if}

    <p class="small muted">
      This is common knowledge only — what the whole table can work out — so it matches what the
      holder sees. It is never exported and never mixed into your own note.
    </p>
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

  .note {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 1rem;
    color: var(--accent);
    word-break: break-word;
  }
</style>
