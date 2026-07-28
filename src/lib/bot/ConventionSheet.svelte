<script lang="ts">
  /**
   * Convention settings.
   *
   * The level numbers are H-Group's, gated exactly as scala-bot gates them, so
   * picking a level here means what it means when you hand the export to the
   * analyser. Techniques the level asks for that this app does not reason about
   * yet are listed as such rather than quietly ignored.
   */
  import Sheet from "../ui/Sheet.svelte";
  import { bot } from "./bot.svelte";
  import {
    FULLY_IMPLEMENTED_THROUGH,
    MAX_LEVEL,
    TECHNIQUES,
    missingTechniques,
    type Technique,
  } from "./conventions";
  import { countOverrides } from "./overrides";

  interface Props {
    onclose: () => void;
    /** The open game, if any, so its corrections can be cleared from here. */
    gameId?: string;
  }

  let { onclose, gameId }: Props = $props();

  let settings = $derived(bot.settings);
  let missing = $derived(missingTechniques(settings));
  let corrections = $derived(countOverrides(bot.overrides));

  function state(technique: Technique): "on" | "off" | "missing" {
    if (settings.level < technique.level) return "off";
    return technique.implemented ? "on" : "missing";
  }
</script>

<Sheet title="Conventions" subtitle="What the bot assumes your table plays" {onclose}>
  <label class="stack">
    <span class="small muted">Convention</span>
    <select
      value={settings.family}
      onchange={(event) => bot.update({ family: event.currentTarget.value as "hgroup" })}
    >
      <option value="hgroup">H-Group</option>
    </select>
    <span class="small muted">
      Reference Sieve and Reactor are not implemented here. scala-bot plays both, so use it for
      those.
    </span>
  </label>

  <label class="stack">
    <span class="small muted">Level — H-Group {settings.level}</span>
    <input
      type="range"
      min="1"
      max={MAX_LEVEL}
      value={settings.level}
      oninput={(event) => bot.update({ level: Number(event.currentTarget.value) })}
    />
  </label>

  {#if missing.length > 0}
    <p class="small warn">
      Levels 1&ndash;{FULLY_IMPLEMENTED_THROUGH} are fully reasoned about. At level {settings.level}
      the bot will not spot: {missing.map((t) => t.name.toLowerCase()).join(", ")}. Its notes and
      suggestions stay sound for everything below that, but it will read a clue as
      <em>unclear</em> rather than invent a meaning it does not know.
    </p>
  {/if}

  <ul class="techniques">
    {#each TECHNIQUES as technique (technique.name)}
      {@const status = state(technique)}
      <li class={status}>
        <span class="mark" aria-hidden="true">
          {status === "on" ? "✓" : status === "missing" ? "!" : "·"}
        </span>
        <span class="body">
          <span class="name">
            {technique.name}
            <span class="lvl">L{technique.level}</span>
            {#if status === "missing"}<span class="lvl warn">not yet</span>{/if}
          </span>
          <span class="small muted">{technique.blurb}</span>
        </span>
      </li>
    {/each}
  </ul>

  <label class="row toggle">
    <input
      type="checkbox"
      checked={settings.goodTouch}
      onchange={(event) => bot.update({ goodTouch: event.currentTarget.checked })}
    />
    <span class="stack">
      <span>Good Touch Principle</span>
      <span class="small muted">Assume a clued card is never trash. Turn off for conventions that do not promise it.</span>
    </span>
  </label>

  <label class="row toggle">
    <input
      type="checkbox"
      checked={settings.noteEveryCard}
      onchange={(event) => bot.update({ noteEveryCard: event.currentTarget.checked })}
    />
    <span class="stack">
      <span>Note untouched cards too</span>
      <span class="small muted">Off by default, matching scala-bot, which only writes on cards carrying information.</span>
    </span>
  </label>

  {#if gameId}
    <div class="stack corrections">
      <span class="small muted">
        {corrections === 0
          ? "You have not corrected the bot in this game."
          : `You have corrected the bot on ${corrections} card${corrections === 1 ? "" : "s"} in this game.`}
      </span>
      <button
        class="btn btn-block"
        disabled={corrections === 0}
        onclick={() => bot.clearCorrections(gameId)}
      >
        Clear this game's corrections
      </button>
      <span class="small muted">
        Tap any card and use <em>The bot has this wrong</em> to correct one. Corrections stay on
        this device and never reach the export.
      </span>
    </div>
  {/if}
</Sheet>

<style>
  .techniques {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .techniques li {
    display: flex;
    gap: 8px;
    align-items: flex-start;
  }

  .techniques li.off {
    opacity: 0.42;
  }

  .mark {
    width: 1.1em;
    text-align: center;
    font-weight: 700;
    color: var(--muted);
  }

  li.on .mark {
    color: var(--good);
  }

  li.missing .mark {
    color: var(--warn);
  }

  .body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .name {
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .lvl {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.6rem;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 5px;
  }

  .lvl.warn {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 55%, transparent);
  }

  .warn {
    color: var(--warn);
  }

  .toggle {
    align-items: flex-start;
    gap: 10px;
  }

  .toggle input {
    margin-top: 3px;
    width: auto;
  }

  .corrections {
    gap: 6px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }
</style>
