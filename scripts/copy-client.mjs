/**
 * Stage the hand-written browser half into `lib/`.
 *
 * The client half must stay the shell's `window.__ModuleLoader__` factory (the
 * web app loads it through that seam), so it is authored as plain JavaScript and
 * copied verbatim rather than compiled or bundled.
 */
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('lib', { recursive: true });
copyFileSync('src/client/index.js', 'lib/client.js');
console.log('copy-client: src/client/index.js -> lib/client.js');
