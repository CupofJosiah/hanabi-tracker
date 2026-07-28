<script lang="ts">
  import { identityKey } from "../hanabi/deduce";
  import { initialDeckIndex, setDealtCard, setupComplete } from "../hanabi/recording";
  import { handSize, isKnown, UNKNOWN, type GameRecord, type Identity } from "../hanabi/types";
  import { allIdentities, copiesOf, getVariant } from "../hanabi/variants";
  import CardFace from "../ui/CardFace.svelte";
  import IdentityPicker from "../ui/IdentityPicker.svelte";

  interface Props {
    record: GameRecord;
    onchange: (record: GameRecord) => void;
    onready: () => void;
  }

  let { record, onchange, onready }: Props = $props();

  let variant = $derived(getVariant(record.variantName));
  let size = $derived(handSize(record.players.length));
  let picking = $state<{ playerIndex: number; slot: number } | undefined>(undefined);
  let complete = $derived(setupComplete(record));

  /** Copies of each identity not yet entered, so the picker can grey out the rest. */
  let counts = $derived.by(() => {
    const map = new Map<string, number>();
    for (const identity of allIdentities(variant)) {
      map.set(identityKey(identity), copiesOf(variant, identity));
    }
    for (const card of record.deck) {
      if (!isKnown(card)) continue;
      const key = identityKey(card);
      map.set(key, Math.max(0, (map.get(key) ?? 0) - 1));
    }
    return map;
  });

  function cardAt(playerIndex: number, slot: number): Identity {
    return record.deck[initialDeckIndex(record.players.length, playerIndex, slot)] ?? UNKNOWN;
  }

  /** Moves to the next empty slot so a hand can be entered without extra taps. */
  function advance(playerIndex: number, slot: number) {
    for (let s = slot + 1; s <= size; s++) {
      if (!isKnown(cardAt(playerIndex, s))) return { playerIndex, slot: s };
    }
    for (let p = 0; p < record.players.length; p++) {
      if (p === record.ourPlayerIndex) continue;
      for (let s = 1; s <= size; s++) {
        if (!isKnown(cardAt(p, s))) return { playerIndex: p, slot: s };
      }
    }
    return undefined;
  }

  function pick(identity: Identity) {
    if (!picking) return;
    const { playerIndex, slot } = picking;
    onchange(setDealtCard(record, playerIndex, slot, identity));
    picking = advance(playerIndex, slot);
  }
</script>

<div class="body">
  <section class="card-panel stack">
    <h2>Deal</h2>
    <p class="muted small">
      Enter everyone else's starting hand. <strong>Slot 1 is where new cards go</strong> — keep
      drawing to that same end all game and the export will line up. Your own hand stays hidden.
    </p>
  </section>

  {#each record.players as name, playerIndex (playerIndex)}
    <section class="card-panel stack" class:ours={playerIndex === record.ourPlayerIndex}>
      <div class="spread">
        <h2>{name}</h2>
        {#if playerIndex === record.ourPlayerIndex}<span class="pill">you · hidden</span>{/if}
      </div>
      <div class="slots">
        {#each Array.from({ length: size }, (_, i) => i + 1) as slot (slot)}
          {@const identity = cardAt(playerIndex, slot)}
          <div class="slot">
            <CardFace
              {variant}
              {identity}
              size="lg"
              onclick={playerIndex === record.ourPlayerIndex
                ? undefined
                : () => (picking = { playerIndex, slot })}
              label={playerIndex === record.ourPlayerIndex
                ? `your slot ${slot}, hidden`
                : `${name} slot ${slot}`}
            />
            <span class="muted small">slot {slot}</span>
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>

<div class="footer">
  <button class="btn btn-primary btn-block" disabled={!complete} onclick={onready}>
    {complete ? "Start the game" : "Enter every card to start"}
  </button>
</div>

{#if picking}
  {@const target = picking}
  <IdentityPicker
    {variant}
    {counts}
    title="{record.players[target.playerIndex]} · slot {target.slot}"
    subtitle="Remaining copies are shown in the corner."
    onpick={pick}
    onclose={() => (picking = undefined)}
  />
{/if}

<style>
  .ours {
    opacity: 0.7;
  }

  .slots {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .slot {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }
</style>
