import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import toml from './vendor/smol-toml/index.cjs';

function colors(value) {
  return Object.fromEntries(['surface', 'ink', 'accent'].flatMap(key => {
    const color = value?.[key];
    return typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color) ? [[key, color]] : [];
  }));
}

export function parseAppearance(text) {
  const {desktop} = toml.parse(text, {integersAsBigInt: 'asNeeded', unsafeKeyBehaviour: 'drop'});
  const mode = desktop?.appearanceTheme;
  return {
    mode: mode === 'light' || mode === 'dark' ? mode : 'system',
    light: colors(desktop?.appearanceLightChromeTheme),
    dark: colors(desktop?.appearanceDarkChromeTheme)
  };
}

export function createAppearance(root) {
  const path = join(root, 'config.toml');
  let current = {mode: 'system', light: {}, dark: {}};
  let signature;
  let reading;

  async function refresh() {
    try {
      const file = await stat(path);
      const key = [file.ino, file.size, file.mtimeMs, file.ctimeMs].join(':');
      if (key !== signature && file.isFile() && file.size <= 1024 * 1024) {
        current = parseAppearance(await readFile(path, 'utf8'));
        signature = key;
      }
    } catch {
      // Codex may be replacing or rewriting the file. Keep the last valid theme.
    }
    return current;
  }

  return () => reading ??= refresh().finally(() => { reading = null; });
}
