/* Exercise the agent and serialized browser actions in real Chrome, locally. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { run, submissionPermissionGuard } = require('../extensions/chrome/sidebar-agent.js');
const event = () => ({ addListener() {}, removeListener() {} });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = message => ({ ok: true, json: async () => ({ choices: [{ message }] }) });

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true
  });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form id="business">
      <input id="company" placeholder="Business name" required>
      <input id="website" placeholder="Website URL" type="url" required>
      <button type="button" role="combobox" aria-label="Country" onclick="document.querySelector('#options').hidden=false">United States</button>
      <div id="options" hidden><div role="option" onclick="document.querySelector('[role=combobox]').textContent='Namibia'; this.parentElement.hidden=true">Namibia</div></div>
      <textarea placeholder="Notes"></textarea>
      <button id="next" type="submit">Continue</button>
      <button class="neutral" type="submit"><span>Send Message</span></button>
      <button id="js-final" type="button" onclick="window.submits++">Submit application</button>
    </form><iframe srcdoc="&lt;form&gt;&lt;input placeholder='Child name'&gt;&lt;button type=submit&gt;Submit&lt;/button&gt;&lt;/form&gt;"></iframe>`);
    await page.evaluate(() => {
      window.submits = 0;
      window.steps = 0;
      document.querySelector('form').addEventListener('submit', e => {
        e.preventDefault();
        if (e.submitter?.id === 'next') window.steps++;
        else window.submits++;
      });
    });
    const chrome = {
      runtime: { onMessage: event(), connectNative: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {} }) },
      tabs: { onRemoved: event(), onUpdated: event(), get: async () => ({ id: 7, url: 'https://example.com/application' }) },
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
    const settings = { baseUrl: 'https://provider.example/v1', model: 'fixture', browserTools: true, accessMode: 'full' };
    const rounds = [
      [call('focus', 'click', { tabId: 7, selector: 'placeholder="Business name"' }),
        call('company', 'fill', { tabId: 7, selector: '#company', value: 'Example LLC' })],
      [call('website-focus', 'click', { tabId: 7, selector: 'role=textbox[name="Website URL"]' }),
        call('website', 'fill', { tabId: 7, selector: '#website', value: 'https://example.com' })],
      [call('dropdown', 'click', { tabId: 7, selector: 'role=combobox[name="Country"]' }),
        call('country', 'click', { tabId: 7, selector: 'role=option[name="Namibia"]' })],
      [call('step', 'browser_step', { tabId: 7, actions: [], clickSelector: '#next' })],
      [call('prepare', 'browser_step', { tabId: 7, actions: [
        { action: 'fill', selector: '#company', value: 'Verified LLC' },
        { action: 'fill', selector: 'placeholder="Notes"', value: 'Prepared for review' }
      ], clickSelector: '.neutral > span', waitForSelector: '#confirmation', timeoutMs: 50, __submissionHold: false })],
      [call('verify', 'form_verify', { tabId: 7, fields: [
        { selector: '#company', value: 'Verified LLC' }, { selector: '#website', value: 'https://example.com' }
      ] })]
    ];
    const outputs = [];
    let round = 0;
    const transcript = await run({ settings, history: [], prompt: 'Fill this form. Do not submit it.',
      executeTool: async (name, args) => { const result = await tool(name, args); outputs.push({ name, result }); return result; },
      onEvent() {}, fetchImpl: async () => response(round < rounds.length ? { content: null, tool_calls: rounds[round++] } : { content: 'Filled and verified for your review.' })
    });
    assert.equal(await page.locator('#company').inputValue(), 'Verified LLC');
    assert.equal(await page.locator('#website').inputValue(), 'https://example.com');
    assert.equal(await page.locator('textarea').inputValue(), 'Prepared for review');
    assert.equal(await page.locator('[role=combobox]').textContent(), 'Namibia');
    assert.equal(await page.evaluate(() => window.steps), 1, 'Intermediate Continue remains available');
    assert.equal(await page.evaluate(() => window.submits), 0, 'The final button never receives a click');
    const prepared = outputs.find(item => item.result.submissionBlocked)?.result;
    assert.equal(prepared.completed, true, 'Completed field entry must not be reported as a failed batch');
    assert.equal(prepared.click.skipped, true);
    assert.equal(prepared.waitFailed, undefined, 'Do not wait for confirmation after skipping submission');
    assert.equal(outputs.at(-1).result.verified, true);
    assert.ok(!transcript.some(item => item.role === 'tool' && /Actions failed three/.test(item.content || '')));

    const held = submissionPermissionGuard([], "Don't submit");
    for (const selector of ['.neutral', '#js-final']) {
      await assert.rejects(tool('click', held.dispatchArgs('click', { tabId: 7, selector })), /Submission blocked/);
    }
    assert.equal(await page.evaluate(() => window.submits), 0);
    let snapshot = await tool('read_page', { tabId: 7 });
    const field = snapshot.elements.find(el => el.selector === '#company');
    await tool('click', held.dispatchArgs('click', { tabId: 7, selector: field.ref }));
    // The allowed click refreshes observation references; inspect again before the next action.
    snapshot = await tool('read_page', { tabId: 7 });
    const final = snapshot.elements.find(el => el.selector === '#js-final');
    await assert.rejects(tool('click', held.dispatchArgs('click', { tabId: 7, selector: final.ref })), /Submission blocked/);
    snapshot = await tool('read_page', { tabId: 7 });
    const child = snapshot.elements.find(el => el.frameId === 1 && el.type === 'submit');
    await assert.rejects(tool('click', held.dispatchArgs('click', { tabId: 7, selector: child.ref })), /Submission blocked/);
    const childInput = snapshot.elements.find(el => el.frameId === 1 && el.tag === 'input');
    const childStep = await tool('browser_step', held.dispatchArgs('browser_step', { tabId: 7,
      actions: [{ action: 'fill', frameId: 1, selector: childInput.selector, value: 'Child company' }], clickRef: child.ref
    }));
    assert.equal(childStep.completed, true);
    assert.equal(childStep.click.skipped, true);
    assert.equal(await page.frames()[1].locator('input').inputValue(), 'Child company');

    // An input's Enter may submit; Enter in a combobox only chooses an option.
    worker.keyCalls = 0;
    vm.runInContext('pressKey = async () => { keyCalls++; return { pressed: true }; }', worker);
    await page.locator('#company').focus();
    await assert.rejects(tool('press_key', held.dispatchArgs('press_key', { tabId: 7, key: 'Enter' })), /Submission blocked/);
    await page.locator('[role=combobox]').focus();
    await tool('press_key', held.dispatchArgs('press_key', { tabId: 7, key: 'Enter' }));
    assert.equal(worker.keyCalls, 1);

    // Without a user restriction, the same final control works normally.
    let normalRound = 0;
    await run({ settings, history: [], prompt: 'Submit this application now.', onEvent() {}, executeTool: tool,
      fetchImpl: async () => response(normalRound++ === 0 ? { content: null,
        tool_calls: [call('authorized', 'click', { tabId: 7, selector: '.neutral' })] } : { content: 'Done.' })
    });
    assert.equal(await page.evaluate(() => window.submits), 1);
    console.log('Real Chrome: unrestricted submission works; explicit hold permits semantic field focus, typing, dropdowns, Continue and verification, while blocking final submission.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
