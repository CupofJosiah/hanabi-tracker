<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    subtitle?: string;
    onclose?: () => void;
    children: Snippet;
    footer?: Snippet;
  }

  let { title, subtitle, onclose, children, footer }: Props = $props();

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onclose?.();
  }
</script>

<svelte:window on:keydown={onkeydown} />

<div class="backdrop">
  <button class="dismiss" aria-label="Close" onclick={() => onclose?.()}></button>
  <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
    <div class="grabber"></div>
    <header>
      <div>
        <h2>{title}</h2>
        {#if subtitle}<p class="muted small">{subtitle}</p>{/if}
      </div>
      {#if onclose}
        <button class="icon-btn" onclick={onclose} aria-label="Close">✕</button>
      {/if}
    </header>
    <div class="content">
      {@render children()}
    </div>
    {#if footer}
      <div class="sheet-footer">{@render footer()}</div>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    background: rgba(0, 0, 0, 0.55);
  }

  .dismiss {
    flex: 1;
    min-height: 40px;
  }

  .sheet {
    background: var(--panel);
    border-top: 1px solid var(--line);
    border-radius: 18px 18px 0 0;
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.5);
    animation: rise 0.16s ease-out;
  }

  @keyframes rise {
    from {
      transform: translateY(14px);
      opacity: 0.6;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet {
      animation: none;
    }
  }

  .grabber {
    width: 38px;
    height: 4px;
    border-radius: 999px;
    background: var(--line);
    margin: 8px auto 0;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px 4px;
  }

  .content {
    overflow-y: auto;
    padding: 8px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .sheet-footer {
    display: flex;
    gap: 8px;
    padding: 10px 12px calc(12px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--line);
  }
</style>
