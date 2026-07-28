import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * The site ships two apps from one build:
 *
 *   /        the tracker — recording only, no bot, unchanged
 *   /bot/    the same tracker with the convention bot alongside it
 *
 * They share the game model and localStorage, so a game recorded in one shows
 * up in the other, but nothing on the bot side runs on the plain page.
 */
const PAGES = [
  { name: "main", html: "index.html", dir: "", shell: "./index.html" },
  { name: "bot", html: "bot/index.html", dir: "bot/", shell: "./index.html" },
];

/**
 * Emits a precaching service worker per page, so both apps keep working at a
 * table with no signal. Cache-first against a per-build cache key, so a new
 * deploy replaces the old cache wholesale.
 *
 * Each worker is emitted next to the page it serves, which scopes it to that
 * directory. The root worker's scope also covers `/bot/`, so it explicitly
 * declines navigations there — otherwise an offline visit to the bot page would
 * be answered with the plain app's shell.
 */
function serviceWorkers(): Plugin {
  return {
    name: "hanabi-tracker-sw",
    apply: "build",
    generateBundle(_options, bundle) {
      const version = Date.now().toString(36);
      const assets = Object.keys(bundle).filter((name) => !name.endsWith(".map"));

      for (const page of PAGES) {
        // Assets live at the build root; from a subdirectory that is one level up.
        const up = page.dir ? "../" : "./";
        const precache = [
          "./",
          page.shell,
          // Each page has its own manifest, next to it; icons are shared.
          "./manifest.webmanifest",
          `${up}icon.svg`,
          ...assets.map((name) => `${up}${name}`),
        ];

        const declineBot =
          page.dir === ""
            ? `
  // /bot/ has its own worker and its own shell; never answer for it.
  if (new URL(request.url).pathname.includes("/bot/")) return;
`
            : "";

        this.emitFile({
          type: "asset",
          fileName: `${page.dir}sw.js`,
          source: `const CACHE = "hanabi-tracker-${page.name}-${version}";
const PRECACHE = ${JSON.stringify(precache)};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;
${declineBot}
  // Navigations fall back to the cached shell so a refresh works offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(${JSON.stringify(page.shell)}).then((cached) => cached || Response.error()),
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
`,
        });
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  // Relative, so one build works at <user>.github.io/hanabi-tracker/, at a custom
  // domain, or straight off disk.
  base: "./",
  plugins: [svelte(), serviceWorkers()],
  build: {
    target: "es2022",
    // Relative to `root`; Vite resolves each HTML entry and its assets itself.
    rollupOptions: {
      input: Object.fromEntries(PAGES.map((page) => [page.name, page.html])),
    },
  },
  // Component tests need Svelte's browser build; vitest runs in "test" mode.
  resolve: mode === "test" ? { conditions: ["browser"] } : undefined,
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
}));
