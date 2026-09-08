import { StateEffect, StateField, Prec } from "@codemirror/state";
import { EditorView, showTooltip, keymap, type Tooltip } from "@codemirror/view";
import { hoverDOM } from "./hover.js";
const popup = StateEffect.define<Tooltip | null>();
const field = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection) value = null;
    for (const effect of transaction.effects) if (effect.is(popup)) value = effect.value;
    return value;
  },
  provide: value => showTooltip.from(value),
});
export const documentationPopups = [field, Prec.highest(keymap.of([{ key: "Escape", run: view => {
  if (!view.state.field(field)) return false;
  view.dispatch({ effects: popup.of(null) }); view.focus(); return true;
} }]))];
export function hideDocumentation(view: EditorView) { if (view.state.field(field, false)) view.dispatch({ effects: popup.of(null) }); }
export function showDocumentation(view: EditorView, pos: number, contents: unknown) {
  view.dispatch({ effects: popup.of({ pos, above: true, create: () => ({ dom: hoverDOM(contents) }) }) });
}
export function parameterRange(signature: any, active: number): [number, number] | undefined {
  const parameter = signature.parameters?.[active], label = parameter?.label;
  if (Array.isArray(label) && label.length === 2 && label.every(Number.isInteger) && label[0] >= 0 && label[1] >= label[0] && label[1] <= signature.label.length) return [label[0], label[1]];
  if (typeof label === "string") { const from = signature.label.indexOf(label); if (from >= 0) return [from, from + label.length]; }
}
export function showSignature(view: EditorView, pos: number, result: any) {
  if (!result?.signatures?.length) { view.dispatch({ effects: popup.of(null) }); return; }
  let active = Math.max(0, Math.min(result.signatures.length - 1, result.activeSignature ?? 0));
  const create = () => {
    const dom = document.createElement("div"); dom.className = "lsp-tooltip lsp-signature"; dom.setAttribute("aria-label", "Signature help"); dom.tabIndex = 0;
    const render = () => {
      dom.replaceChildren();
      const signature = result.signatures[active], parameter = signature.activeParameter ?? result.activeParameter ?? 0;
      if (result.signatures.length > 1) {
        const controls = document.createElement("div");
        for (const [title, direction] of [["Previous overload", -1], ["Next overload", 1]] as const) {
          const button = document.createElement("button"); button.type = "button"; button.textContent = direction < 0 ? "←" : "→"; button.setAttribute("aria-label", title);
          button.onclick = () => { active = (active + direction + result.signatures.length) % result.signatures.length; render(); }; controls.append(button);
        }
        controls.append(document.createTextNode(` ${active + 1} / ${result.signatures.length}`)); dom.append(controls);
      }
      const code = document.createElement("pre"), range = parameterRange(signature, parameter);
      if (range) { code.append(document.createTextNode(signature.label.slice(0, range[0]))); const mark = document.createElement("strong"); mark.textContent = signature.label.slice(range[0], range[1]); code.append(mark, document.createTextNode(signature.label.slice(range[1]))); }
      else code.textContent = signature.label;
      dom.append(code);
      if (signature.documentation) dom.append(hoverDOM(signature.documentation));
      if (signature.parameters?.[parameter]?.documentation) dom.append(hoverDOM(signature.parameters[parameter].documentation));
    };
    dom.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); view.dispatch({ effects: popup.of(null) }); view.focus(); } });
    render(); return { dom };
  };
  view.dispatch({ effects: popup.of({ pos, above: true, create }) });
}
