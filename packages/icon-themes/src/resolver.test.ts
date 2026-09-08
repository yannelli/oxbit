import { describe, expect, it } from 'vitest';
import { resolveDefinition as resolve } from './resolver.js';
import type { Theme } from './types.js';
const theme: Theme = { iconDefinitions: {}, file: 'generic', folder: 'folder', folderExpanded: 'open', rootFolder: 'root', rootFolderExpanded: 'root-open', fileNames: { 'foo.d.ts': 'name', 'src/foo.d.ts': 'parent-name' }, fileExtensions: { 'd.ts': 'compound', ts: 'ext', 'src/ts': 'parent-ext' }, languageIds: { typescript: 'lang' }, folderNames: { src: 'src', 'test/src': 'test-src' }, folderNamesExpanded: { src: 'src-open' }, rootFolderNames: { project: 'project' }, light: { file: 'light', fileExtensions: { ts: 'light-ts' } }, highContrast: { folderExpanded: 'hc-open' } };
describe('VS Code file associations', () => {
  it.each([
    ['src/FOO.D.TS', 'parent-name'], ['other/FOO.D.TS', 'name'], ['src/bar.d.ts', 'parent-ext'], ['other/bar.d.ts', 'compound'], ['other/bar.ts', 'ext'], ['foo.unknown', 'lang'],
  ])('resolves %s by precedence', (path, id) => expect(resolve(theme, { path, languageId: 'typescript' }, 'dark')).toBe(id));
  it('uses language and generic fallbacks', () => { expect(resolve(theme, { path: 'x' }, 'dark')).toBe('generic'); expect(resolve(theme, { path: 'x' }, 'light')).toBe('light'); });
  it('merges variants while retaining more specific associations', () => {
    expect(resolve(theme, { path: 'bar.ts' }, 'light')).toBe('light-ts');
    expect(resolve(theme, { path: 'foo.d.ts' }, 'light')).toBe('name');
    expect(resolve(theme, { path: 'x', folder: true, expanded: true }, 'highContrast')).toBe('hc-open');
  });
  it('resolves named, parent-qualified and root folder states', () => {
    expect(resolve(theme, { path: 'test/src', folder: true }, 'dark')).toBe('test-src');
    expect(resolve(theme, { path: 'src', folder: true, expanded: true }, 'dark')).toBe('src-open');
    expect(resolve(theme, { path: 'project', folder: true, root: true, expanded: true }, 'dark')).toBe('project');
    expect(resolve(theme, { path: 'other', folder: true, root: true, expanded: true }, 'dark')).toBe('root-open');
  });
  it('falls back expanded folder states correctly', () => {
    expect(resolve({ iconDefinitions: {}, folder: 'closed' }, { path: 'x', folder: true, root: true, expanded: true }, 'dark')).toBe('closed');
  });
});
