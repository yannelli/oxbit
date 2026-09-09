import { useEffect, useState } from "react";
import { coarsePointer } from "./long-press";
import { KEY_BAR_ITEMS, KeyBarModel, type KeyBarAction } from "./key-bar-model";

const model = new KeyBarModel();

function editorTarget(): HTMLElement | undefined {
  const active = document.activeElement as HTMLElement | null;
  return active?.closest(".cm-editor") ? active : undefined;
}

function keyboardOpen() {
  const viewport = window.visualViewport;
  return !!viewport && window.innerHeight - viewport.height - viewport.offsetTop > 80;
}

function perform(action: KeyBarAction) {
  const target = editorTarget();
  if (!target) return;
  if (action.kind === "dismiss") {
    target.blur();
    return;
  }
  if (action.kind === "insert") {
    document.execCommand("insertText", false, action.text);
    return;
  }
  const init = model.init(action);
  const options = { ...init, bubbles: true, cancelable: true } as KeyboardEventInit;
  const handled = !target.dispatchEvent(new KeyboardEvent("keydown", options));
  target.dispatchEvent(new KeyboardEvent("keyup", options));
  if (!handled && action.key === "Tab" && !init.shiftKey) document.execCommand("insertText", false, "\t");
}

/** Extra keys above the software keyboard while a code editor has focus on a touch device. */
export function KeyBar() {
  const [visible, setVisible] = useState(false);
  const [sticky, setSticky] = useState(false);
  useEffect(() => {
    if (!coarsePointer()) return;
    const update = () => setVisible(!!editorTarget() && keyboardOpen());
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    update();
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);
  if (!visible) return null;
  return (
    <div className="key-bar" role="toolbar" aria-label="Editor keys">
      <button
        type="button"
        className={sticky ? "active" : ""}
        aria-pressed={sticky}
        title="Command modifier for the next key"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setSticky(model.toggleSticky())}
      >
        ⌘
      </button>
      {KEY_BAR_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          title={item.title}
          aria-label={item.title}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            perform(item.action);
            setSticky(model.sticky);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
