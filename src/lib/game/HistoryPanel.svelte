<script lang="ts">
  import type { GameState } from "../hanabi/engine";

  interface Props {
    game: GameState;
    /** When set, tapping an entry rewinds the view to just after that action. */
    onselect?: (actionIndex: number) => void;
    selectedIndex?: number;
    open?: boolean;
  }

  let { game, onselect, selectedIndex, open = false }: Props = $props();
  let entries = $derived([...game.log].reverse());
</script>

<details class="card-panel" {open}>
  <summary>
    <h3>History</h3>
    <span class="muted small">{game.log.length} action{game.log.length === 1 ? "" : "s"}</span>
  </summary>

  <ol class="log">
    {#each entries as entry (entry.actionIndex)}
      <li>
        <svelte:element
          this={onselect ? "button" : "div"}
          type={onselect ? "button" : undefined}
          role={onselect ? "button" : undefined}
          class="entry {entry.kind}"
          class:selected={selectedIndex === entry.actionIndex}
          onclick={onselect ? () => onselect(entry.actionIndex) : undefined}
        >
          <span class="turn">{entry.turn}</span>
          <span class="text">{entry.text}</span>
        </svelte:element>
      </li>
    {:else}
      <li class="muted small">Nothing recorded yet.</li>
    {/each}
  </ol>
</details>

<style>
  summary {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    cursor: pointer;
  }

  .log {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 46vh;
    overflow-y: auto;
  }

  .entry {
    display: flex;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 5px 8px;
    border-radius: 8px;
    font-size: 0.85rem;
    border-left: 3px solid transparent;
  }

  .entry.selected {
    background: var(--panel-2);
  }

  .entry.play {
    border-left-color: var(--good);
  }
  .entry.bomb {
    border-left-color: var(--danger);
  }
  .entry.discard {
    border-left-color: var(--muted);
  }
  .entry.clue {
    border-left-color: var(--accent);
  }
  .entry.end {
    border-left-color: var(--warn);
  }

  .turn {
    flex: none;
    width: 1.6rem;
    text-align: right;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .text {
    min-width: 0;
  }
</style>
