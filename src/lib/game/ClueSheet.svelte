<script lang="ts">
  import { previewClue, type GameState } from "../hanabi/engine";
  import type { Clue } from "../hanabi/types";
  import { RANKS } from "../hanabi/variants";
  import { suitBackground, suitInk } from "../ui/colors";
  import Sheet from "../ui/Sheet.svelte";
  import HandRow from "./HandRow.svelte";

  interface Props {
    game: GameState;
    onconfirm: (target: number, clue: Clue, touched: number[]) => void;
    onclose: () => void;
  }

  let { game, onconfirm, onclose }: Props = $props();

  let others = $derived(
    game.players.map((_, index) => index).filter((index) => index !== game.currentPlayerIndex),
  );
  // Until a seat is tapped, aim at the next player round — the common case.
  let chosenTarget = $state<number | undefined>(undefined);
  let target = $derived(chosenTarget ?? (game.currentPlayerIndex + 1) % game.players.length);
  let clue = $state<Clue | undefined>(undefined);
  /** Only used when cluing our own hand, where nothing can be derived. */
  let manualTouched = $state<Set<number>>(new Set());

  let cluingUs = $derived(target === game.ourPlayerIndex);
  let touched = $derived(
    clue === undefined
      ? []
      : cluingUs
        ? (game.hands[target] ?? []).filter((order) => manualTouched.has(order))
        : previewClue(game, target, clue),
  );
  let touchesNothing = $derived(clue !== undefined && touched.length === 0);
  // Aimed at our own hand, an empty selection only means "not tapped yet", so
  // say nothing; aimed anywhere else it is a real dead clue.
  let empty = $derived(touchesNothing && !cluingUs);
  let canConfirm = $derived(
    clue !== undefined && (!touchesNothing || game.options.emptyClues),
  );

  function selectTarget(index: number) {
    chosenTarget = index;
    manualTouched = new Set();
  }

  function toggle(order: number) {
    const next = new Set(manualTouched);
    if (next.has(order)) next.delete(order);
    else next.add(order);
    manualTouched = next;
  }
</script>

<Sheet
  title="Give a clue"
  subtitle="{game.players[game.currentPlayerIndex]} is cluing"
  {onclose}
>
  <div class="stack">
    <h3>To</h3>
    <div class="chips">
      {#each others as index (index)}
        <button
          class="chip"
          class:on={target === index}
          aria-pressed={target === index}
          onclick={() => selectTarget(index)}
        >
          {game.players[index]}{index === game.ourPlayerIndex ? " (you)" : ""}
        </button>
      {/each}
    </div>
  </div>

  <div class="stack">
    <h3>Colour</h3>
    <div class="clue-grid">
      {#each game.variant.clueColors as color, value (color.name)}
        <button
          class="clue"
          class:on={clue?.kind === "color" && clue.value === value}
          style:background={suitBackground(game.variant.suits[color.suitIndex])}
          style:color={suitInk(game.variant.suits[color.suitIndex])}
          onclick={() => (clue = { kind: "color", value })}
        >
          {color.name}
        </button>
      {/each}
    </div>
  </div>

  <div class="stack">
    <h3>Rank</h3>
    <div class="clue-grid ranks">
      {#each RANKS as rank (rank)}
        <button
          class="clue rank"
          class:on={clue?.kind === "rank" && clue.value === rank}
          onclick={() => (clue = { kind: "rank", value: rank })}
        >
          {rank}
        </button>
      {/each}
    </div>
  </div>

  <HandRow
    {game}
    playerIndex={target}
    highlight={new Set(touched)}
    selectable={cluingUs && clue !== undefined ? new Set(game.hands[target] ?? []) : undefined}
    onselect={cluingUs && clue !== undefined ? toggle : undefined}
    hint={cluingUs
      ? clue === undefined
        ? "pick the clue first"
        : "tap the cards they pointed at"
      : undefined}
  />

  {#if empty}
    <p class="small warn">
      That clue touches nothing.{game.options.emptyClues
        ? " Allowed by your house rules."
        : " Pick another, or enable empty clues in the game's settings."}
    </p>
  {/if}

  {#snippet footer()}
    <button class="btn btn-block" onclick={onclose}>Cancel</button>
    <button
      class="btn btn-primary btn-block"
      disabled={!canConfirm}
      onclick={() => clue && onconfirm(target, clue, touched)}
    >
      Record clue
    </button>
  {/snippet}
</Sheet>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    min-height: var(--tap);
    padding: 0 14px;
    border-radius: 999px;
    background: var(--panel-2);
    border: 1px solid var(--line);
    font-weight: 600;
  }

  .chip.on {
    background: var(--accent);
    color: var(--accent-ink);
    border-color: transparent;
  }

  .clue-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(78px, 1fr));
    gap: 6px;
  }

  .clue-grid.ranks {
    grid-template-columns: repeat(5, 1fr);
  }

  .clue {
    min-height: 48px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    font-weight: 700;
    font-size: 0.9rem;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
  }

  .clue.rank {
    background: var(--panel-2);
    font-size: 1.2rem;
    text-shadow: none;
  }

  .clue.on {
    box-shadow: 0 0 0 3px var(--accent);
  }

  .warn {
    color: var(--warn);
  }
</style>
