import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * Emits a small precaching service worker listing the built assets, so the app
 * keeps working at a table with no signal. Cache-first against a per-build cache
 * key, so a new deploy replaces the old cache wholesale.
 */
function serviceWorker(): Plugin {
  return {
    name: "hanabi-tracker-sw",
    apply: "build",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((name) => !name.endsWith(".map"))
        .map((name) => `./${name}`);
      // public/ files never reach the bundle, so name the ones worth having offline.
      const precache = [
        "./",
        "./index.html",
        "./manifest.webmanifest",
        "./icon.svg",
        ...assets,
      ];
      const version = Date.now().toString(36);

      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `const CACHE = "hanabi-tracker-${version}";
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

  // Navigations fall back to the cached shell so a refresh works offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("./index.html").then((cached) => cached || Response.error()),
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
    },
  };
}

export default defineConfig(({ mode }) => ({
  // Relative, so one build works at <user>.github.io/hanabi-tracker/, at a custom
  // domain, or straight off disk.
  base: "./",
  plugins: [svelte(), serviceWorker()],
  build: { target: "es2022" },
  // Component tests need Svelte's browser build; vitest runs in "test" mode.
  resolve: mode === "test" ? { conditions: ["browser"] } : undefined,
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
}));
