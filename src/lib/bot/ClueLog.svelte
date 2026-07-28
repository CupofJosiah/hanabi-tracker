<script lang="ts">
  /**
   * What the bot made of every clue, and the chance to disagree.
   *
   * The bot picks a reading by Occam's razor, but it always finds more than one
   * and the runner-up is often what your table actually meant. Rather than make
   * you describe the cards one at a time, this shows the readings it considered
   * and lets you pick the right one in a tap.
   *
   * It also shows the two things a bot normally keeps to itself: what it is
   * still waiting for, and where it has already changed its mind.
   */
  import { identityName } from "../hanabi/variants";
  import type { GameRecord } from "../hanabi/types";
  import { identityOfOrd, type Ord } from "./empathy";
  import type { BotAnalysis, ClueInterp } from "./hgroup";
  import { bot } from "./bot.svelte";

  interface Props {
    record: GameRecord;
    analysis: BotAnalysis;
  }

  let { record, analysis }: Props = $props();

  let open = $state(false);
  let expanded = $state<number | undefined>(undefined);

  // Not called `state`: `$state` would then read as a store subscription.
  let board = $derived(analysis.state);
  let recent = $derived([...analysis.interps].reverse().slice(0, 12));
  let changed = $derived(analysis.reinterpretations);

  function name(ord: Ord): string {
    return identityName(board.variant, identityOfOrd(ord));
  }

  function slotOf(order: number): string {
    const card = board.cards[order];
    if (!card || card.holder < 0) return "a card since played";
    return `${board.players[card.holder]} slot ${card.slot}`;
  }

  /** The readings still on the table for a clue, cheapest first. */
  function readings(interp: ClueInterp) {
    return interp.alternatives.filter((alt) => !interp.ruledOut.includes(alt.identity));
  }

  function describe(interp: ClueInterp, identity: Ord): string {
    const alt = interp.alternatives.find((fp) => fp.identity === identity);
    if (!alt) return name(identity);
    if (alt.save) return `${name(identity)} — save it`;
    if (alt.connections.length === 0) return `${name(identity)} — play it`;
    const via = alt.connections
      .map((link) => `${link.kind} ${name(link.identity)} (${slotOf(link.order)})`)
      .join(", then ");
    return `${name(identity)} — after ${via}`;
  }

  function pick(interp: ClueInterp, identity: Ord | undefined) {
    bot.readClue(record.id, interp.actionIndex, identity);
  }

  const KIND_LABEL: Record<string, string> = {
    play: "play clue",
    save: "save",
    fix: "fix",
    "chop move": "chop move",
    stall: "stall",
    useless: "said nothing",
    unclear: "unclear",
  };
</script>

<section class="card-panel log" aria-label="Bot clue readings">
  <div class="head">
    <h2><span class="tag">bot</span> What each clue meant</h2>
    <button class="link" onclick={() => (open = !open)}>{open ? "hide" : "show"}</button>
  </div>

  {#if open}
    {#if analysis.waiting.length > 0}
      <ul class="waiting">
        {#each analysis.waiting as wc (wc.actionIndex + ":" + wc.index)}
          {@const link = wc.connections[wc.index]}
          {#if link}
            <li class="small">
              Waiting on <strong>{board.players[link.playerIndex]}</strong>
              to {link.kind === "finesse" ? "blind-play" : "play"}
              {name(link.identity)}
              <span class="muted">({slotOf(link.order)}) — for {name(wc.identity)}</span>
            </li>
          {/if}
        {/each}
      </ul>
    {/if}

    {#if changed.length > 0}
      <ul class="changed">
        {#each changed as item (item.actionIndex + ":" + item.identity)}
          <li class="small">
            Changed its mind: {name(item.identity)} no longer fits — {item.reason}.
          </li>
        {/each}
      </ul>
    {/if}

    {#if recent.length === 0}
      <p class="small muted">No clues given yet.</p>
    {:else}
      <ol class="clues">
        {#each recent as interp (interp.actionIndex)}
          {@const options = readings(interp)}
          <li>
            <button
              class="clue"
              class:overridden={interp.overridden}
              class:iffy={interp.kind === "unclear"}
              onclick={() =>
                (expanded = expanded === interp.actionIndex ? undefined : interp.actionIndex)}
              aria-expanded={expanded === interp.actionIndex}
            >
              <span class="turn">t{interp.actionIndex + 1}</span>
              <span class="what">
                <strong>
                  to {board.players[interp.target]} · {KIND_LABEL[interp.kind] ?? interp.kind}
                </strong>
                <span class="small muted">{interp.detail}</span>
              </span>
              <span class="chev">{expanded === interp.actionIndex ? "▾" : "▸"}</span>
            </button>

            {#if expanded === interp.actionIndex}
              <div class="alts stack">
                {#if options.length === 0}
                  <p class="small muted">
                    The bot found no reading for this clue. Tap the card itself and use
                    <em>The bot has this wrong</em> to tell it what the clue meant.
                  </p>
                {:else}
                  <p class="small muted">
                    {options.length === 1
                      ? "The only reading it found:"
                      : "It settled on the first; pick another if your table meant it:"}
                  </p>
                  <div class="chips">
                    {#each options as option (option.identity)}
                      <button
                        class="chip"
                        class:on={interp.chosen.includes(option.identity)}
                        class:yours={interp.overridden && interp.chosen.includes(option.identity)}
                        onclick={() =>
                          pick(
                            interp,
                            interp.overridden && interp.chosen.includes(option.identity)
                              ? undefined
                              : option.identity,
                          )}
                      >
                        {describe(interp, option.identity)}
                      </button>
                    {/each}
                  </div>
                {/if}

                {#if interp.ruledOut.length > 0}
                  <p class="small muted">
                    Ruled out since: {interp.ruledOut.map(name).join(", ")}.
                  </p>
                {/if}

                {#if interp.overridden}
                  <p class="small muted">
                    You picked this reading. Tap it again to hand the clue back to the bot.
                  </p>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ol>

      <p class="small muted">
        Readings are common knowledge — what the whole table can work out. Picking one is kept on
        this device and never reaches the export.
      </p>
    {/if}
  {/if}
</section>

<style>
  .log {
    border-color: color-mix(in srgb, var(--accent) 25%, var(--line));
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .head h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.95rem;
    margin: 0;
  }

  .tag {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
    border-radius: 999px;
    padding: 1px 7px;
  }

  .link {
    background: none;
    border: none;
    color: var(--muted);
    font-size: 0.8rem;
    padding: 4px;
    cursor: pointer;
  }

  .waiting,
  .changed {
    list-style: none;
    margin: 6px 0 0;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--panel-3);
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .changed {
    border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line));
    color: var(--warn);
  }

  .clues {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .clue {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    text-align: left;
    background: var(--panel-3);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 7px 10px;
    color: inherit;
    cursor: pointer;
  }

  .clue.iffy {
    border-color: color-mix(in srgb, var(--warn) 45%, var(--line));
  }

  .clue.overridden {
    border-color: var(--warn);
  }

  .turn {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
    color: var(--muted);
    min-width: 2.6em;
  }

  .what {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1;
    min-width: 0;
  }

  .chev {
    color: var(--muted);
  }

  .alts {
    gap: 6px;
    padding: 8px 10px 2px calc(2.6em + 20px);
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
    font-size: 0.78rem;
    padding: 6px 11px;
    cursor: pointer;
    min-height: 34px;
    text-align: left;
  }

  .chip.on {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 15%, var(--panel));
    color: var(--accent);
  }

  .chip.yours {
    border-color: var(--warn);
    background: color-mix(in srgb, var(--warn) 18%, var(--panel));
    color: var(--warn);
  }
</style>
