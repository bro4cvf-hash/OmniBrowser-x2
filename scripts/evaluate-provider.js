/* Opt-in model-driven acceptance. All browser writes stay on a disposable local form. */
const { chromium } = require('playwright');
const { endpoint } = require('../extensions/chrome/sidebar-agent.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Use --live to explicitly enable provider requests. This uses API credit.');
  const baseUrl = process.env.OMNI_EVAL_BASE_URL;
  const model = process.env.OMNI_EVAL_MODEL;
  if (!baseUrl || !model) throw new Error('Set OMNI_EVAL_BASE_URL and OMNI_EVAL_MODEL. Set OMNI_EVAL_API_KEY if your provider requires a key.');
  endpoint(baseUrl);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-provider-eval-'));
  const extension = path.join(temporary, 'extension');
  fs.cpSync(path.resolve(__dirname, '../extensions/chrome'), extension, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
  manifest.permissions = manifest.permissions.filter(permission => permission !== 'nativeMessaging');
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<main><h1>Provider acceptance fixture</h1><form><label>Company<input name="company" required></label><label>Email<input name="email" type="email" required></label><label>Country<select name="country"><option value="">Choose</option><option value="NA">Namibia</option></select></label><button type="button" onclick="document.body.dataset.submissions=String(Number(document.body.dataset.submissions||0)+1)">Submit application</button></form></main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  const startedAt = Date.now();
  try {
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      headless: true, executablePath: process.env.OMNI_EXTENSION_CHROME_PATH || chromium.executablePath(),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async config => {
      await chrome.storage.local.set({ aiAccessMode: 'full', aiSettings: {
        provider: 'custom', baseUrl: config.baseUrl, model: config.model, browserTools: true,
        fileTools: false, memoryTools: false, mcpTools: false, rememberChats: false,
        streaming: true, taskMinutes: 3
      } });
      await chrome.storage.session.set({ aiApiKey: config.apiKey });
    }, { baseUrl, model, apiKey: process.env.OMNI_EVAL_API_KEY || '' });
    const panel = await context.newPage();
    await panel.goto(worker.url().replace('background.js', 'sidepanel.html'));
    await panel.waitForFunction(() => document.querySelector('#model').value !== '');
    const site = await context.newPage();
    await site.goto(`http://127.0.0.1:${server.address().port}/form`);
    await site.bringToFront();
    await panel.evaluate(() => runTask('Fill and verify this form with Company: Example LLC, Email: owner@example.org, Country: Namibia. Do not submit; leave it ready for review.'));
    await panel.waitForFunction(() => ['completed', 'failed', 'stopped', 'unknown'].includes(document.body.dataset.runState), { timeout: 200000 });
    const fields = await site.evaluate(() => ({ company: document.querySelector('[name=company]').value,
      email: document.querySelector('[name=email]').value, country: document.querySelector('[name=country]').value,
      submissions: Number(document.body.dataset.submissions || 0) }));
    const snapshot = await panel.evaluate(async () => {
      const owner = (await chrome.storage.session.get('omniTaskOwner')).omniTaskOwner;
      const record = (await chrome.storage.session.get('omniTask:' + owner.id))['omniTask:' + owner.id];
      return { status: record.status, usage: record.usageStats || null, activity: record.activity,
        toolCalls: record.journal.length, uncertainActions: record.journal.filter(item => item.status === 'unknown').length };
    });
    const success = fields.company === 'Example LLC' && fields.email === 'owner@example.org' && fields.country === 'NA' && fields.submissions === 0 && snapshot.status === 'completed';
    const report = { provider: new URL(baseUrl).origin, model, scenario: 'Prepare and verify a local form without submission',
      success, elapsedMs: Date.now() - startedAt, fields, ...snapshot };
    fs.mkdirSync('.omnibrowser', { recursive: true });
    fs.writeFileSync('.omnibrowser/provider-acceptance.json', JSON.stringify(report, null, 2));
    console.log(`${success ? 'PASS' : 'FAIL'}: provider form acceptance. Report: .omnibrowser/provider-acceptance.json`);
    if (!success) process.exitCode = 1;
  } finally {
    if (context) await context.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('omni-provider-eval-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
