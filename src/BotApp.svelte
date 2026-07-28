<script lang="ts">
  /**
   * The bot build's shell, served at `/bot/`.
   *
   * Identical to the plain tracker except on the game screen, where it hangs
   * the bot's notes and suggestions off the extension points `GameView`
   * exposes. Both apps read the same games from the same device storage.
   */
  import { app } from "./lib/state/app.svelte";
  import HomeView from "./lib/views/HomeView.svelte";
  import SetupView from "./lib/views/SetupView.svelte";
  import GameView from "./lib/views/GameView.svelte";
  import ReviewView from "./lib/views/ReviewView.svelte";
  import BotCardNote from "./lib/bot/BotCardNote.svelte";
  import ConventionSheet from "./lib/bot/ConventionSheet.svelte";
  import SuggestionPanel from "./lib/bot/SuggestionPanel.svelte";
  import { analyseGame, bot, notesFor } from "./lib/bot/bot.svelte";
  import { conventionName } from "./lib/bot/conventions";

  app.load();

  let view = $derived(app.view);
  let game = $derived(app.current);
  let settingsOpen = $state(false);

  // Notes and suggestions are derived from deck + actions, so undo, a corrected
  // card and a scrubbed history all carry them along without any bookkeeping.
  let analysis = $derived(game ? analyseGame(game, bot.settings) : undefined);
  let botNotes = $derived(analysis ? notesFor(analysis) : undefined);

  $effect(() => {
    if ((view.name === "game" || view.name === "review") && !game) app.go({ name: "home" });
  });
</script>

<div class="botbar">
  <span class="brand">Hanabi Tracker <span class="tag">bot</span></span>
  <button class="conv" onclick={() => (settingsOpen = true)}>
    {conventionName(bot.settings)}
  </button>
  <a class="plain" href="../">plain app ›</a>
</div>

<main class="screen">
  {#if view.name === "home"}
    <HomeView />
  {:else if view.name === "setup"}
    <SetupView />
  {:else if view.name === "game" && game && analysis}
    {#key game.id}
      <GameView record={game} {botNotes}>
        {#snippet aside()}
          <SuggestionPanel record={game} {analysis} />
        {/snippet}
        {#snippet cardAside(order)}
          <BotCardNote {analysis} {order} />
        {/snippet}
      </GameView>
    {/key}
  {:else if view.name === "review" && game}
    {#key game.id}
      <ReviewView record={game} />
    {/key}
  {/if}
</main>

{#if settingsOpen}
  <ConventionSheet onclose={() => (settingsOpen = false)} />
{/if}

<div class="toasts" aria-live="polite">
  {#each app.toasts as toast (toast.id)}
    <button class="toast" class:error={toast.tone === "error"} onclick={() => app.dismissToast(toast.id)}>
      {toast.text}
    </button>
  {/each}
</div>

<style>
  .botbar {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 760px;
    margin: 0 auto;
    padding: calc(6px + env(safe-area-inset-top)) 12px 0;
    font-size: 0.78rem;
  }

  .brand {
    color: var(--muted);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
    border-radius: 999px;
    padding: 1px 6px;
  }

  .conv {
    background: none;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
    padding: 3px 10px;
    cursor: pointer;
  }

  .plain {
    color: var(--muted);
    text-decoration: none;
    white-space: nowrap;
  }

  .toasts {
    position: fixed;
    left: 0;
    right: 0;
    top: calc(8px + env(safe-area-inset-top));
    z-index: 100;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    max-width: 34rem;
    width: 100%;
    text-align: left;
    background: var(--panel-3);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 14px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    font-size: 0.9rem;
  }

  .toast.error {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
