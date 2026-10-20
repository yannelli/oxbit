import { useEffect, useState } from "react";
import { builtinBase, formatDiagnostics, parsePack, type ResolvedTheme, type Shadow } from "@oxbit/themes";
import { translate as tr } from "@oxbit/ui";
import {
  colorGroups,
  currentTheme,
  setColor,
  setShadow,
  setSyntax,
  setTypography,
  syntaxRoles,
  typographyRoles,
  updateTheme,
  type Draft,
} from "./draft.js";
import { Check, Choice, ColorField, ColorInput, FamilyInput, Field, NumberInput, weights } from "./fields.js";

export interface PanelProps {
  draft: Draft;
  resolved: ResolvedTheme;
  onDraft: (draft: Draft) => void;
}

export function GeneralPanel({ draft, onDraft }: Omit<PanelProps, "resolved">) {
  const theme = currentTheme(draft);
  const others = draft.pack.themes.filter((item) => item.id !== theme.id);
  const pack = (change: (pack: Draft["pack"]) => void) => {
    const next = structuredClone(draft.pack);
    change(next);
    onDraft({ ...draft, pack: next });
  };
  return (
    <div className="theme-editor-section">
      <h2>{tr("Pack")}</h2>
      <Field label={tr("Pack name")}>
        <input aria-label={tr("Pack name")} value={draft.pack.name} onChange={(event) => pack((next) => { next.name = event.target.value; })} />
      </Field>
      <Field label={tr("Pack ID")} hint={draft.installed ? tr("Save as New Pack to change the ID.") : tr("Lowercase letters, digits, dots, dashes and underscores.")}>
        <input
          aria-label={tr("Pack ID")}
          value={draft.pack.id}
          disabled={draft.installed}
          spellCheck={false}
          onChange={(event) => pack((next) => { next.id = event.target.value.trim(); })}
        />
      </Field>
      <Field label={tr("Version")}>
        <input aria-label={tr("Version")} value={draft.pack.version} onChange={(event) => pack((next) => { next.version = event.target.value.trim(); })} />
      </Field>
      <Field label={tr("Attribution and license")}>
        <textarea
          aria-label={tr("Attribution and license")}
          rows={3}
          value={draft.pack.attribution ?? ""}
          onChange={(event) => pack((next) => {
            if (event.target.value) next.attribution = event.target.value;
            else delete next.attribution;
          })}
        />
      </Field>
      <h2>{tr("Theme")}</h2>
      <Field label={tr("Theme name")}>
        <input aria-label={tr("Theme name")} value={theme.name} onChange={(event) => onDraft(updateTheme(draft, (item) => { item.name = event.target.value; }))} />
      </Field>
      <Field label={tr("Mode")} hint={tr("Omitted colors come from the built-in theme of this mode.")}>
        <Choice
          label={tr("Mode")}
          value={theme.mode}
          options={[{ value: "dark", label: tr("Dark") }, { value: "light", label: tr("Light") }]}
          onChange={(mode) => onDraft(updateTheme(draft, (item) => {
            item.mode = mode;
            if (!item.base || item.base.startsWith("builtin:")) delete item.base;
          }))}
        />
      </Field>
      <Field label={tr("Base theme")}>
        <Choice
          label={tr("Base theme")}
          value={theme.base && !theme.base.startsWith("builtin:") ? theme.base : ""}
          options={[
            { value: "", label: builtinBase(theme.mode).name },
            ...others.filter((item) => item.mode === theme.mode).map((item) => ({ value: item.id, label: item.name })),
          ]}
          onChange={(base) => onDraft(updateTheme(draft, (item) => {
            if (base) item.base = base;
            else delete item.base;
          }))}
        />
      </Field>
      <Field label={tr("Light/dark pair")} hint={tr("Toggle Light/Dark Theme switches to this theme.")}>
        <Choice
          label={tr("Light/dark pair")}
          value={theme.pairedTheme ?? ""}
          options={[{ value: "", label: tr("None") }, ...others.map((item) => ({ value: item.id, label: item.name }))]}
          onChange={(paired) => onDraft(updateTheme(draft, (item) => {
            if (paired) item.pairedTheme = paired;
            else delete item.pairedTheme;
          }))}
        />
      </Field>
      <Field label={tr("High contrast")}>
        <Check
          label={tr("Mark as a high contrast theme")}
          checked={!!theme.highContrast}
          onChange={(checked) => onDraft(updateTheme(draft, (item) => {
            if (checked) item.highContrast = true;
            else delete item.highContrast;
          }))}
        />
      </Field>
    </div>
  );
}

export function ColorsPanel({ draft, resolved, onDraft, query }: PanelProps & { query: string }) {
  const overrides = currentTheme(draft).colors ?? {};
  const needle = query.trim().toLowerCase();
  const groups = colorGroups()
    .map(([group, entries]) => [group, entries.filter((entry) => !needle || `${entry.key} ${entry.description}`.toLowerCase().includes(needle))] as const)
    .filter(([, entries]) => entries.length);
  if (!groups.length) return <p className="muted">{tr("No colors match.")}</p>;
  return (
    <div className="theme-editor-section">
      {groups.map(([group, entries]) => (
        <section key={group} aria-label={group}>
          <h2>{group}</h2>
          {entries.map((entry) => (
            <ColorField
              key={entry.key}
              label={entry.key}
              hint={entry.derived && !(entry.key in overrides) ? tr("{description}, follows {source}", { description: entry.description, source: entry.derived.replace("syntax:", "") }) : entry.description}
              value={resolved.colors[entry.key]}
              overridden={entry.key in overrides}
              onChange={(value) => onDraft(setColor(draft, entry.key, value))}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

export function SyntaxPanel({ draft, resolved, onDraft }: PanelProps) {
  const overrides = currentTheme(draft).syntax ?? {};
  return (
    <div className="theme-editor-section">
      {syntaxRoles.map((role) => {
        const style = resolved.syntax[role];
        const own = overrides[role] ?? {};
        return (
          <section key={role} aria-label={role} className="theme-editor-role">
            <h2>
              <span style={{ color: style.foreground, background: style.background, fontWeight: style.weight, fontStyle: style.italic ? "italic" : "normal", textDecoration: style.underline ? "underline" : "none" }}>
                {role}
              </span>
            </h2>
            <ColorField label={`${role} foreground`} value={style.foreground} overridden={"foreground" in own} onChange={(value) => onDraft(setSyntax(draft, role, "foreground", value))} />
            <ColorField label={`${role} background`} value={style.background} overridden={"background" in own} onChange={(value) => onDraft(setSyntax(draft, role, "background", value))} />
            <Field label={tr("Weight")} overridden={"weight" in own} onReset={() => onDraft(setSyntax(draft, role, "weight"))}>
              <Choice label={`${role} weight`} value={String(style.weight)} options={weights} onChange={(value) => onDraft(setSyntax(draft, role, "weight", Number(value)))} />
            </Field>
            <Field label={tr("Style")} overridden={"italic" in own || "underline" in own} onReset={() => onDraft(setSyntax(setSyntax(draft, role, "italic"), role, "underline"))}>
              <Check label={tr("Italic")} checked={style.italic} onChange={(value) => onDraft(setSyntax(draft, role, "italic", value))} />
              <Check label={tr("Underline")} checked={style.underline} onChange={(value) => onDraft(setSyntax(draft, role, "underline", value))} />
            </Field>
          </section>
        );
      })}
    </div>
  );
}

export function TypographyPanel({ draft, resolved, onDraft }: PanelProps) {
  const overrides = currentTheme(draft).typography ?? {};
  return (
    <div className="theme-editor-section">
      {typographyRoles.map((role) => {
        const font = resolved.typography[role];
        const own = overrides[role] ?? {};
        const set = <K extends keyof typeof font>(property: K, value?: (typeof font)[K]) => onDraft(setTypography(draft, role, property, value));
        return (
          <section key={role} aria-label={role} className="theme-editor-role">
            <h2>{role}</h2>
            <Field label={tr("Font family")} hint={tr("Installed fonts, comma separated, with fallbacks.")} overridden={"family" in own} onReset={() => set("family")}>
              <FamilyInput label={`${role} font family`} value={font.family} onChange={(value) => set("family", value)} />
            </Field>
            <Field label={tr("Size")} overridden={"size" in own} onReset={() => set("size")}>
              <NumberInput label={`${role} size`} value={font.size} min={8} max={72} onChange={(value) => set("size", value)} />
            </Field>
            <Field label={tr("Weight")} overridden={"weight" in own} onReset={() => set("weight")}>
              <Choice label={`${role} weight`} value={String(font.weight)} options={weights} onChange={(value) => set("weight", Number(value))} />
            </Field>
            <Field label={tr("Style")} overridden={"style" in own} onReset={() => set("style")}>
              <Choice label={`${role} style`} value={font.style} options={(["normal", "italic", "oblique"] as const).map((value) => ({ value, label: value }))} onChange={(value) => set("style", value)} />
            </Field>
            <Field label={tr("Line height")} overridden={"lineHeight" in own} onReset={() => set("lineHeight")}>
              <NumberInput label={`${role} line height`} value={font.lineHeight} min={1} max={3} step={0.05} onChange={(value) => set("lineHeight", value)} />
            </Field>
            <Field label={tr("Letter spacing")} overridden={"letterSpacing" in own} onReset={() => set("letterSpacing")}>
              <NumberInput label={`${role} letter spacing`} value={font.letterSpacing} min={-3} max={10} step={0.1} onChange={(value) => set("letterSpacing", value)} />
            </Field>
            <Field label={tr("Ligatures")} overridden={"ligatures" in own} onReset={() => set("ligatures")}>
              <Check label={tr("Use ligatures")} checked={font.ligatures} onChange={(value) => set("ligatures", value)} />
            </Field>
          </section>
        );
      })}
    </div>
  );
}

export function EffectsPanel({ draft, resolved, onDraft }: PanelProps) {
  const shadows = resolved.effects.shadow;
  const own = !!currentTheme(draft).effects?.shadow;
  const update = (index: number, change: Partial<Shadow>) =>
    onDraft(setShadow(draft, shadows.map((shadow, i) => (i === index ? { ...shadow, ...change } : shadow))));
  return (
    <div className="theme-editor-section">
      <h2>{tr("Popover shadow")}</h2>
      {shadows.map((shadow, index) => (
        <section key={index} className="theme-editor-role" aria-label={tr("Shadow {n}", { n: index + 1 })}>
          {(["x", "y", "blur", "spread"] as const).map((property) => (
            <Field key={property} label={property}>
              <NumberInput
                label={`${tr("Shadow {n}", { n: index + 1 })} ${property}`}
                value={shadow[property]}
                min={property === "blur" ? 0 : -100}
                max={property === "blur" ? 200 : 100}
                onChange={(value) => update(index, { [property]: value })}
              />
            </Field>
          ))}
          <Field label={tr("Color")}>
            <ColorInput label={`${tr("Shadow {n}", { n: index + 1 })} color`} value={shadow.color} onChange={(color) => update(index, { color })} />
          </Field>
          <button className="button" onClick={() => onDraft(setShadow(draft, shadows.filter((_, i) => i !== index)))}>
            {tr("Remove Shadow")}
          </button>
        </section>
      ))}
      <div className="toolbar">
        <button className="button" disabled={shadows.length >= 8} onClick={() => onDraft(setShadow(draft, [...shadows, { x: 0, y: 4, blur: 12, spread: 0, color: "#00000040" }]))}>
          {tr("Add Shadow")}
        </button>
        {own && <button className="button" onClick={() => onDraft(setShadow(draft))}>{tr("Reset Shadows")}</button>}
      </div>
    </div>
  );
}

export function JsonPanel({ draft, onDraft }: Omit<PanelProps, "resolved">) {
  const source = JSON.stringify(draft.pack, null, 2);
  const [text, setText] = useState(source);
  const [error, setError] = useState("");
  useEffect(() => setText(source), [source]);
  const apply = () => {
    const result = parsePack(text);
    if (!result.valid || !result.pack) return setError(formatDiagnostics(result.errors));
    setError("");
    const pack = result.pack;
    onDraft({
      ...draft,
      pack,
      installed: draft.installed && pack.id === draft.pack.id,
      themeId: pack.themes.some((theme) => theme.id === draft.themeId) ? draft.themeId : pack.themes[0].id,
    });
  };
  return (
    <div className="theme-editor-section theme-editor-json">
      <textarea aria-label={tr("Theme pack JSON")} spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />
      <div className="toolbar">
        <button className="button" disabled={text === source} onClick={apply}>{tr("Apply JSON")}</button>
        <button className="button" disabled={text === source} onClick={() => { setText(source); setError(""); }}>{tr("Discard JSON Changes")}</button>
      </div>
      {error && <pre className="error-text" role="alert">{error}</pre>}
    </div>
  );
}
