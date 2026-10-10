/* Reproduce the browser wrapper around the unmodified official release. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const VERSION = '0.10.3';
const INTEGRITY = 'bCBIeZVIEUftC4PX20cHaqgxN+NOm4XOhHWYtmfPMIEuVs39vdMMq3LX7Z0dSunVKVlnVWB9BSWr5I5ZDtDtVA==';
(async () => {
  const directory = path.resolve('.omnibrowser/memory-research');
  fs.mkdirSync(directory, { recursive: true });
  const tarball = path.join(directory, `hindsight-client-${VERSION}.tgz`);
  const response = await fetch(`https://registry.npmjs.org/@vectorize-io/hindsight-client/-/hindsight-client-${VERSION}.tgz`);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash('sha512').update(bytes).digest('base64') !== INTEGRITY) throw new Error('Upstream integrity mismatch');
  fs.writeFileSync(tarball, bytes);
  execFileSync('tar', ['-xzf', tarball, '-C', directory]);
  const code = fs.readFileSync(path.join(directory, 'package/dist/index.js'), 'utf8');
  if (/require\(/.test(code)) throw new Error('SDK acquired a runtime dependency; review browser compatibility');
  const target = path.resolve('extensions/chrome/vendor/hindsight');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'hindsight-client.js'),
    `/* Official @vectorize-io/hindsight-client ${VERSION}. MIT. See LICENSE and provenance.json. */\n(function () {\nconst module = { exports: {} };\n${code}\nglobalThis.OmniHindsightSDK = module.exports;\n})();\n`);
  fs.writeFileSync(path.join(target, 'provenance.json'), JSON.stringify({
    package: '@vectorize-io/hindsight-client', version: VERSION,
    repository: 'https://github.com/vectorize-io/hindsight', tag: 'v0.10.3',
    commit: 'eb6df499d35300e5b2f3f029b2e6adda04ed90f8',
    integrity: `sha512-${INTEGRITY}`, upstreamFile: 'dist/index.js',
    upstreamSha256: crypto.createHash('sha256').update(code).digest('hex'),
    modifications: 'Unmodified release code enclosed in a CommonJS-to-browser global wrapper; no runtime downloads or evaluation.'
  }, null, 2) + '\n');
  const license = await fetch('https://raw.githubusercontent.com/vectorize-io/hindsight/eb6df499d35300e5b2f3f029b2e6adda04ed90f8/LICENSE');
  if (!license.ok) throw new Error('License download failed');
  fs.writeFileSync(path.join(target, 'LICENSE'), await license.text());
  console.log(`Vendored official Hindsight SDK ${VERSION}, verified SHA-512.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
