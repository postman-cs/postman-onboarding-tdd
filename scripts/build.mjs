import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { build } from 'esbuild';

const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });

await build({
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
  },
  bundle: true,
  define: {
    __ACTION_VERSION__: JSON.stringify(packageManifest.version)
  },
  entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
  format: 'esm',
  outfile: fileURLToPath(new URL('../dist/action.mjs', import.meta.url)),
  platform: 'node',
  target: 'node24'
});
