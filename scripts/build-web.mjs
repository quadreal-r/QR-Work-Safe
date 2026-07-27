/**
 * Copy / bundle the root web app into www/ for Capacitor and Cloudflare deploys.
 */
import {
  mkdirSync, copyFileSync, existsSync, rmSync, writeFileSync, readFileSync, readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');

if (existsSync(www)) {
  rmSync(www, { recursive: true, force: true });
}
mkdirSync(www, { recursive: true });

const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
copyFileSync(join(root, 'index.html'), join(www, 'index.html'));
console.log('[build:web] copied index.html');

copyFileSync(join(root, 'manifest.webmanifest'), join(www, 'manifest.webmanifest'));
console.log('[build:web] copied manifest.webmanifest');

const icons = join(root, 'icons');
if (existsSync(icons)) {
  mkdirSync(join(www, 'icons'), { recursive: true });
  for (const name of readdirSync(icons)) {
    copyFileSync(join(icons, name), join(www, 'icons', name));
  }
  console.log('[build:web] copied icons/');
}

const appVer = indexHtml.match(/const\s+APP_VER\s*=\s*'([^']+)'/)?.[1];
if (!appVer) {
  console.error('[build:web] could not read APP_VER from index.html');
  process.exit(1);
}
const swPath = join(root, 'sw.js');
const swSrc = readFileSync(swPath, 'utf8');
const sw = swSrc.replace(/const VERSION = '[^']*';/, `const VERSION = '${appVer}';`);
if (sw !== swSrc) writeFileSync(swPath, sw);
writeFileSync(join(www, 'sw.js'), sw);
console.log(`[build:web] wrote sw.js (${appVer})`);

const bridgeSrc = join(root, 'native-bridge.js');
if (!existsSync(bridgeSrc)) {
  console.error('[build:web] missing native-bridge.js');
  process.exit(1);
}

await esbuild.build({
  entryPoints: [bridgeSrc],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2019'],
  outfile: join(www, 'native-bridge.js'),
  logLevel: 'warning',
});
console.log('[build:web] bundled native-bridge.js');

writeFileSync(join(www, '.build-stamp'), new Date().toISOString());
console.log(`[build:web] ready → ${www}`);
