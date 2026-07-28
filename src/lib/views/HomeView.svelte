<script lang="ts">
  import { app } from "../state/app.svelte";
  import { exportBackup, parseBackup } from "../state/storage";
  import { stateOf } from "../hanabi/engine";
  import { fromHanabLive, ImportError } from "../hanabi/hanabLive";
  import type { GameRecord } from "../hanabi/types";
  import { download } from "../ui/share";
  import Sheet from "../ui/Sheet.svelte";

  let menuOpen = $state(false);
  let importOpen = $state(false);
  let importText = $state("");
  let confirmDelete = $state<GameRecord | undefined>(undefined);

  function summarise(record: GameRecord) {
    try {
      const state = stateOf(record);
      return {
        score: state.score,
        max: state.maxScore,
        turn: state.turn,
        finished: state.finished || record.finishedAt !== undefined,
        strikes: state.strikes,
      };
    } catch {
      return undefined;
    }
  }

  function open(record: GameRecord) {
    const summary = summarise(record);
    app.go({ name: summary?.finished ? "review" : "game", id: record.id });
  }

  function when(at: number) {
    const date = new Date(at);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay
      ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function backup() {
    download(`hanabi-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`, exportBackup(app.games));
    menuOpen = false;
    app.toast(`Backed up ${app.games.length} game${app.games.length === 1 ? "" : "s"}.`);
  }

  async function onFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    importText = await file.text();
    input.value = "";
    runImport();
  }

  function runImport() {
    const text = importText.trim();
    if (!text) return;

    // One file may be either a whole-history backup or a single hanab.live game.
    try {
      const restored = parseBackup(text);
      for (const record of restored) app.put(record);
      app.toast(`Restored ${restored.length} game${restored.length === 1 ? "" : "s"}.`);
      importOpen = false;
      importText = "";
      return;
    } catch {
      // Fall through and try it as a hanab.live export.
    }

    try {
      const record = fromHanabLive(JSON.parse(text));
      app.put(record);
      app.toast(`Imported ${record.players.join(", ")}.`);
      importOpen = false;
      importText = "";
      app.go({ name: "review", id: record.id });
    } catch (error) {
      app.toast(
        error instanceof ImportError || error instanceof SyntaxError
          ? `Could not read that: ${error.message}`
          : "Could not read that file.",
        "error",
      );
    }
  }
</script>

<header class="topbar">
  <h1>Hanabi Tracker</h1>
  <button class="icon-btn" aria-label="More" onclick={() => (menuOpen = true)}>⋯</button>
</header>

<div class="body">
  <button class="btn btn-primary btn-block" onclick={() => app.go({ name: "setup" })}>
    New game
  </button>

  {#if app.games.length === 0}
    <div class="card-panel empty stack">
      <p>No games yet.</p>
      <p class="muted small">
        Start a game and record every turn as it happens. Your own hand stays hidden — everything is
        saved on this device as you go, and exports as hanab.live JSON when you are done.
      </p>
    </div>
  {:else}
    <h3>History</h3>
    <ul class="games">
      {#each app.games as record (record.id)}
        {@const summary = summarise(record)}
        <li>
          <button class="game" onclick={() => open(record)}>
            <div class="spread">
              <span class="title">{record.title}</span>
              <span class="pill">
                {#if summary}
                  {summary.finished ? `${summary.score}/${summary.max}` : `turn ${summary.turn}`}
                {:else}
                  damaged
                {/if}
              </span>
            </div>
            <div class="muted small meta">
              {record.players.join(", ")} · {record.variantName} · {when(record.updatedAt)}
              {#if summary && !summary.finished}· in progress{/if}
            </div>
          </button>
          <button
            class="icon-btn"
            aria-label="Delete {record.title}"
            onclick={() => (confirmDelete = record)}>🗑</button
          >
        </li>
      {/each}
    </ul>
  {/if}
</div>

{#if menuOpen}
  <Sheet title="Library" onclose={() => (menuOpen = false)}>
    <button class="btn btn-block" onclick={() => { menuOpen = false; importOpen = true; }}>
      Import a game or backup
    </button>
    <button class="btn btn-block" onclick={backup} disabled={app.games.length === 0}>
      Back up all games
    </button>
    <p class="muted small">
      Backups and game history live only on this device. Back up before clearing your browser data.
    </p>
  </Sheet>
{/if}

{#if importOpen}
  <Sheet
    title="Import"
    subtitle="A hanab.live export, or a backup from this app."
    onclose={() => (importOpen = false)}
  >
    <label class="btn btn-block file">
      Choose a file
      <input type="file" accept="application/json,.json,.txt" onchange={onFile} />
    </label>
    <textarea rows="6" placeholder="…or paste JSON here" bind:value={importText}></textarea>
    <button class="btn btn-primary btn-block" onclick={runImport} disabled={!importText.trim()}>
      Import
    </button>
  </Sheet>
{/if}

{#if confirmDelete}
  {@const target = confirmDelete}
  <Sheet title="Delete this game?" subtitle={target.title} onclose={() => (confirmDelete = undefined)}>
    <p class="muted small">This cannot be undone. Export it first if you still want the JSON.</p>
    <button
      class="btn btn-danger btn-block"
      onclick={() => {
        app.remove(target.id);
        confirmDelete = undefined;
        app.toast("Game deleted.");
      }}
    >
      Delete
    </button>
  </Sheet>
{/if}

<style>
  .empty {
    text-align: center;
    gap: 6px;
  }

  .games {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .games li {
    display: flex;
    align-items: stretch;
    gap: 4px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding-right: 4px;
  }

  .game {
    flex: 1;
    min-width: 0;
    text-align: left;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .title {
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file {
    position: relative;
    overflow: hidden;
  }

  .file input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
</style>
