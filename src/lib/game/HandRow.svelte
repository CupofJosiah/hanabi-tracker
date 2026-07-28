<script lang="ts">
  import type { GameState } from "../hanabi/engine";
  import type { Identity } from "../hanabi/types";
  import CardFace from "../ui/CardFace.svelte";

  interface Props {
    game: GameState;
    playerIndex: number;
    notes?: Record<number, string>;
    possibilities?: Map<number, Identity[]>;
    /** Orders the player may tap right now; everything else is dimmed. */
    selectable?: Set<number>;
    selected?: Set<number>;
    highlight?: Set<number>;
    onselect?: (order: number) => void;
    /** Shown under the name, e.g. "tap the touched cards". */
    hint?: string;
  }

  let {
    game,
    playerIndex,
    notes,
    possibilities,
    selectable,
    selected,
    highlight,
    onselect,
    hint,
  }: Props = $props();

  let hand = $derived(game.hands[playerIndex] ?? []);
  let isCurrent = $derived(game.currentPlayerIndex === playerIndex && !game.finished);
  let isUs = $derived(game.ourPlayerIndex === playerIndex);
</script>

<section class="hand" class:current={isCurrent}>
  <div class="head">
    <span class="name">
      {#if isCurrent}<span class="turn" aria-label="To act">▸</span>{/if}
      {game.players[playerIndex]}
    </span>
    {#if isUs}<span class="pill you">you</span>{/if}
    {#if hint}<span class="muted small">{hint}</span>{/if}
  </div>

  <div class="cards">
    {#each hand as order (order)}
      {@const card = game.cards[order]}
      <CardFace
        variant={game.variant}
        identity={card.identity}
        knowledge={card.knowledge}
        possibilities={possibilities?.get(order)}
        note={notes?.[order]}
        slot={card.slot}
        selected={selected?.has(order)}
        highlight={highlight?.has(order)}
        dim={selectable !== undefined && !selectable.has(order)}
        onclick={onselect && (selectable === undefined || selectable.has(order))
          ? () => onselect(order)
          : undefined}
      />
    {:else}
      <span class="muted small">no cards</span>
    {/each}
  </div>
</section>

<style>
  .hand {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    padding: 8px 10px 10px;
  }

  .hand.current {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--panel));
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 6px;
  }

  .name {
    font-weight: 650;
    font-size: 0.92rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .turn {
    color: var(--accent);
  }

  .you {
    padding: 1px 7px;
    font-size: 0.68rem;
  }

  .cards {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
</style>
