const assert = require('node:assert/strict');
const { Observations } = require('../extensions/chrome/page-observations.js');
const { Collector } = require('../extensions/chrome/browser-diagnostics.js');
const { Recipes } = require('../extensions/chrome/action-recipes.js');
const { evaluateTaskCriteria, extractEvidence } = require('../extensions/chrome/completion-judge.js');
const page = (text = 'First page', documentId = 'doc1', ref = '@e123') => ({ title: 'Form', url: 'https://example.com/form', documentId,
  text, frames: [{ frameId: 0, documentId, text }], elements: [{ ref, selector: '#name', frameId: 0, tag: 'input', type: 'text', label: 'Name', value: '' }] });
(async () => {
  const observations = new Observations();
  const first = observations.capture(1, page());
  const unchanged = observations.capture(1, page(undefined, undefined, '@e999'), { sinceSnapshotId: first.snapshotId });
  assert.equal(unchanged.mode, 'delta'); assert.equal(unchanged.changed, false);
  assert.equal(unchanged.elements[0].ref, '@e999'); assert.equal(unchanged.text, undefined);
  const second = observations.capture(1, page('First revised page'), { sinceSnapshotId: unchanged.snapshotId });
  const patch = second.textPatch;
  assert.equal('First page'.slice(0, patch.start) + patch.insert + 'First page'.slice(patch.start + patch.deleteCount), 'First revised page');
  assert.equal(second.changed, true);
  const fieldPage = page('First revised page'); fieldPage.elements[0].value = 'Alex';
  assert.equal(observations.capture(1, fieldPage, { sinceSnapshotId: second.snapshotId }).changed, true);
  assert.equal(observations.capture(1, page('Replacement', 'doc2'), { sinceSnapshotId: second.snapshotId }).baselineMissing, true);
  const scoped = observations.capture(1, page(), { selector: '#main' });
  assert.equal(observations.capture(1, page(), { sinceSnapshotId: scoped.snapshotId }).mode, 'full');
  for (let i = 2; i < 40; i++) observations.capture(i, page());
  assert.equal(observations.tabs.size, 32); assert.equal(observations.capture(1, page(), { sinceSnapshotId: scoped.snapshotId }).baselineMissing, true);

  const collector = new Collector(3);
  collector.event('Network.requestWillBeSent', { requestId: 'ignored', request: { url: 'https://example.com' } });
  assert.equal(collector.network.size, 0);
  collector.active = true;
  collector.event('Network.requestWillBeSent', { requestId: '1', request: { url: 'https://user:secret@example.com/path?token=secret#hash', method: 'GET', headers: { authorization: 'secret' }, postData: 'secret' } });
  collector.event('Network.responseReceived', { requestId: '1', response: { status: 500, url: 'https://example.com/path?token=secret' } });
  collector.event('Network.loadingFinished', { requestId: '1', encodedDataLength: 14 });
  assert.equal(collector.read({ failuresOnly: true }).network[0].status, 500);
  assert.ok(!JSON.stringify(collector.read()).includes('secret'));
  collector.event('Page.navigatedWithinDocument', {}); assert.equal(collector.network.size, 1);
  collector.event('Page.frameNavigated', { frame: { id: 'child', parentId: 'main' } }); assert.equal(collector.network.size, 1);
  collector.event('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'TypeError' } } });
  assert.equal(collector.read().console[0].level, 'error');
  for (let i = 0; i < 6; i++) collector.event('Network.requestWillBeSent', { requestId: String(i), request: { url: 'https://example.com' } });
  assert.equal(collector.network.size, 3);
  collector.event('Page.frameNavigated', { frame: { id: 'main' } }); assert.equal(collector.network.size, 0); assert.equal(collector.console.length, 0);
  collector.event('Network.requestWillBeSent', { requestId: 'navigation', loaderId: 'new', request: { url: 'https://example.com' } });
  collector.event('Page.frameNavigated', { frame: { id: 'main', loaderId: 'new' } });
  assert.equal(collector.network.size, 1);

  const state = {};
  const storage = { get: async key => ({ [key]: state[key] }), set: async data => Object.assign(state, structuredClone(data)) };
  const recipes = new Recipes(storage);
  await recipes.save({ name: 'contact', actions: [{ action: 'fill', selector: '#name', value: '{{name}}' }] }, page());
  const actions = await recipes.resolve('contact', { name: 'Alex' }, page());
  assert.equal(actions[0].selector, '@e123'); assert.equal(actions[0].value, 'Alex');
  assert.ok(!JSON.stringify(state).includes('Alex'));
  // Placeholder requirements come from the actions, even if saved metadata is damaged.
  state.omniActionRecipes.contact.variables = [];
  await assert.rejects(recipes.resolve('contact', {}, page()), /Missing text input/);
  await assert.rejects(recipes.save({ name: '__proto__', actions: [{ action: 'fill', selector: '#name', value: '{{name}}' }] }, page()), /different recipe name/);
  await assert.rejects(recipes.save({ name: 'invalid', actions: [null] }, page()), /Malformed/);
  state.omniActionRecipes.broken = null;
  assert.equal((await recipes.list(page().url)).length, 1);
  await assert.rejects(recipes.save({ name: 'secret', actions: [{ action: 'fill', selector: '#name', value: 'personal data' }] }, page()), /variable/);
  await assert.rejects(recipes.save({ name: 'click', actions: [{ action: 'click', selector: '#name' }] }, page()), /field edits/);
  await assert.rejects(recipes.resolve('contact', {}, page()), /Missing/);
  const changed = page(); changed.elements = []; await assert.rejects(recipes.resolve('contact', { name: 'Alex' }, changed), /changed/);
  await assert.rejects(recipes.resolve('contact', { name: 'Alex' }, { ...page(), url: 'https://other.example/form' }), /No recipe/);
  const password = page(); password.elements[0].type = 'password';
  await assert.rejects(recipes.save({ name: 'password', actions: [{ action: 'fill', selector: '#name', value: '{{name}}' }] }, password), /non-sensitive/);
  state.omniActionRecipes.contact.actions[0].action = 'click';
  await assert.rejects(recipes.resolve('contact', { name: 'Alex' }, page()), /Invalid stored recipe/);

  const criteria = [{ kind: 'text', text: 'Receipt accepted' }, { kind: 'download', id: 1 }];
  let verdict = evaluateTaskCriteria({ criteria, page: { text: 'Receipt accepted' }, downloads: [{ id: 1, state: 'in_progress', verified: false }] });
  assert.equal(verdict.verified, false); assert.equal(verdict.checks[1].state, 'unknown');
  verdict = evaluateTaskCriteria({ criteria, page: { text: 'Receipt accepted' }, downloads: [{ id: 1, state: 'complete', verified: true }] });
  assert.equal(verdict.verified, true);
  const duplicate = evaluateTaskCriteria({ criteria: [
    { kind: 'field', selector: '#name', value: 'Alex' },
    { kind: 'field', selector: '#name', value: 'Other' }
  ], fields: [{ selector: '#name', value: 'Alex', matches: true }] });
  assert.equal(duplicate.checks[0].state, 'verified');
  assert.equal(duplicate.checks[1].state, 'failed');
  assert.equal(duplicate.verified, false);
  assert.throws(() => evaluateTaskCriteria({ criteria: [{ kind: 'checked', selector: '#name' }] }), /expected value/);
  assert.equal(evaluateTaskCriteria({ criteria: [{ kind: 'text', text: 'Missing' }], page: { text: 'partial', textTruncated: true } }).checks[0].state, 'unknown');
  const fakeDownload = extractEvidence([{ tool: 'downloads_status', args: {}, result: { state: 'complete', verified: false }, index: 0 }]);
  assert.equal(fakeDownload.evidence.length, 0);
  console.log('Browser source adaptations passed: page deltas, diagnostics, recipes and live evidence gates.');
})().catch(error => { console.error(error); process.exitCode = 1; });
