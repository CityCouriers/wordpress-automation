'use strict';

// Testy kanarka mutacyjnego. Źródło czytamy jak harness testów projektu: przez src/MutationCanary.gs,
// które vm-preload.js przekierowuje na kopię cienia (.stryker-shadow/MutationCanary.js). Plik w src/ nie
// istnieje celowo: bez przekierowania odczyt kończy się ENOENT, więc zepsuty vm-preload.js daje czerwono
// już w przebiegu bez mutanta. Konteksty tworzymy przez vm.createContext, który preload uzupełnia o numer
// aktywnego mutanta; bez tego mutanty nigdy by się nie włączyły i kanarek by przeżył.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function load() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'MutationCanary.gs'), 'utf8'), context);
  return context;
}

test('canaryTotal_ mnoży cenę przez ilość', () => {
  const c = load();
  assert.equal(c.canaryTotal_(3, 4), 12);
  assert.equal(c.canaryTotal_(5, 1), 5);
});

test('canaryLabel_ zwraca oba warianty', () => {
  const c = load();
  assert.equal(c.canaryLabel_(true), 'tak');
  assert.equal(c.canaryLabel_(false), 'nie');
});

test('canaryJoin_ łączy części myślnikiem', () => {
  assert.equal(load().canaryJoin_('a', 'b'), 'a-b');
});
