import { useEffect, useId, useState, type ReactNode } from "react";
import { translate as tr } from "@oxbit/ui";
import { isColor, pickColor, pickerValue } from "./draft.js";

/** A text field that keeps the typed text while it is invalid and reports only valid values. */
function useText(value: string) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return [text, setText] as const;
}

export function Field({ label, hint, overridden, onReset, children }: {
  label: string;
  hint?: string;
  overridden?: boolean;
  onReset?: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`theme-editor-field${overridden ? " modified" : ""}`}>
      <div className="theme-editor-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="theme-editor-control">
        {children}
        {overridden && onReset && (
          <button className="text-button" aria-label={tr("Reset {name}", { name: label })} onClick={onReset}>
            {tr("Reset")}
          </button>
        )}
      </div>
    </div>
  );
}

export function ColorInput({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useText(value);
  return (
    <span className="theme-editor-color">
      <span className="theme-editor-swatch" style={{ background: isColor(value) ? value : "transparent" }}>
        <input
          type="color"
          aria-label={tr("{name} picker", { name: label })}
          value={pickerValue(value)}
          onChange={(event) => onChange(pickColor(value, event.target.value))}
        />
      </span>
      <input
        aria-label={label}
        spellCheck={false}
        value={text}
        aria-invalid={!isColor(text.trim())}
        onChange={(event) => {
          setText(event.target.value);
          const next = event.target.value.trim();
          if (isColor(next)) onChange(next.toLowerCase());
        }}
        onBlur={() => setText(value)}
      />
    </span>
  );
}

export function ColorField({ label, hint, value, overridden, onChange }: {
  label: string;
  hint?: string;
  value: string;
  overridden: boolean;
  onChange: (value?: string) => void;
}) {
  return (
    <Field label={label} hint={hint} overridden={overridden} onReset={() => onChange(undefined)}>
      <ColorInput label={label} value={value} onChange={onChange} />
    </Field>
  );
}

export function NumberInput({ label, value, min, max, step = 1, integer = false, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useText(String(value));
  const valid = (raw: string) => {
    const number = Number(raw);
    return raw.trim() !== "" && Number.isFinite(number) && number >= min && number <= max && (!integer || Number.isInteger(number));
  };
  return (
    <input
      type="number"
      aria-label={label}
      className="theme-editor-number"
      min={min}
      max={max}
      step={step}
      value={text}
      aria-invalid={!valid(text)}
      onChange={(event) => {
        setText(event.target.value);
        if (valid(event.target.value)) onChange(Number(event.target.value));
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

const FAMILY = /^[a-zA-Z0-9 _.-]+$/;
export const parseFamily = (text: string) => {
  const families = text.split(",").map((item) => item.trim()).filter(Boolean);
  return families.length && families.length <= 12 && families.every((item) => FAMILY.test(item) && item.length <= 200)
    ? families
    : undefined;
};

export function FamilyInput({ label, value, onChange }: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [text, setText] = useText(value.join(", "));
  return (
    <input
      aria-label={label}
      className="theme-editor-family"
      spellCheck={false}
      value={text}
      aria-invalid={!parseFamily(text)}
      onChange={(event) => {
        setText(event.target.value);
        const families = parseFamily(event.target.value);
        if (families) onChange(families);
      }}
      onBlur={() => setText(value.join(", "))}
    />
  );
}

export function Check({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <span className="theme-editor-check">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <label htmlFor={id}>{label}</label>
    </span>
  );
}

export function Choice<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export const weights = [100, 200, 300, 400, 500, 600, 700, 800, 900].map((weight) => ({
  value: String(weight),
  label: String(weight),
}));
