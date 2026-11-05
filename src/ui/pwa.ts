/**
 * Service worker registration. A new version is downloaded in the background
 * but only activated when the user accepts the "Update available" banner
 * (never in the middle of an upload).
 */
import { signal } from "@preact/signals";
import { trustedScriptUrl } from "../security";

export const updateReady = signal(false);
let waiting: ServiceWorker | null = null;

export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  if (location.hostname === "localhost" && new URLSearchParams(location.search).has("nosw")) return;
  const url = trustedScriptUrl(new URL("./sw.js", location.href).href) as string;
  navigator.serviceWorker
    .register(url, { scope: "./", updateViaCache: "none" })
    .then((reg) => {
      const check = (w: ServiceWorker | null) => {
        if (w && navigator.serviceWorker.controller) {
          waiting = w;
          updateReady.value = true;
        }
      };
      check(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed") check(w);
        });
      });
      setInterval(() => void reg.update().catch(() => {}), 60 * 60_000);
    })
    .catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !waiting) return;
    reloading = true;
    location.reload();
  });
}

export function applyUpdate(): void {
  if (waiting) waiting.postMessage({ type: "skip-waiting" });
  else location.reload();
}
