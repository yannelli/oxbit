// Regenerate the bundled adaptations from this reviewed, immutable upstream revision.
import { mkdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import { convertPalette } from './theme-conversion.mjs';

const revision = '5a67e0f1cc6b5db6bb8eea3c8c31e1019d8954d1';
const base = `https://raw.githubusercontent.com/microsoft/vscode/${revision}`;
const sources = new Map();
async function readTheme(file) {
  if (sources.has(file)) return sources.get(file);
  const response = await fetch(`${base}/extensions/theme-defaults/themes/${file}.json`);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  const { config, error } = ts.parseConfigFileTextToJson(file, await response.text());
  if (error) throw new Error(`Invalid JSONC: ${file}`);
  const parent = config.include ? await readTheme(config.include.replace('./', '').replace('.json', '')) : {};
  const theme = {
    colors: { ...parent.colors, ...config.colors },
    tokenColors: [...(parent.tokenColors || []), ...(config.tokenColors || [])],
  };
  sources.set(file, theme);
  return theme;
}

// Oxbit has fewer semantic slots than VS Code. These defaults reproduce the
// corresponding VS Code light/dark registries; only unmapped slots use fallbacks.
function palette(theme, mode, hc) {
  const dark = mode === 'dark';
  const c = (key, fallback) => theme.colors[key] ?? fallback;
  const token = (scope, fallback) => {
    // Representative TextMate scope, with specificity and later-rule precedence.
    let value = fallback, specificity = -1;
    for (const rule of theme.tokenColors) {
      if (!rule.settings.foreground) continue;
      const scopes = Array.isArray(rule.scope) ? rule.scope : (rule.scope || '').split(',');
      for (const candidate of scopes.map(s => s.trim())) {
        if (candidate && (scope === candidate || scope.startsWith(candidate + '.')) && candidate.length >= specificity) {
          specificity = candidate.length;
          value = rule.settings.foreground;
        }
      }
    }
    return value;
  };
  const alpha = (color, opacity) => {
    let hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map(c => c + c).join('');
    return `#${hex.slice(0, 6)}${Math.round(opacity * 255).toString(16).padStart(2, '0')}`;
  };
  const fg = c('editor.foreground', hc ? (dark ? '#FFFFFF' : '#292929') : (dark ? '#BBBBBB' : '#333333'));
  const ui = c('foreground', hc ? (dark ? '#FFFFFF' : '#292929') : (dark ? '#CCCCCC' : '#616161'));
  const border = hc ? (dark ? '#6FC3DF' : '#0F4A85') : c('widget.border', dark ? '#454545' : '#D4D4D4');
  const accent = hc ? border : c('button.background', dark ? '#0E639C' : '#007ACC');
  const info = c('notificationsInfoIcon.foreground', dark ? '#75BEFF' : '#0063B1');
  const error = c('errorForeground', dark ? '#F48771' : '#A1260D');
  const warn = c('list.warningForeground', dark ? '#CCA700' : '#895503');
  const add = c('gitDecoration.addedResourceForeground', c('editorGutter.addedBackground', dark ? '#81B88B' : '#587C0C'));
  const del = c('gitDecoration.deletedResourceForeground', c('editorGutter.deletedBackground', dark ? '#C74E39' : '#AD0707'));
  const editor = c('editor.background', dark ? (hc ? '#000000' : '#1E1E1E') : '#FFFFFF');
  return {
    '--bg-app': c('titleBar.activeBackground', hc ? editor : (dark ? '#3C3C3C' : '#DDDDDD')),
    '--bg-surface': c('sideBar.background', hc ? editor : (dark ? '#252526' : '#F3F3F3')),
    '--bg-editor': editor,
    '--bg-raised': c('editorWidget.background', hc ? (dark ? '#0C141F' : '#FFFFFF') : (dark ? '#252526' : '#F3F3F3')),
    '--bg-input': c('input.background', hc ? editor : (dark ? '#3C3C3C' : '#FFFFFF')),
    '--bg-hover': c('list.hoverBackground', hc ? alpha(border, 0.1) : (dark ? '#2A2D2E' : '#F0F0F0')),
    '--bg-active': c('toolbar.activeBackground', alpha(ui, 0.12)),
    // Oxbit retains text colors on list selection; tint the classic blue fill.
    '--bg-selected': c('list.activeSelectionBackground', alpha(accent, 0.16)),
    '--bd': hc ? border : c('sideBar.border', border),
    '--bd-strong': hc ? border : c('input.border', border),
    '--fg': ui,
    '--fg-2': c('descriptionForeground', hc ? ui : (dark ? '#AAAAAA' : '#616161')),
    '--fg-3': c('editorLineNumber.foreground', hc ? ui : (dark ? '#858585' : '#6E7681')),
    '--fg-4': c('disabledForeground', dark ? '#A5A5A5' : '#7F7F7F'),
    '--accent': accent,
    '--accent-fg': hc && dark ? '#000000' : c('button.foreground', '#FFFFFF'),
    '--accent-soft': alpha(accent, 0.16),
    '--focus': c('focusBorder', hc ? (dark ? '#F38518' : '#006BBD') : (dark ? '#007FD4' : '#0090F1')),
    '--err': error,
    '--warn': warn,
    '--info': info,
    '--ok': add,
    '--mod': c('gitDecoration.modifiedResourceForeground', c('editorGutter.modifiedBackground', dark ? '#E2C08D' : '#895503')),
    '--add': add,
    '--del': del,
    '--conflict': c('gitDecoration.conflictingResourceForeground', dark ? '#E4676B' : '#AD0707'),
    '--err-soft': alpha(error, 0.14),
    '--warn-soft': alpha(warn, 0.14),
    '--add-soft': alpha(add, 0.14),
    '--del-soft': alpha(del, 0.14),
    '--info-soft': alpha(info, 0.14),
    '--tok-keyword': token('keyword', fg),
    '--tok-string': token('string', fg),
    '--tok-number': token('constant.numeric', fg),
    '--tok-comment': token('comment', fg),
    '--tok-type': token('entity.name.type', fg),
    '--tok-function': token('entity.name.function', fg),
    '--tok-property': token('meta.object-literal.key', fg),
    '--tok-variable': token('variable.other', fg),
    '--tok-ident': token('variable.other', fg),
    '--tok-text': fg,
    '--tok-tag': token('entity.name.tag', fg),
    '--tok-attr': token('entity.other.attribute-name', fg),
    '--tok-punct': fg,
    '--tok-operator': token('keyword.operator', fg),
    '--tok-heading': token('markup.heading', fg),
    '--tok-link': c('textLink.foreground', dark ? '#3794FF' : '#006AB1'),
    '--tok-strong': token('markup.bold', fg),
    '--tok-space': 'transparent',
    '--tok-guide': 'transparent',
    '--line-active': c('editor.lineHighlightBackground', alpha(ui, 0.04)),
    '--match': c('editor.findMatchHighlightBackground', dark ? '#EA5C0055' : '#EA5C0033'),
    '--match-active': c('editor.findMatchBackground', dark ? '#515C6A' : '#A8AC94'),
    '--occ': c('editor.wordHighlightBackground', c('editor.selectionHighlightBackground', alpha(accent, 0.15))),
    // CodeMirror draws selections behind syntax without VS Code's HC foreground
    // override. A translucent fill preserves readable text in both HC modes.
    '--sel': hc ? alpha(border, 0.22) : c('editor.selectionBackground', dark ? '#264F78' : '#ADD6FF'),
    '--guide': c('editorIndentGuide.background', c('editorIndentGuide.background1', border)),
    '--shadow': hc ? 'none' : `0 8px 28px ${dark ? '#00000066' : '#00000029'}, 0 1px 2px #00000026`,
    '--scrim': dark ? '#00000099' : '#00000059',
  };
}
const variants = [
  ['light-modern', 'Light Modern', 'light_modern', 'light', 'dark-modern'],
  ['light-plus', 'Light+', 'light_plus', 'light', 'dark-plus'],
  ['2026-light', '2026 Light', '2026-light', 'light', '2026-dark'],
  ['dark-modern', 'Dark Modern', 'dark_modern', 'dark', 'light-modern'],
  ['dark-plus', 'Dark+', 'dark_plus', 'dark', 'light-plus'],
  ['2026-dark', '2026 Dark', '2026-dark', 'dark', '2026-light'],
  ['hc-dark', 'High Contrast Dark', 'hc_black', 'dark', 'hc-light'],
  ['hc-light', 'High Contrast Light', 'hc_light', 'light', 'hc-dark'],
];
const themes = await Promise.all(variants.map(async ([id, title, file, mode, paired]) => ({
  id: `oxbit.vscode-${id}`, kind: 'theme', title: `VS Code ${title}`,
  data: { mode, highContrast: id.startsWith('hc-'), pairedTheme: `oxbit.vscode-${paired}`, variables: palette(await readTheme(file), mode, id.startsWith('hc-')) },
})));
const license = await fetch(`${base}/LICENSE.txt`);
if (!license.ok) throw new Error(`License: HTTP ${license.status}`);
const licenseText = await license.text();
await writeFile(new URL('../packages/features/themes/LICENSE.vscode.txt', import.meta.url), licenseText);
await mkdir(new URL('../apps/web/public/licenses/', import.meta.url), { recursive: true });
await writeFile(new URL('../apps/web/public/licenses/vscode-themes.txt', import.meta.url), licenseText);
for (const [id, name, values] of [['oxbit.vscode','VS Code',themes.slice(0,6)],['oxbit.vscode-hc','VS Code High Contrast',themes.slice(6)]]) {
  const pack={$schema:'/schemas/theme-pack.v1.schema.json',schemaVersion:1,id,name,version:'1.0.0',attribution:`Adapted from microsoft/vscode (${revision}).\n\n${licenseText}`,themes:values.map(theme=>({...convertPalette(theme),...(id.endsWith('-hc')?{highContrast:true}:{})}))};
  await writeFile(new URL(`../packages/features/themes/src/packs/${id}.json`,import.meta.url),JSON.stringify(pack,null,2)+'\n');
}
console.log(`Imported ${themes.length} VS Code themes at ${revision}`);
