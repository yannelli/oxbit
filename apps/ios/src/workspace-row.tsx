import { useRef, useState, type ReactNode } from "react";
import { Icon, translate as tr } from "@oxbit/ui";

const REVEAL = 88;
const TOLERANCE = 8;
const HOLD = 500;

interface Gesture {
  pointerId: number;
  x: number;
  y: number;
  base: number;
  swiping: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** A recent workspace: swipe left to reveal Remove; long-press or right-click opens the row menu. */
export function WorkspaceRow({
  name,
  icon,
  detail,
  current,
  disabled,
  revealed,
  onReveal,
  onOpen,
  onRemove,
  onMenu,
}: {
  name: string;
  icon: string;
  detail: ReactNode;
  current: boolean;
  disabled: boolean;
  revealed: boolean;
  onReveal: (revealed: boolean) => void;
  onOpen: () => void;
  onRemove: () => void;
  onMenu: () => void;
}) {
  const gesture = useRef<Gesture | undefined>(undefined);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<number>();
  const offset = drag ?? (revealed ? -REVEAL : 0);
  const end = () => {
    clearTimeout(gesture.current?.timer);
    gesture.current = undefined;
  };
  return (
    <div className="ios-workspace-row" data-revealed={revealed || drag !== undefined ? "true" : undefined}>
      <button className="ios-workspace-remove" aria-label={tr("Remove {name}", { name })} disabled={disabled}
        onFocus={() => onReveal(true)} onClick={onRemove}>
        <Icon name="trash" />
        {tr("Remove")}
      </button>
      <button
        className="ios-workspace"
        style={offset ? { transform: `translateX(${offset}px)` } : undefined}
        data-dragging={drag !== undefined ? "true" : undefined}
        disabled={disabled}
        aria-current={current ? "true" : undefined}
        onFocus={() => onReveal(false)}
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            event.preventDefault();
            return;
          }
          if (revealed) onReveal(false);
          else onOpen();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          end();
          onMenu();
        }}
        onPointerDown={(event) => {
          suppressClick.current = false;
          end();
          if (event.pointerType === "mouse" || !event.isPrimary) return;
          const started: Gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, base: offset, swiping: false };
          started.timer = setTimeout(() => {
            started.timer = undefined;
            gesture.current = undefined;
            suppressClick.current = true;
            onMenu();
          }, HOLD);
          gesture.current = started;
        }}
        onPointerMove={(event) => {
          const active = gesture.current;
          if (!active || event.pointerId !== active.pointerId) return;
          const dx = event.clientX - active.x;
          const dy = event.clientY - active.y;
          if (!active.swiping) {
            if (Math.abs(dy) > TOLERANCE && Math.abs(dy) >= Math.abs(dx)) return end();
            if (Math.abs(dx) <= TOLERANCE) return;
            clearTimeout(active.timer);
            active.swiping = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }
          setDrag(Math.max(-REVEAL, Math.min(0, active.base + dx)));
        }}
        onPointerUp={(event) => {
          const active = gesture.current;
          end();
          if (!active?.swiping || event.pointerId !== active.pointerId) return;
          suppressClick.current = true;
          onReveal((drag ?? active.base) < -REVEAL / 2);
          setDrag(undefined);
        }}
        onTouchEnd={(event) => {
          if (suppressClick.current) event.preventDefault();
        }}
        onPointerCancel={() => {
          end();
          setDrag(undefined);
        }}
      >
        <Icon name={icon} />
        <span>
          {name}
          <small>{detail}</small>
        </span>
      </button>
    </div>
  );
}
