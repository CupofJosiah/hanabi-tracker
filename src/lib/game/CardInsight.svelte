<script lang="ts">
  import { holderView } from "../hanabi/deduce";
  import { identityStatus, isCritical, type GameState, type IdentityStatus } from "../hanabi/engine";
  import { clueName, identityName } from "../hanabi/variants";

  interface Props {
    game: GameState;
    order: number;
  }

  let { game, order }: Props = $props();

  let card = $derived(game.cards[order]);
  let view = $derived(holderView(game, order));
  let holder = $derived(
    card?.holder === game.ourPlayerIndex ? "you" : (game.players[card?.holder ?? -1] ?? "they"),
  );
  let told = $derived.by(() => {
    const knowledge = card?.knowledge;
    if (!knowledge) return [];
    return [
      ...knowledge.positiveColors.map((value) => clueName(game.variant, { kind: "color", value })),
      ...knowledge.positiveRanks.map(String),
    ];
  });

  let ruledOut = $derived.by(() => {
    const knowledge = card?.knowledge;
    if (!knowledge) return [];
    return [
      ...knowledge.negativeColors.map((value) => clueName(game.variant, { kind: "color", value })),
      ...knowledge.negativeRanks.map(String),
    ];
  });

  /** Without a clue either way, the candidate list is the whole deck — noise. */
  let informed = $derived(told.length > 0 || ruledOut.length > 0);

  const LABELS: Record<IdentityStatus, string> = {
    playable: "playable now",
    played: "already played",
    dead: "can never be played",
    later: "needed later",
  };
  const ORDER: IdentityStatus[] = ["playable", "later", "played", "dead"];

  let tally = $derived.by(() => {
    const counts: Record<IdentityStatus, number> = { playable: 0, played: 0, dead: 0, later: 0 };
    for (const identity of view?.possibilities ?? []) counts[identityStatus(game, identity)]++;
    return counts;
  });

  let criticals = $derived(
    (view?.possibilities ?? []).filter((identity) => isCritical(game, identity)).length,
  );
  let total = $derived(view?.possibilities.length ?? 0);
</script>

{#if view}
  <section class="stack insight">
    <h3>What {holder} can tell</h3>

    {#if !informed}
      <p class="small muted">
        No clue has touched this card and none has passed it by, so there is nothing to go on —
        any card is still on.
      </p>
    {:else}
      <p class="small">
        {#if told.length > 0}<span class="muted">Told</span> {told.join(", ")}{/if}
        {#if told.length > 0 && ruledOut.length > 0} · {/if}
        {#if ruledOut.length > 0}<span class="muted">not</span> {ruledOut.join(", ")}{/if}
      </p>
    {/if}

    {#if !informed}
      <!-- The full deck listed out helps nobody. -->
    {:else if total === 0}
      <p class="small warn">
        Nothing fits those clues. Check the slots you tapped for a clue aimed at your own hand.
      </p>
    {:else if total === 1}
      <p>
        <span class="muted small">Knows it is</span>
        <strong>{identityName(game.variant, view.possibilities[0])}</strong>
      </p>
    {:else}
      <p class="small muted">Could be one of {total}</p>
      <p class="maybe">
        {view.possibilities.map((identity) => identityName(game.variant, identity)).join("  ")}
      </p>
    {/if}

    {#if informed && total > 0}
      <div class="pills">
        {#each ORDER as status (status)}
          {#if tally[status] > 0}
            <span class="pill {status}">
              {tally[status] === total ? "all" : tally[status]}
              {LABELS[status]}
            </span>
          {/if}
        {/each}
      </div>

      {#if criticals === total}
        <p class="small warn">Every card it could be is the last copy — discarding it caps a suit.</p>
      {:else if criticals > 0}
        <p class="small muted">{criticals} of them are the last copy of that card.</p>
      {/if}
    {/if}

    {#if view.approximate && view.viewer !== game.ourPlayerIndex}
      <p class="small muted">
        {holder} has seen your hand and you have not, so this may be wider than what they really
        know. Filling in your own cards after the game makes it exact.
      </p>
    {/if}
  </section>
{/if}

<style>
  .insight {
    gap: 6px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }

  .maybe {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9rem;
    word-break: break-word;
  }

  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .pill.playable {
    color: var(--good);
    border-color: color-mix(in srgb, var(--good) 55%, transparent);
  }

  .pill.played,
  .pill.dead {
    color: var(--muted);
  }

  .warn {
    color: var(--warn);
  }
</style>
