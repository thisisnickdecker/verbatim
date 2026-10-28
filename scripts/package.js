#!/usr/bin/env node
/*
 * Build the download for a GitHub release: dist/verbatim-<version>.zip,
 * holding one folder "verbatim-<version>/" with what Chrome loads (manifest,
 * src, icons), the optional save helper (native/), README and LICENSE.
 * Tests, examples and dev files are left out.
 *
 *   npm run package
 *
 * Uses Verbatim's own .zip writer (src/site/zip.js); no dependencies.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INCLUDE = ['manifest.json', 'src', 'icons', 'native', 'README.md', 'LICENSE'];

const sandbox = { TextEncoder, Uint8Array, Uint32Array, DataView, Date, Error };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/site/zip.js'), 'utf8'), sandbox);
const { zip } = sandbox.Verbatim.zip;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest.json ${manifest.version}, package.json ${pkg.version}`);
  process.exit(1);
}
const top = `verbatim-${manifest.version}`;

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (fs.statSync(abs).isDirectory()) return fs.readdirSync(abs).sort().flatMap((n) => walk(path.join(rel, n)));
  return /(^|\/)\.DS_Store$/.test(rel) ? [] : [rel];
}

const files = INCLUDE.flatMap(walk).map((rel) => {
  const data = fs.readFileSync(path.join(ROOT, rel));
  return { path: `${top}/${rel.split(path.sep).join('/')}`, bytes: new Uint8Array(data.buffer, data.byteOffset, data.length) };
});
// Every file the manifest and pages point at must be in the download.
for (const ref of [manifest.background.service_worker, manifest.options_ui.page, ...Object.values(manifest.icons)]) {
  if (!files.some((f) => f.path === `${top}/${ref}`)) {
    console.error(`Missing from the package: ${ref}`);
    process.exit(1);
  }
}

const out = path.join(ROOT, 'dist', `${top}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat(zip(files).map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
console.log(`${path.relative(ROOT, out)}: ${files.length} files, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
