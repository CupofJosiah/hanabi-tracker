<script lang="ts">
  import { app } from "../state/app.svelte";
  import { stateOf } from "../hanabi/engine";
  import {
    autoResolve,
    countsForCorrection,
    possibleIdentities,
    unseenCounts,
  } from "../hanabi/deduce";
  import { exportIssues, serialize } from "../hanabi/hanabLive";
  import { endGame, revealCard, revealMany } from "../hanabi/recording";
  import { isKnown, type GameRecord, type Identity } from "../hanabi/types";
  import { identityName } from "../hanabi/variants";
  import CardFace from "../ui/CardFace.svelte";
  import IdentityPicker from "../ui/IdentityPicker.svelte";
  import Sheet from "../ui/Sheet.svelte";
  import HandRow from "../game/HandRow.svelte";
  import HistoryPanel from "../game/HistoryPanel.svelte";
  import StatusStrip from "../game/StatusStrip.svelte";
  import { canShareFiles, copyText, download, shareFile } from "../ui/share";

  interface Props {
    record: GameRecord;
  }

  let { record }: Props = $props();

  let full = $derived(stateOf(record));
  let through = $state<number | undefined>(undefined);
  let viewed = $derived(through === undefined ? full : stateOf(record, through + 1));
  let counts = $derived(unseenCounts(full));
  let editing = $state<number | undefined>(undefined);
  let showJson = $state(false);
  let confirmDelete = $state(false);

  let json = $derived(serialize(record));
  let issues = $derived(exportIssues(record));
  let blocking = $derived(issues.some((issue) => issue.severity === "error"));
  let filename = $derived(
    `${record.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "hanabi"}.json`,
  );

  let unknowns = $derived(
    full.cards
      .filter((card) => card && !isKnown(card.identity))
      .map((card) => ({
        order: card.order,
        holder: card.holder,
        slot: card.slot,
        location: card.location,
        options: possibleIdentities(full, card.order, counts),
      })),
  );

  let resolvable = $derived(autoResolve(full));

  function whose(holder: number, slot: number, location: string): string {
    if (holder >= 0) return `${record.players[holder]} · slot ${slot}`;
    return location === "played" ? "played" : "discarded";
  }

  async function copy() {
    app.toast((await copyText(json)) ? "JSON copied." : "Could not copy — use Download instead.", "info");
  }

  async function share() {
    if (!(await shareFile(filename, json))) download(filename, json);
  }
</script>

<header class="topbar">
  <button class="icon-btn" aria-label="Back" onclick={() => app.go({ name: "home" })}>‹</button>
  <h1>{record.title}</h1>
  {#if !full.finished}
    <button class="icon-btn" aria-label="Keep playing" onclick={() => app.go({ name: "game", id: record.id })}>
      ▶
    </button>
  {/if}
</header>

<div class="body">
  <section class="card-panel stack">
    <div class="spread">
      <h2>{full.score}/{full.maxScore}</h2>
      <span class="muted small">
        {record.players.length} players · {record.variantName} · {record.actions.length} actions
      </span>
    </div>
    <p class="muted small">
      {record.players.map((name, i) => (i === record.ourPlayerIndex ? `${name} (you)` : name)).join(", ")}
    </p>
    {#if !full.finished}
      <button class="btn" onclick={() => app.put(endGame(record))}>Mark the game finished</button>
    {/if}
  </section>

  {#if unknowns.length > 0}
    <section class="card-panel stack">
      <div class="spread">
        <h3>Cards still hidden</h3>
        <span class="muted small">{unknowns.length}</span>
      </div>
      <p class="muted small">
        Your own cards, as they were during the game. Fill them in once the hands go face up and the
        export becomes a complete replay — hanab.live needs that; scala-bot does not.
      </p>
      {#if resolvable.size > 0}
        <button
          class="btn btn-block"
          onclick={() => {
            const count = resolvable.size;
            app.put(revealMany(record, resolvable));
            app.toast(`Filled in ${count} card${count === 1 ? "" : "s"} with only one possibility.`);
          }}
        >
          Fill in the {resolvable.size} card{resolvable.size === 1 ? "" : "s"} with one possibility
        </button>
      {/if}
      <ul class="unknowns">
        {#each unknowns as card (card.order)}
          <li>
            <button class="unknown" onclick={() => (editing = card.order)}>
              <CardFace
                variant={full.variant}
                knowledge={full.cards[card.order]?.knowledge}
                possibilities={card.options}
                size="sm"
              />
              <span class="stack grow">
                <span class="small">{whose(card.holder, card.slot, card.location)}</span>
                <span class="muted small maybe">
                  {card.options.length === 0
                    ? "nothing fits the clues recorded"
                    : card.options.map((id) => identityName(full.variant, id)).join(" ")}
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="card-panel stack">
    <h3>Export</h3>
    {#each issues as issue (issue.message)}
      <p class="small" class:error={issue.severity === "error"} class:warn={issue.severity === "warning"}>
        {issue.message}
      </p>
    {/each}

    <div class="export-actions">
      <button class="btn" onclick={copy} disabled={blocking}>Copy JSON</button>
      <button class="btn" onclick={() => download(filename, json)} disabled={blocking}>Download</button>
      {#if canShareFiles()}
        <button class="btn" onclick={share} disabled={blocking}>Share</button>
      {/if}
    </div>

    <details>
      <summary class="small muted">How to use this file</summary>
      <div class="howto stack small">
        <p>
          <strong>hanab.live</strong> — lobby → <em>Watch Specific Replay</em> → <em>JSON</em>, and
          paste it in. Needs every card filled in.
        </p>
        <p><strong>scala-bot</strong>, from your own seat (index {record.ourPlayerIndex}):</p>
        <code>
          scala-cli . --main-class scala_bot.replay -- file={filename} index={record.ourPlayerIndex}
          convention=HGroup11
        </code>
        <p>
          Or a whole-game review:
          <code>--main-class scala_bot.analyze -- file={filename} convention=HGroup11</code>
        </p>
      </div>
    </details>

    <button class="btn btn-ghost small" onclick={() => (showJson = !showJson)}>
      {showJson ? "Hide" : "Show"} the JSON
    </button>
    {#if showJson}
      <pre class="json">{json}</pre>
    {/if}
  </section>

  <section class="card-panel stack">
    <div class="spread">
      <h3>Replay</h3>
      <span class="muted small">
        {through === undefined ? "final" : `after action ${through + 1}`} of {record.actions.length}
      </span>
    </div>
    <input
      type="range"
      class="scrub"
      min="0"
      max={record.actions.length}
      value={through === undefined ? record.actions.length : through + 1}
      oninput={(event) => {
        const value = Number(event.currentTarget.value);
        through = value >= record.actions.length ? undefined : value - 1;
      }}
    />
    <StatusStrip game={viewed} />
    {#each record.players as _player, playerIndex (playerIndex)}
      <HandRow
        game={viewed}
        {playerIndex}
        notes={record.notes}
        onselect={(order) => (editing = order)}
      />
    {/each}
    <p class="muted small">Tap any card to change what it was.</p>
  </section>

  <HistoryPanel
    game={full}
    selectedIndex={through}
    onselect={(index) => (through = index >= record.actions.length - 1 ? undefined : index)}
  />

  <button class="btn btn-danger btn-block" onclick={() => (confirmDelete = true)}>
    Delete this game
  </button>
</div>

{#if editing !== undefined}
  {@const order = editing}
  {@const card = full.cards[order]}
  {@const recorded = isKnown(card.identity)}
  <IdentityPicker
    variant={full.variant}
    title={recorded ? "What is this card really?" : whose(card.holder, card.slot, card.location)}
    subtitle={recorded
      ? `${whose(card.holder, card.slot, card.location)} — recorded as ${identityName(full.variant, card.identity)}. Changing it replays the rest of the game from here.`
      : "Only cards that fit the clues and the unseen copies are offered."}
    allowed={recorded ? undefined : possibleIdentities(full, order, counts)}
    counts={recorded ? countsForCorrection(full, order) : counts}
    onpick={(identity: Identity) => {
      app.put(revealCard(record, order, identity));
      editing = undefined;
      if (recorded) app.toast(`Changed to ${identityName(full.variant, identity)}.`);
    }}
    onclose={() => (editing = undefined)}
  />
{/if}

{#if confirmDelete}
  <Sheet title="Delete this game?" subtitle={record.title} onclose={() => (confirmDelete = false)}>
    <p class="muted small">Export it first if you want to keep the JSON — this cannot be undone.</p>
    <button
      class="btn btn-danger btn-block"
      onclick={() => {
        app.remove(record.id);
        app.toast("Game deleted.");
      }}>Delete</button
    >
  </Sheet>
{/if}

<style>
  .unknowns {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .unknown {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    border-radius: 10px;
    background: var(--panel-2);
    border: 1px solid var(--line);
  }

  .grow {
    flex: 1;
    min-width: 0;
    gap: 2px;
  }

  .maybe {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word;
  }

  .export-actions {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 8px;
  }

  .error {
    color: var(--danger);
  }

  .warn {
    color: var(--warn);
  }

  .howto {
    margin-top: 8px;
    gap: 6px;
  }

  code {
    display: block;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px;
    font-size: 0.78rem;
    word-break: break-all;
  }

  .json {
    margin: 0;
    max-height: 40vh;
    overflow: auto;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px;
    font-size: 0.7rem;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .scrub {
    padding: 0;
    min-height: 32px;
    background: none;
    border: none;
  }
</style>
