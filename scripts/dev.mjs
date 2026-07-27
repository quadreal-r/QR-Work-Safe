/**
 * Local live-reload for Capacitor / desktop browser.
 *
 *   npm run dev            → desktop browser
 *   npm run dev:android    → phone over USB/Wi-Fi
 *   npm run dev:ios        → iPhone (Mac + Xcode)
 */
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import browserSync from 'browser-sync';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const platform = (process.argv[2] || '').toLowerCase();
const PORT = Number(process.env.DEV_PORT || 3334);
const bridgeSrc = join(root, 'native-bridge.js');
const bridgeOutDir = join(root, '.dev');
const bridgeOut = join(bridgeOutDir, 'native-bridge.js');

function lanIp() {
  if (process.env.DEV_HOST) return process.env.DEV_HOST;
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

async function rebuildBridge() {
  if (!existsSync(bridgeOutDir)) mkdirSync(bridgeOutDir, { recursive: true });
  await esbuild.build({
    entryPoints: [bridgeSrc],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2019'],
    outfile: bridgeOut,
    logLevel: 'silent',
  });
  console.log('[dev] rebuilt native-bridge.js');
}

await rebuildBridge();

const host = lanIp();
const bs = browserSync.create();

function bridgeMiddleware(req, res, next) {
  if (req.url && req.url.split('?')[0] === '/native-bridge.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(bridgeOut));
    return;
  }
  next();
}

await new Promise((resolve, reject) => {
  bs.init(
    {
      server: { baseDir: root, middleware: bridgeMiddleware },
      port: PORT,
      host: '0.0.0.0',
      open: !platform,
      notify: false,
      ui: false,
      ghostMode: false,
      files: ['index.html'],
      watch: true,
    },
    (err) => (err ? reject(err) : resolve())
  );
});

console.log(`[dev] http://${host}:${PORT}/  (local http://127.0.0.1:${PORT}/)`);

watch(bridgeSrc, { persistent: true }, async () => {
  try {
    await rebuildBridge();
    bs.reload('native-bridge.js');
  } catch (e) {
    console.error('[dev] bridge rebuild failed:', e.message || e);
  }
});

if (!platform) {
  console.log('[dev] browser mode — Ctrl+C to stop');
} else if (platform !== 'android' && platform !== 'ios') {
  console.error(`[dev] unknown platform "${platform}" (use android|ios)`);
  process.exit(1);
} else {
  if (platform === 'ios' && process.platform === 'win32') {
    console.warn('[dev] iOS live-reload requires a Mac with Xcode.');
  }

  const args = [
    'cap',
    'run',
    platform,
    '--live-reload',
    '--host',
    host,
    '--port',
    String(PORT),
  ];
  if (platform === 'android') {
    args.push('--forwardPorts', String(PORT));
  }

  console.log(`[dev] npx ${args.join(' ')}`);
  const child = spawn('npx', args, {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });

  const shutdown = () => {
    try {
      child.kill('SIGTERM');
    } catch (_) {}
    bs.exit();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  child.on('exit', (code) => {
    bs.exit();
    process.exit(code == null ? 0 : code);
  });
}
