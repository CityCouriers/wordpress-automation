'use strict';

// Pliki jakości mutacji (#253): .quality/mutation-baseline.json (tylko mutanty równoważne) i
// .quality/mutation-tests.json (plik źródłowy -> pliki testów). Walidatory mają negatywne kontrole.
const { test } = require('node:test');
require('./helpers/exit-guard.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateBaseline } = require('../scripts/mutation/baseline.js');
const { buildTestsMap, validateTestsMap } = require('../scripts/mutation/tests-map.js');

const ROOT = path.resolve(__dirname, '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const SOURCES = fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.gs')).sort();
const TEST_FILES = fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js'));

const ENTRY = {
  file: 'Payloads.gs', function: 'foo_', before: 'return a || b;', after: 'return a && b;',
  reason: 'Obie gałęzie dają ten sam wynik dla wszystkich wejść funkcji.', approval: 'https://github.com/CityCouriers/wordpress-automation/pull/1'
};

test('baza mutantów równoważnych w repo jest poprawna i na starcie pusta', () => {
  const baseline = readJson('.quality/mutation-baseline.json');
  assert.deepEqual(validateBaseline(baseline), []);
  assert.deepEqual(baseline.equivalent, []);
});

test('baza: poprawny wpis przechodzi (pozytywna kontrola)', () => {
  assert.deepEqual(validateBaseline({ version: 1, equivalent: [ENTRY] }), []);
  assert.deepEqual(validateBaseline({ version: 1, equivalent: [ENTRY, { ...ENTRY, after: 'return a;' }] }), []);
  assert.deepEqual(validateBaseline({ version: 1, equivalent: [{ ...ENTRY, approval: 'https://github.com/CityCouriers/wordpress-automation/issues/7#issuecomment-1' }] }), []);
});

test('baza: każde odstępstwo od schematu jest błędem', () => {
  const bad = (baseline, pattern) => assert.match(validateBaseline(baseline).join('\n'), pattern);
  bad(null, /nie jest obiektem/);
  bad([], /nie jest obiektem/);
  bad('x', /nie jest obiektem/);
  bad({ version: 2, equivalent: [] }, /version musi wynosić 1/);
  bad({ version: 1 }, /equivalent musi być tablicą/);
  bad({ version: 1, equivalent: {} }, /equivalent musi być tablicą/);
  bad({ version: 1, equivalent: [null] }, /equivalent\[0\]: wpis nie jest obiektem/);
  for (const field of ['file', 'function', 'before', 'after', 'reason', 'approval']) {
    bad({ version: 1, equivalent: [{ ...ENTRY, [field]: '' }] }, new RegExp(`brak pola ${field}`));
    bad({ version: 1, equivalent: [{ ...ENTRY, [field]: '  ' }] }, new RegExp(`brak pola ${field}`));
    const missing = { ...ENTRY };
    delete missing[field];
    bad({ version: 1, equivalent: [missing] }, new RegExp(`brak pola ${field}`));
    bad({ version: 1, equivalent: [{ ...ENTRY, [field]: 5 }] }, new RegExp(`brak pola ${field}`));
  }
  bad({ version: 1, equivalent: [{ ...ENTRY, extra: 1 }] }, /nieznane pole extra/);
  bad({ version: 1, equivalent: [{ ...ENTRY, file: '../x.gs' }] }, /file musi być nazwą pliku z src\//);
  bad({ version: 1, equivalent: [{ ...ENTRY, file: 'x.js' }] }, /file musi być nazwą/);
  bad({ version: 1, equivalent: [{ ...ENTRY, approval: 'https://example.com/pull/1' }] }, /approval musi wskazywać/);
  bad({ version: 1, equivalent: [{ ...ENTRY, approval: 'https://github.com/CityCouriers/inne/pull/1' }] }, /approval musi wskazywać/);
  bad({ version: 1, equivalent: [{ ...ENTRY, approval: 'zatwierdzone' }] }, /approval musi wskazywać/);
  bad({ version: 1, equivalent: [{ ...ENTRY, after: ENTRY.before }] }, /before i after są takie same/);
  bad({ version: 1, equivalent: [ENTRY, { ...ENTRY, reason: 'inne' }] }, /equivalent\[1\]: duplikat klucza/);
  assert.deepEqual(validateBaseline({ version: 1, equivalent: [ENTRY, { ...ENTRY, file: 'Kod.gs' }, { ...ENTRY, function: 'bar_' }, { ...ENTRY, before: 'x' }] }), []);
});

test('mapa testów w repo jest poprawna: klucze to pliki src, testy istnieją', () => {
  const map = readJson('.quality/mutation-tests.json');
  assert.deepEqual(validateTestsMap(map, { sources: SOURCES, testFiles: TEST_FILES }), []);
  assert.ok(Object.values(map.tests).some(list => list.length > 0), 'mapa nie może być pusta');
  assert.ok(map.tests['Payloads.gs'].includes('payloads.test.js'));
});

test('buildTestsMap: z mapy pokrycia, posortowana, brakujące pliki dostają pustą listę', () => {
  const coverage = { bySource: { 'B.gs': ['z.test.js', 'a.test.js'], 'A.gs': ['m.test.js'], 'Obcy.gs': ['x.test.js'] } };
  const map = buildTestsMap(coverage, ['C.gs', 'B.gs', 'A.gs']);
  assert.deepEqual(map, { version: 1, tests: { 'A.gs': ['m.test.js'], 'B.gs': ['a.test.js', 'z.test.js'], 'C.gs': [] } });
  assert.deepEqual(Object.keys(map.tests), ['A.gs', 'B.gs', 'C.gs']);
  const input = ['z.test.js', 'a.test.js'];
  buildTestsMap({ bySource: { 'B.gs': input } }, ['B.gs']);
  assert.deepEqual(input, ['z.test.js', 'a.test.js']);
});

test('mapa testów: każde odstępstwo jest błędem', () => {
  const ctx = { sources: ['A.gs', 'B.gs'], testFiles: ['a.test.js', 'b.test.js'] };
  const ok = { version: 1, tests: { 'A.gs': ['a.test.js'], 'B.gs': [] } };
  assert.deepEqual(validateTestsMap(ok, ctx), []);
  const bad = (map, pattern) => assert.match(validateTestsMap(map, ctx).join('\n'), pattern);
  bad(null, /version 1/);
  bad({ version: 2, tests: {} }, /version 1/);
  bad({ version: 1 }, /version 1/);
  bad({ version: 1, tests: null }, /version 1/);
  bad({ version: 1, tests: { 'A.gs': [] } }, /brak wpisu dla B\.gs/);
  bad({ ...ok, tests: { ...ok.tests, 'Obcy.gs': [] } }, /Obcy\.gs: nie ma takiego pliku w src\//);
  bad({ ...ok, tests: { ...ok.tests, 'A.gs': 'a.test.js' } }, /A\.gs: lista testów nie jest tablicą/);
  bad({ ...ok, tests: { ...ok.tests, 'A.gs': ['nie-ma.test.js'] } }, /A\.gs: nie ma testu nie-ma\.test\.js/);
  bad({ ...ok, tests: { ...ok.tests, 'A.gs': ['repo-identity.test.js'] } }, /nie może oceniać mutantów/);
  bad({ ...ok, tests: { ...ok.tests, 'A.gs': ['a.test.js', 'a.test.js'] } }, /powtórzenia/);
  bad({ ...ok, tests: { ...ok.tests, 'A.gs': ['b.test.js', 'a.test.js'] } }, /nie jest posortowana/);
});
