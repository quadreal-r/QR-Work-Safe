/**
 * Sync APP_VER / BUILD from index.html into Android and iOS native projects.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const verMatch = html.match(/const\s+APP_VER\s*=\s*['"]v?([^'"]+)['"]/);
const buildMatch = html.match(/const\s+BUILD\s*=\s*(\d+)\s*;/);

if (!verMatch || !buildMatch) {
  console.error('[sync:version] could not parse APP_VER / BUILD from index.html');
  process.exit(1);
}

const versionName = verMatch[1];
const versionCode = parseInt(buildMatch[1], 10);
console.log(`[sync:version] ${versionName} (build ${versionCode})`);

function patch(file, mutators) {
  if (!existsSync(file)) {
    console.warn(`[sync:version] skip missing ${file}`);
    return;
  }
  const before = readFileSync(file, 'utf8');
  let after = before;
  let matched = false;
  for (const { re, to } of mutators) {
    if (re.test(after)) {
      matched = true;
      after = after.replace(re, to);
    }
  }
  if (!matched) {
    console.warn(`[sync:version] no version fields matched in ${file}`);
    return;
  }
  if (after === before) {
    console.log(`[sync:version] already up to date: ${file}`);
    return;
  }
  writeFileSync(file, after);
  console.log(`[sync:version] updated ${file}`);
}

patch(join(root, 'android', 'app', 'build.gradle'), [
  { re: /versionCode\s+\d+/g, to: `versionCode ${versionCode}` },
  { re: /versionName\s+"[^"]*"/g, to: `versionName "${versionName}"` },
]);

patch(join(root, 'android', 'app', 'build.gradle.kts'), [
  { re: /versionCode\s*=\s*\d+/g, to: `versionCode = ${versionCode}` },
  { re: /versionName\s*=\s*"[^"]*"/g, to: `versionName = "${versionName}"` },
]);

patch(join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), [
  { re: /CURRENT_PROJECT_VERSION = [^;]+;/g, to: `CURRENT_PROJECT_VERSION = ${versionCode};` },
  { re: /MARKETING_VERSION = [^;]+;/g, to: `MARKETING_VERSION = ${versionName};` },
]);

const pkgPath = join(root, 'package.json');
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.version !== versionName) {
    pkg.version = versionName;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`[sync:version] package.json → ${versionName}`);
  }
}

console.log('[sync:version] done');
