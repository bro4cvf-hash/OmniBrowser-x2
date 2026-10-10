/* Real Chrome regression for the AVPS selector escaping failure. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const event = () => ({ addListener() {}, removeListener() {} });
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true
  });
  try {
    const page = await browser.newPage();
    // Names and placeholders from AVPS /contact/, exercised locally without submission.
    await page.setContent(`<form>
      <input name="your-full-name" placeholder="Name">
      <input name="your-email" type="email" placeholder="Email Address">
      <input name="tel-481" type="tel" placeholder="Phone">
      <input name="company-name" placeholder="Company">
      <input name="website-url" placeholder="https://www.yourwebsite.com">
      <select name="estimated-monthly-volume"><option value="">Select an Option</option><option value="10000">10,000</option></select>
      <select name="hear-about-us"><option value="">Select an Option</option><option>Referral</option></select>
      <textarea name="your-message"></textarea>
      <label><input type="checkbox" name="sms-consent686[]">Consent</label>
      <button type="submit">Send Message</button>
    </form><iframe srcdoc="&lt;input name=your-full-name&gt;"></iframe><div id="shadowHost"></div>`);
    await page.evaluate(() => {
      document.querySelector('#shadowHost').attachShadow({ mode: 'open' }).innerHTML = '<input name="shadow-email">';
      window.inputEvents = 0;
      window.submits = 0;
      document.addEventListener('input', () => window.inputEvents++);
      document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); window.submits++; });
    });
    const chrome = {
      runtime: { onMessage: event(), connectNative: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {} }) },
      tabs: { onRemoved: event(), onUpdated: event(), get: async () => ({ id: 7, url: 'https://example.com/contact/' }) },
      debugger: { onEvent: event(), onDetach: event() },
      scripting: { executeScript: async ({ target, func, args = [] }) => {
        const frames = page.frames();
        const selected = target.allFrames ? frames : (target.frameIds || [0]).map(i => frames[i]);
        return Promise.all(selected.map(async frame => ({ frameId: frames.indexOf(frame),
          result: await frame.evaluate(({ code, args }) => (0, eval)('(' + code + ')')(...args), { code: func.toString(), args })
        })));
      } }
    };
    const worker = vm.createContext({ chrome, console, URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync('extensions/chrome/background.js', 'utf8'), worker);
    const tool = (name, args) => {
      worker.toolName = name; worker.toolArgs = args;
      return vm.runInContext('runSidebarTool(toolName, toolArgs)', worker);
    };
    // Serialize the function exactly as Chrome does, without worker globals.
    const inject = async (name, args) => page.evaluate(({ code, args }) =>
      (0, eval)('(' + code + ')')(...args), { code: vm.runInContext(name, worker).toString(), args });
    const escaped = selector => selector.replaceAll('"', '\\"');
    const nameSelector = 'input[name="your-full-name"]';
    assert.equal(await page.locator(nameSelector).count(), 1);
    assert.equal(await page.locator(escaped(nameSelector)).count(), 0, 'Screenshot selector reproduces the failure in Chrome');
    const unseen = await inject('applySidebarAction', ['fill', {
      selector: escaped(nameSelector), value: 'Should not fill', timeoutMs: 100, __serializeErrors: true
    }]);
    assert.equal(unseen.completed, false, 'Never repair an unobserved target');

    let snapshot = await tool('read_page', { tabId: 7 });
    let fields = snapshot.elements.filter(el => el.frameId === 0);
    const values = { 'your-full-name': 'Example Person', 'your-email': 'person@example.com',
      'tel-481': '5551234567', 'company-name': 'Example Company', 'website-url': 'https://example.com',
      'estimated-monthly-volume': '10000', 'hear-about-us': 'Referral', 'your-message': 'Test message' };
    const actions = fields.filter(el => el.name in values || el.type === 'checkbox').map(el => ({
      action: el.type === 'checkbox' ? 'set_checked' : el.tag === 'select' ? 'select_option' : 'fill',
      selector: escaped(el.selector), frameId: el.frameId,
      ...(el.type === 'checkbox' ? { checked: true } : { value: values[el.name] })
    }));
    assert.equal(actions.length, 9);
    const batch = await tool('batch_actions', { tabId: 7, actions });
    assert.equal(batch.completed, true, batch.error);
    assert.equal(batch.results.length, 9);
    const verification = await tool('form_verify', { tabId: 7, fields: actions });
    assert.equal(verification.verified, true, JSON.stringify(verification));
    assert.equal(await page.evaluate(() => window.inputEvents), 9, 'Filled controls notify the page');
    assert.equal(await page.evaluate(() => window.submits), 0);

    const single = await tool('fill', { tabId: 7, selector: escaped(nameSelector), value: 'Single field' });
    assert.equal(single.completed, true);
    await inject('waitForActionable', ['css=' + escaped(nameSelector), { timeoutMs: 100 }]);
    const step = await tool('browser_step', { tabId: 7, actions: [{
      action: 'fill', selector: escaped(nameSelector), value: 'One step'
    }] });
    assert.equal(step.completed, true);
    assert.equal(await page.locator(nameSelector).inputValue(), 'One step');
    snapshot = await tool('read_page', { tabId: 7 });
    const child = snapshot.elements.find(el => el.frameId === 1 && el.name === 'your-full-name');
    await tool('fill', { tabId: 7, selector: child.ref, value: 'Child frame' });
    assert.equal(await page.frames()[1].locator(nameSelector).inputValue(), 'Child frame');
    assert.equal(await page.locator(nameSelector).inputValue(), 'One step', 'Frame ref must not fill the main document');
    const shadow = snapshot.elements.find(el => el.name === 'shadow-email');
    await tool('fill', { tabId: 7, selector: escaped(shadow.selector), value: 'shadow@example.com' });
    assert.equal(await page.locator('#shadowHost input').inputValue(), 'shadow@example.com');

    await page.evaluate(() => {
      const input = document.createElement('input'); input.name = 'literal\\backslash'; document.body.append(input);
    });
    snapshot = await tool('read_page', { tabId: 7 });
    const backslash = snapshot.elements.find(el => el.name === 'literal\\backslash');
    await tool('fill', { tabId: 7, selector: escaped(backslash.selector), value: 'Preserved backslash' });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('input')].find(el => el.name === 'literal\\backslash').value), 'Preserved backslash');

    // A genuine CSS match containing quote characters must win over repair.
    await page.evaluate(() => {
      const input = document.createElement('input'); input.name = '"your-full-name"'; document.body.append(input);
    });
    await tool('read_page', { tabId: 7 });
    await tool('fill', { tabId: 7, selector: escaped(nameSelector), value: 'Literal quoted name' });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('input')].find(el => el.name === '"your-full-name"').value), 'Literal quoted name');
    assert.equal(await page.locator(nameSelector).inputValue(), 'One step');
    await page.evaluate(() => [...document.querySelectorAll('input')].find(el => el.name === '"your-full-name"').remove());

    await tool('read_page', { tabId: 7 });
    await page.evaluate(() => { window.__omnibrowser_generation++; });
    const stale = await inject('applySidebarAction', ['fill', {
      selector: escaped(nameSelector), value: 'Stale', timeoutMs: 100, __serializeErrors: true
    }]);
    assert.equal(stale.completed, false, 'Stale observations cannot repair selectors');
    await tool('read_page', { tabId: 7 });
    await page.evaluate(() => document.body.append(document.querySelector('input[name="your-full-name"]').cloneNode()));
    const duplicate = await inject('applySidebarAction', ['fill', {
      selector: escaped(nameSelector), value: 'Ambiguous', timeoutMs: 100, __serializeErrors: true
    }]);
    assert.equal(duplicate.completed, false);
    assert.match(duplicate.actionError, /not unique/);
    assert.equal(await page.evaluate(() => window.submits), 0);
    console.log('AVPS quote escaping, nine-field filling, verification, frame refs, shadow roots, literal CSS matches and stale/ambiguous rejection passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
