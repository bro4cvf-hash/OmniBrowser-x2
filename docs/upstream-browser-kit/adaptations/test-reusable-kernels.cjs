'use strict';
const assert = require('node:assert/strict');
const { snapshotComparisonText, normalizeCachedActions } = require('./reusable-kernels.cjs');

// Upstream regression: IDs can change while meaningful page content stays equal.
const before = '- button "Save [ref=e3]" [ref=e1]\n- checkbox "Agree" [checked=false, ref=e2]';
const after = '- button "Save [ref=e3]" [ref=e20]\n- checkbox "Agree" [checked=false, ref=e21]';
const comparable = snapshotComparisonText(before);
assert.equal(comparable, snapshotComparisonText(after));
assert.ok(comparable.includes('Save [ref=e3]'));
assert.ok(comparable.includes('[checked=false]'));
assert.notEqual(comparable, snapshotComparisonText(after.replace('Agree', 'Agreed')));
assert.notEqual(comparable, snapshotComparisonText(after.replace('checked=false', 'checked=true')));
assert.equal(snapshotComparisonText('- button "Say \\"[ref=e3]\\"" [ref=e7]'), '- button "Say \\"[ref=e3]\\""');
assert.equal(snapshotComparisonText('- button "Keep" [ref=custom]'), '- button "Keep" [ref=custom]');
assert.equal(snapshotComparisonText('- button "Keep" [ref=e1\n'), '- button "Keep" [ref=e1\n');
assert.equal(snapshotComparisonText(''), '');

// Cache normalization must tolerate corrupt entries and preserve usable inputs.
assert.deepEqual(normalizeCachedActions({}), []);
assert.deepEqual(normalizeCachedActions([null, 9, {}, { selector: '' }]), []);
assert.deepEqual(normalizeCachedActions([
  { selector: '#name', description: 9, method: 'fill', arguments: ['Alex', 1, null] },
  { selector: '@e1', description: 'Continue', method: 9, arguments: {} },
]), [
  { selector: '#name', description: '', method: 'fill', arguments: ['Alex'] },
  { selector: '@e1', description: 'Continue', method: undefined, arguments: [] },
]);
console.log('Reusable source kernels: 12 regression assertions passed.');
