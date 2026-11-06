import { signal } from "@preact/signals";
import type { FunctionComponent } from "preact";
import { useEffect } from "preact/hooks";
import { link, resume, session } from "../state";
import { Explorer } from "./Explorer";
import { SignIn } from "./Onboarding";
import { Toasts } from "./Panels";
import { applyUpdate, updateReady } from "./pwa";

/** The folder picker, shown once per device: loaded when needed, not with the first screen. */
const picker = signal<FunctionComponent | null>(null);

function PickRepo() {
  useEffect(() => {
    if (!picker.value) void import("./PickRepo").then((m) => (picker.value = m.PickRepo));
  }, []);
  const C = picker.value;
  return C ? <C /> : null;
}

export function App() {
  useEffect(() => {
    void resume();
  }, []);
  return (
    <>
      {!session.value ? <SignIn /> : !link.value ? <PickRepo /> : <Explorer />}
      <Toasts />
      {updateReady.value && (
        <button type="button" class="update-banner" onClick={applyUpdate}>
          A new version of nubes is ready: reload
        </button>
      )}
    </>
  );
}
