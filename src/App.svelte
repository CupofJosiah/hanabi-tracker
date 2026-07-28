<script lang="ts">
  import { app } from "./lib/state/app.svelte";
  import HomeView from "./lib/views/HomeView.svelte";
  import SetupView from "./lib/views/SetupView.svelte";
  import GameView from "./lib/views/GameView.svelte";
  import ReviewView from "./lib/views/ReviewView.svelte";

  app.load();

  let view = $derived(app.view);
  let game = $derived(app.current);

  // A game that vanished (deleted on another tab) should not leave a blank screen.
  $effect(() => {
    if ((view.name === "game" || view.name === "review") && !game) app.go({ name: "home" });
  });
</script>

<main class="screen">
  {#if view.name === "home"}
    <HomeView />
  {:else if view.name === "setup"}
    <SetupView />
  {:else if view.name === "game" && game}
    {#key game.id}
      <GameView record={game} />
    {/key}
  {:else if view.name === "review" && game}
    {#key game.id}
      <ReviewView record={game} />
    {/key}
  {/if}
</main>

<div class="toasts" aria-live="polite">
  {#each app.toasts as toast (toast.id)}
    <button class="toast" class:error={toast.tone === "error"} onclick={() => app.dismissToast(toast.id)}>
      {toast.text}
    </button>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 0;
    right: 0;
    /* Above everything, and out of the way of the action bar and sheet buttons. */
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
