/**
 * A modal dialog on the native <dialog> element: showModal() makes the rest
 * of the page inert, traps focus and closes on Escape.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { IconClose } from "./icons";

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  wide?: boolean;
  actions?: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const first = d.querySelector<HTMLElement>("[autofocus], input");
    first?.focus();
    const cancel = (e: Event) => {
      e.preventDefault();
      onClose.current();
    };
    d.addEventListener("cancel", cancel);
    return () => {
      d.removeEventListener("cancel", cancel);
      if (d.open) d.close();
    };
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click; Escape closes the dialog natively
    <dialog
      ref={ref}
      class={`modal${props.wide ? " modal-wide" : ""}`}
      aria-label={props.title}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> itself.
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="modal-inner">
        <header class="modal-head">
          <h2>{props.title}</h2>
          {props.actions}
          <button type="button" class="icon-btn modal-x" onClick={props.onClose} aria-label="Close">
            <IconClose />
          </button>
        </header>
        <div class="modal-body">{props.children}</div>
      </div>
    </dialog>
  );
}
