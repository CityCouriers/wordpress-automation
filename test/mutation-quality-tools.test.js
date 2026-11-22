'use strict';

// Pliki jakości mutacji (#253), część 2: dokładne komunikaty walidatorów, adres zatwierdzenia i polecenia CLI
// baseline.js oraz tests-map.js (na drzewie tymczasowym, z kopią skryptu, żeby sprawdzić korzeń liczony od skryptu).
const { test } = require('node:test');
require('./helpers/exit-guard.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateBaseline, main: baselineMain } = require('../scripts/mutation/baseline.js');
const { validateTestsMap, main: testsMapMain } = require('../scripts/mutation/tests-map.js');

const SCRIPTS = path.resolve(__dirname, '..', 'scripts', 'mutation');
const BASE = 'https://github.com/CityCouriers/wordpress-automation';
const ENTRY = {
  file: 'Payloads.gs', function: 'foo_', before: 'return a || b;', after: 'return a && b;',
  reason: 'Obie gałęzie dają ten sam wynik dla wszystkich wejść funkcji.', approval: `${BASE}/pull/1`
};
const FIELDS = ['file', 'function', 'before', 'after', 'reason', 'approval'];
const wrap = entry => ({ version: 1, equivalent: [entry] });

test('baza: dokładne komunikaty dla brakujących i nieprawidłowych pól', () => {
  assert.deepEqual(validateBaseline({ version: 2, equivalent: [] }), ['version musi wynosić 1']);
  assert.deepEqual(validateBaseline({ version: 2 }), ['version musi wynosić 1', 'equivalent musi być tablicą']);
  assert.deepEqual(validateBaseline({ version: 1, equivalent: [null] }), ['equivalent[0]: wpis nie jest obiektem']);
  assert.deepEqual(validateBaseline({ version: 1, equivalent: ['x', 7] }), ['equivalent[0]: wpis nie jest obiektem', 'equivalent[1]: wpis nie jest obiektem']);
  assert.deepEqual(validateBaseline(wrap({})), FIELDS.map(f => `equivalent[0]: brak pola ${f}`));
  assert.deepEqual(validateBaseline(wrap({ ...ENTRY, file: 'x.js', approval: 'x', after: ENTRY.before })), [
    'equivalent[0]: file musi być nazwą pliku z src/',
    'equivalent[0]: approval musi wskazywać PR lub zgłoszenie tego repozytorium',
    'equivalent[0]: before i after są takie same (to nie jest mutacja)'
  ]);
  assert.deepEqual(validateBaseline({ version: 1, equivalent: [ENTRY, { ...ENTRY, reason: 'inne' }] }), ['equivalent[1]: duplikat klucza']);
  assert.deepEqual(validateBaseline(wrap({ ...ENTRY, extra: 1, tajne: 2 })), ['equivalent[0]: nieznane pole extra', 'equivalent[0]: nieznane pole tajne']);
});

test('baza: klucz duplikatu rozróżnia granice pól (sklejenie napisów nie jest duplikatem)', () => {
  const a = { ...ENTRY, function: 'b', before: 'cd', after: 'e' };
  const b = { ...ENTRY, function: 'bc', before: 'd', after: 'e' };
  assert.deepEqual(validateBaseline({ version: 1, equivalent: [a, b] }), []);
});

test('baza: adres zatwierdzenia ma dokładny kształt (PR albo zgłoszenie, numer, opcjonalny fragment)', () => {
  const good = [`${BASE}/pull/12`, `${BASE}/issues/3`, `${BASE}/pull/12#discussion_r5`, `${BASE}/issues/3#issuecomment-99`];
  const bad = [`x ${BASE}/pull/12`, `${BASE}/pull/12 x`, `${BASE}/pull/x`, `${BASE}/pulls/12`, `${BASE}/pull/12#`, `${BASE}/pull/12#a b`, `${BASE}/pull/12/files`,
    'http://github.com/CityCouriers/wordpress-automation/pull/12', `${BASE}x/pull/12`, 'https://xgithub.com/CityCouriers/wordpress-automation/pull/12', `${BASE}/pull/`];
  for (const approval of good) assert.deepEqual(validateBaseline(wrap({ ...ENTRY, approval })), [], approval);
  for (const approval of bad) assert.equal(validateBaseline(wrap({ ...ENTRY, approval })).length, 1, approval);
  for (const file of ['Payloads.gs', 'A1.gs']) assert.deepEqual(validateBaseline(wrap({ ...ENTRY, file })), [], file);
  for (const file of ['x.gs.js', 'a b.gs', '.gs', 'xx.gsx', 'a/b.gs']) assert.equal(validateBaseline(wrap({ ...ENTRY, file })).length, 1, file);
});

function makeRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-q-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

test('baseline main: czyta .quality/mutation-baseline.json z korzenia, wypisuje błędy i kończy 0 albo 1', () => {
  const good = makeRoot({ '.quality/mutation-baseline.json': '{"version":1,"equivalent":[]}' });
  const bad = makeRoot({ '.quality/mutation-baseline.json': '{"version":3,"equivalent":[]}' });
  try {
    const run = root => {
      const calls = { error: [], exit: [] };
      baselineMain({ root, error: e => calls.error.push(e), exit: c => calls.exit.push(c) });
      return calls;
    };
    assert.deepEqual(run(good), { error: [], exit: [0] });
    assert.deepEqual(run(bad), { error: ['version musi wynosić 1'], exit: [1] });
  } finally {
    cleanup(good, bad);
  }
});

test('baseline CLI: korzeń liczony od położenia skryptu; błędna baza daje kod 1 i komunikat', () => {
  const root = makeRoot({ '.quality/mutation-baseline.json': '{"version":3,"equivalent":[]}' });
  try {
    fs.mkdirSync(path.join(root, 'scripts', 'mutation'), { recursive: true });
    const script = path.join(root, 'scripts', 'mutation', 'baseline.js');
    fs.copyFileSync(path.join(SCRIPTS, 'baseline.js'), script);
    fs.copyFileSync(path.join(SCRIPTS, 'repo-root.js'), path.join(root, 'scripts', 'mutation', 'repo-root.js'));
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, 'version musi wynosić 1\n');
    fs.writeFileSync(path.join(root, '.quality', 'mutation-baseline.json'), '{"version":1,"equivalent":[]}');
    const ok = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.equal(ok.stderr, '');
  } finally {
    cleanup(root);
  }
});

const TREE = {
  'src/A.gs': '', 'src/B.gs': '', 'src/notatka.txt': '', 'test/a.test.js': '', 'test/b.test.js': '', 'test/pomocnik.js': '', 'test/dane.test.json': '',
  'reports/mutation/coverage-map.json': JSON.stringify({ bySource: { 'B.gs': ['b.test.js', 'a.test.js'], 'A.gs': ['a.test.js'], 'Obcy.gs': ['z.test.js'] } })
};

function runTestsMap(root, command) {
  const calls = { error: [], exit: [] };
  testsMapMain(['node', 'tests-map.js', command], { root, error: e => calls.error.push(e), exit: c => calls.exit.push(c) });
  return calls;
}

test('tests-map main write: zapisuje mapę z mapy pokrycia (źródła z src/, posortowane, wcięcie 2, końcowy newline)', () => {
  const root = makeRoot(TREE);
  try {
    assert.deepEqual(runTestsMap(root, 'write'), { error: [], exit: [] });
    assert.deepEqual(runTestsMap(root, 'write'), { error: [], exit: [] }, 'drugi zapis przy istniejącym .quality');
    const written = fs.readFileSync(path.join(root, '.quality', 'mutation-tests.json'), 'utf8');
    assert.equal(written, `${JSON.stringify({ version: 1, tests: { 'A.gs': ['a.test.js'], 'B.gs': ['a.test.js', 'b.test.js'] } }, null, 2)}\n`);
  } finally {
    cleanup(root);
  }
});

test('tests-map main check: poprawna mapa kończy 0, błędna wypisuje komunikaty i kończy 1', () => {
  const root = makeRoot({ ...TREE, '.quality/mutation-tests.json': JSON.stringify({ version: 1, tests: { 'A.gs': ['a.test.js'], 'B.gs': ['b.test.js'] } }) });
  const broken = makeRoot({ ...TREE, '.quality/mutation-tests.json': JSON.stringify({ version: 1, tests: { 'A.gs': ['b.test.js', 'a.test.js'], 'B.gs': ['pomocnik.js'] } }) });
  try {
    assert.deepEqual(runTestsMap(root, 'check'), { error: [], exit: [0] });
    assert.deepEqual(runTestsMap(broken, 'check'), { error: ['A.gs: lista testów nie jest posortowana', 'B.gs: nie ma testu pomocnik.js'], exit: [1] });
    assert.deepEqual(runTestsMap(root, 'cokolwiek'), { error: [], exit: [0] }, 'każde polecenie inne niż write to kontrola');
  } finally {
    cleanup(root, broken);
  }
});

test('tests-map CLI: write i check na drzewie z własnymi plikami skryptu (korzeń od położenia skryptu)', () => {
  const root = makeRoot(TREE);
  try {
    fs.mkdirSync(path.join(root, 'scripts', 'mutation'), { recursive: true });
    for (const f of ['tests-map.js', 'tests-list.js', 'repo-root.js']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(root, 'scripts', 'mutation', f));
    const script = path.join(root, 'scripts', 'mutation', 'tests-map.js');
    assert.equal(spawnSync(process.execPath, [script, 'write'], { encoding: 'utf8' }).status, 0);
    assert.ok(fs.existsSync(path.join(root, '.quality', 'mutation-tests.json')));
    const check = spawnSync(process.execPath, [script, 'check'], { encoding: 'utf8' });
    assert.equal(check.status, 0);
    assert.equal(check.stderr, '');
    fs.writeFileSync(path.join(root, '.quality', 'mutation-tests.json'), '{"version":2}');
    const broken = spawnSync(process.execPath, [script, 'check'], { encoding: 'utf8' });
    assert.equal(broken.status, 1);
    assert.equal(broken.stderr, 'mapa nie ma version 1 i obiektu tests\n');
  } finally {
    cleanup(root);
  }
});

test('tests-map: dokładne komunikaty walidacji', () => {
  const ctx = { sources: ['A.gs', 'B.gs'], testFiles: ['a.test.js', 'b.test.js', 'repo-identity.test.js', 'mutation-x.test.js'] };
  assert.deepEqual(validateTestsMap({ version: 1, tests: { 'A.gs': [] } }, ctx), ['brak wpisu dla B.gs']);
  assert.deepEqual(validateTestsMap({ version: 1, tests: { 'A.gs': [], 'B.gs': [], 'C.gs': [] } }, ctx), ['C.gs: nie ma takiego pliku w src/']);
  assert.deepEqual(validateTestsMap({ version: 1, tests: { 'A.gs': 'x', 'B.gs': [] } }, ctx), ['A.gs: lista testów nie jest tablicą']);
  assert.deepEqual(validateTestsMap({ version: 1, tests: { 'A.gs': ['repo-identity.test.js'], 'B.gs': ['mutation-x.test.js'] } }, ctx), [
    'A.gs: repo-identity.test.js nie może oceniać mutantów (skanuje repozytorium albo testuje sam potok mutacji)',
    'B.gs: mutation-x.test.js nie może oceniać mutantów (skanuje repozytorium albo testuje sam potok mutacji)'
  ]);
  assert.deepEqual(validateTestsMap({ version: 1, tests: { 'A.gs': ['brak.test.js'], 'B.gs': [] } }, ctx), ['A.gs: nie ma testu brak.test.js']);
  assert.deepEqual(validateTestsMap({ version: 1, tests: { 'A.gs': ['a.test.js', 'a.test.js'], 'B.gs': [] } }, ctx), ['A.gs: powtórzenia na liście testów']);
  assert.deepEqual(validateTestsMap({ version: 1, tests: { 'A.gs': ['b.test.js', 'a.test.js'], 'B.gs': [] } }, ctx), ['A.gs: lista testów nie jest posortowana']);
  assert.deepEqual(validateTestsMap({ version: 1, tests: null }, ctx), ['mapa nie ma version 1 i obiektu tests']);
});
