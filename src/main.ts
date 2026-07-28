import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app");

const app = mount(App, { target });

// Registered relative to the document so the same build works from any subpath.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
      // Offline support is a bonus; a failed registration must not break the app.
    });
  });
}

export default app;
