/* Run independent Node suites in a bounded pool; browser suites are opt-in. */
const { readdirSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');

const root = resolve(__dirname, '..');
const includeBrowser = process.argv.includes('--browser');
const suites = readdirSync(resolve(root, 'tests')).filter(name => /^test_.*\.js$/.test(name));
const pending = suites.filter(name => includeBrowser || !readFileSync(resolve(root, 'tests', name), 'utf8').includes("require('playwright')"));
console.log(`Running ${pending.length} suites; ${suites.length - pending.length} browser suites skipped (use --browser).`);
let failed = 0;

async function worker() {
  while (pending.length) {
    const name = pending.shift();
    await new Promise(done => {
      const child = spawn(process.execPath, [resolve(root, 'tests', name)], { cwd: root, stdio: 'inherit' });
      const timer = setTimeout(() => { console.error(`${name} timed out after 120 seconds.`); child.kill(); }, 120000);
      child.on('error', error => { console.error(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) { failed++; console.error(`FAIL ${name}`); }
        else console.log(`PASS ${name}`);
        done();
      });
    });
  }
}

Promise.all(Array.from({ length: includeBrowser ? 1 : 4 }, worker)).then(() => {
  process.exitCode = failed ? 1 : 0;
});
