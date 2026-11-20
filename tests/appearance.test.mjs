import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAppearance, parseAppearance} from '../plugin/appearance.mjs';

test('only exposes the desktop mode and supported custom colors', () => {
  assert.deepEqual(parseAppearance(`
    api_key = "ignored"
    [desktop]
    appearanceTheme = "dark"
    appearanceDarkChromeTheme = { surface = "#222222", ink = "#AAAAAA", accent = "invalid" }
    [desktop.appearanceLightChromeTheme]
    surface = "#ffffff"
    accent = "#3a83f7"
  `), {
    mode: 'dark',
    light: {surface: '#ffffff', accent: '#3a83f7'},
    dark: {surface: '#222222', ink: '#AAAAAA'}
  });
  assert.equal(parseAppearance('[desktop]\nappearanceTheme = "light"').mode, 'light');
  assert.equal(parseAppearance('').mode, 'system');
});

test('uses the last valid palette during a partial write and reloads valid changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'context-appearance-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const read = createAppearance(root);
  const path = join(root, 'config.toml');
  assert.equal((await read()).mode, 'system');
  await writeFile(path, '[desktop]\nappearanceTheme = "light"\n');
  assert.equal((await read()).mode, 'light');
  await writeFile(path, '[desk');
  assert.equal((await read()).mode, 'light');
  await writeFile(path, '[desktop]\nappearanceTheme = "dark" # updated\n');
  assert.equal((await read()).mode, 'dark');
});
