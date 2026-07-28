import "./app.css";
import { mount } from "svelte";
import BotApp from "./BotApp.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app");

const app = mount(BotApp, { target });

// Relative, so this registers `/bot/sw.js` and is scoped to `/bot/` only —
// the plain app at the root keeps its own worker and its own cache.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
      // Offline support is a bonus; a failed registration must not break the app.
    });
  });
}

export default app;
