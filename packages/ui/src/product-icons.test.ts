import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { icons } from './icons.js';
import { productIconIds } from './product-icons.js';
import { Icon, IconProvider } from './index.js';
it('maps every built-in product ID or explicitly preserves its fallback', () => expect(Object.keys(productIconIds).sort()).toEqual(Object.keys(icons).sort()));
it('preserves legacy contributed SVG paths and dimensions', () => {
  const html = renderToStaticMarkup(createElement(IconProvider, { values: { search: 'M1 2L3 4' }, children: createElement(Icon, { name: 'search', size: 24 }) }));
  expect(html).toContain('d="M1 2L3 4"'); expect(html).toContain('width="24"'); expect(html).toContain('aria-hidden="true"'); expect(html).toContain('currentColor');
});
it('prefers a selected product theme and retains contributed paths for missing definitions', () => {
  const kernel = { services: { optional: () => ({ subscribe: () => () => {}, snapshot: () => 0, product: (id: string) => id === 'search' ? { kind: 'font', family: 'scoped-icons', character: 'X' } : undefined }) } } as any;
  const search = renderToStaticMarkup(createElement(IconProvider, { kernel, values: { search: 'M1 2L3 4' }, children: createElement(Icon, { name: 'search' }) }));
  expect(search).toContain('font-family:scoped-icons'); expect(search).not.toContain('M1 2L3 4');
  const missing = renderToStaticMarkup(createElement(IconProvider, { kernel, values: { gear: 'M2 3L4 5' }, children: createElement(Icon, { name: 'gear' }) }));
  expect(missing).toContain('M2 3L4 5');
});
it('uses explicit high-contrast metadata without depending on a theme name', async () => {
  const { FolderIcon } = await import('./index.js');
  let variant: string | undefined;
  const kernel = { configuration: { get: () => 'unremarkable-name' }, contributions: { list: () => [{ id: 'unremarkable-name', title: 'Custom', data: { highContrast: true } }] }, services: { optional: () => ({ subscribe: () => () => {}, snapshot: () => 0, file: (_resource: unknown, mode: string) => { variant = mode; return undefined; } }) } } as any;
  renderToStaticMarkup(createElement(IconProvider, { kernel, values: {}, children: createElement(FolderIcon, { path: 'src' }) }));
  expect(variant).toBe('highContrast');
});
