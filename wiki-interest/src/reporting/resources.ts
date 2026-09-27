import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromiumRoot } from '../environment.js';
const require = createRequire(import.meta.url);
export const browserPath = chromiumRoot;
export const fontRoot = dirname(require.resolve('@fontsource/noto-sans/package.json'));
export async function fontCss(): Promise<string> {
  let result = '';
  for (const weight of [400, 600]) {
    const css = await readFile(join(fontRoot, `${weight}.css`), 'utf8');
    for (const block of css.matchAll(/\/\* noto-sans-(latin|latin-ext|cyrillic|cyrillic-ext)-\d+-normal \*\/\s*(@font-face \{[^}]+\})/g)) {
      const face = block[2]!, filename = /url\(\.\/files\/([^)]*\.woff2)\)/.exec(face)![1]!;
      const bytes = await readFile(join(fontRoot, 'files', filename));
      result += face.replace(/src:[^;]+;/, `src: url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2');`).replace('font-display: swap;', 'font-display: block;');
    }
  }
  return result;
}
export function dependencyVersions(): Record<string, string> {
  return Object.fromEntries(['echarts', 'playwright', 'pdfjs-dist', '@napi-rs/canvas', '@fontsource/noto-sans'].map(name => [name, (require(`${name}/package.json`) as { version: string }).version]));
}
