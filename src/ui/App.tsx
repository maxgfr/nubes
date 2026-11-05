import { useEffect } from "preact/hooks";
import { link, resume, session } from "../state";
import { Explorer } from "./Explorer";
import { PickRepo, SignIn } from "./Onboarding";
import { Toasts } from "./Panels";
import { applyUpdate, updateReady } from "./pwa";

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
