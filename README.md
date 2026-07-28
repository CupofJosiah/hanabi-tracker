# Hanabi Tracker

A phone-sized scorekeeper for Hanabi played **in person**, with real cards, at a
table. You record every turn as it happens; it keeps the whole game state and
exports [hanab.live](https://hanab.live) JSON you can replay, upload, or feed to
an analysis bot afterwards.

Your own hand stays hidden, because that is the game. You never enter your own
cards until you play or discard one — and you can fill in whatever is left after
the hands go face up at the end.

**Live at <https://cupofjosiah.github.io/hanabi-tracker/>** · installable from
the browser's "Add to home screen", and it works offline once loaded.

## What it does

- **Records a whole game** — every play, discard and clue, with automatic turn
  order, clue tokens, strikes, play stacks, discard counts, pace and the
  end-of-deck final round.
- **Keeps your hand a mystery** — cards you hold are unknown until revealed. The
  app shows what you legitimately know: which slots each clue touched, and the
  identities still consistent with that plus every card you can see.
- **Exports hanab.live JSON** that both hanab.live and
  [scala-bot](https://github.com/WillFlame14/scala-bot) accept, so you can get a
  replay or a convention-aware review of a game played on cardboard.
- **Survives refreshes** — every tap writes straight to the device, and
  reopening the app drops you back on the table you were recording.
- **491 variants**, named exactly as hanab.live names them.

## Recording a game

1. **New game** — list everyone in turn order starting with whoever goes first,
   tap your own seat, pick the variant.
2. **Deal** — enter everyone else's starting hand. Slot 1 is the end of the hand
   that new cards go into; keep drawing to that same end all game.
3. **Each turn** — tap `Play`, `Discard` or `Clue` for whoever is acting:
   - *Play / discard*: tap the card. If it was one of yours, name it now (it is
     face up, so this is not a spoiler) — you are only offered cards that are
     actually still possible. Then name the card the player drew, unless it was
     you who drew it.
   - *Clue*: pick the seat and the colour or rank. For other players the touched
     cards are worked out from the deck; when the clue is aimed at **you**, tap
     the slots they pointed at.
4. **Undo** in the header removes the last action, including the card drawn with it.
5. **Review & export** when the game ends.

A misplay is just a play — record it as one, exactly as hanab.live does; the
strike follows from the card.

## Getting the game out

**Review & export** gives you `Copy JSON`, `Download`, and the OS share sheet on
a phone.

- **hanab.live**: lobby → *Watch Specific Replay* → *JSON*, and paste. This needs
  a complete deck, so fill in any cards still marked hidden first — the review
  screen lists them, offers only the identities that fit, and can settle the ones
  with a single possibility in one tap.
- **scala-bot**, from your own seat, with your own cards hidden the way they were
  during the game:

  ```
  scala-cli . --main-class scala_bot.replay -- file=game.json index=<your seat> convention=HGroup11
  ```

  or for a whole-game review:

  ```
  scala-cli . --main-class scala_bot.analyze -- file=game.json convention=HGroup11
  ```

  The review screen prints both with your seat index already filled in. Unlike
  hanab.live, the bot does not mind unidentified cards — they are hidden from
  your seat anyway.

You can also import: paste a hanab.live export (or a backup of this app) from the
home screen's `⋯` menu to review a game here.

## Where your games live

In this browser's `localStorage`, one key per game, and nowhere else. There is no
account and no server. Clearing site data deletes them — the `⋯` menu has
**Back up all games**, which writes a single JSON file you can re-import.

## The export format

hanab.live's JSON is compact and a little unobvious, so the model matches it
directly rather than translating at the end:

```json
{
  "id": 0,
  "players": ["josiah", "claire", "matt", "tyler"],
  "deck": [{ "suitIndex": 4, "rank": 4 }, "..."],
  "actions": [{ "type": 3, "target": 2, "value": 1 }, "..."],
  "notes": [[], [], [], []],
  "options": { "variant": "No Variant" }
}
```

- `deck` is in **deal order**: seat 0's whole hand, then seat 1's, and so on,
  then the draw pile. Within a seat's block the *last* card is slot 1, because
  every draw becomes slot 1.
- A card's index in `deck` is its **order**, and that is what a play or discard
  points at.
- `actions[].type` is `0` play, `1` discard, `2` colour clue, `3` rank clue,
  `4` end game. For clues, `target` is the seat and `value` is the rank, or the
  index of the colour among the variant's *colourable* suits (Rainbow and White
  have no colour of their own, so they are skipped).
- An unidentified card is `{"suitIndex": -1, "rank": -1}`.
- Draws are not actions: they are implied by the deck growing, one per play or
  discard while cards remain.

`src/lib/hanabi/hanabLive.ts` is the whole of the format handling, and the tests
round-trip a real four-player game byte for byte.

## Development

```bash
npm install
npm run dev        # local dev server
npm test           # engine, export and end-to-end UI tests
npm run check      # svelte-check
npm run build      # static site in dist/
```

Pushing to `main` builds and publishes to GitHub Pages (Settings → Pages →
Source: *GitHub Actions*). The build uses relative asset paths, so it works at a
project path, at a custom domain, or straight off disk.

`npm run gen:variants` regenerates `src/lib/hanabi/variantData.ts` from
hanab.live's upstream `variants.json`. The generated file is committed, so the
app never touches the network.

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

## Credits

Forked from [jparkhouse/hanabi-tracker](https://github.com/jparkhouse/hanabi-tracker),
which tracked a single player's hand; this rewrite tracks the whole table.
Variant and suit data come from
[Hanabi-Live/hanabi-live](https://github.com/Hanabi-Live/hanabi-live).
