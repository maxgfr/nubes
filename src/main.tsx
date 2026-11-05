import { render } from "preact";
import { frameBust } from "./security";
import { App } from "./ui/App";
import { registerServiceWorker } from "./ui/pwa";

if (!frameBust()) {
  const root = document.getElementById("app");
  if (root) render(<App />, root);
  registerServiceWorker();
}
