'use strict';

// Testy logiki potoku mutacji .gs (#253): klasyfikacja killed-assert, kanarek, dobór testów, argumenty,
// kontrola zerowa, podsumowanie, allowlista środowiska. Nie uruchamiają Strykera ani mutantów.
const { test } = require('node:test');
require('./helpers/exit-guard.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { classifyMutant, classifyReport, main: classifyMain, PROGRAM_ERROR } = require('../scripts/mutation/classify.js');
const { canaryVerdict, MIN_MUTANTS } = require('../scripts/mutation/canary.js');
const { SUITES, buildSelection, selectionKinds } = require('../scripts/mutation/selection.js');
const { SKIP, isExcluded, listTests } = require('../scripts/mutation/tests-list.js');
const runFile = require('../scripts/mutation/run-file.js');
const trial = require('../scripts/mutation/trial.js');
const zero = require('../scripts/mutation/zero-check.js');
const validate = require('../scripts/mutation/validate-selection.js');
const { safeEnv, ALLOWED, PILOT } = require('../scripts/mutation/safe-env.js');
const { parseLcov, ranges } = require('../scripts/mutation/lcov.js');

const mutant = (id, status, over = {}) => ({ id, status, mutatorName: 'EqualityOperator', location: { start: { line: 10 + Number(id), column: 1 }, end: { line: 10 + Number(id), column: 9 } }, ...over });
const ASSERT_OUT = 'TAP\n  ✖ liczy sumę (3.2ms)\n  ✖ liczy sumę (1.0ms)\n  ✖ inny test (0.5ms)\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal';

// --- klasyfikacja -------------------------------------------------------------------------------

test('classify: zabity z AssertionError to killed-assert i niesie unikalne nazwy padających testów', () => {
  const r = classifyMutant(mutant('1', 'Killed', { statusReason: ASSERT_OUT }));
  assert.equal(r.status, 'killed-assert');
  assert.deepEqual(r.failing, ['liczy sumę', 'inny test']);
});

test('classify: zabity bez AssertionError (TypeError z kodu) to killed-other', () => {
  assert.equal(classifyMutant(mutant('1', 'Killed', { statusReason: 'TypeError: x is not a function' })).status, 'killed-other');
  assert.equal(classifyMutant(mutant('1', 'Killed')).status, 'killed-other');
});

test('classify: awaria preludium z AssertionError w tle nie liczy się do zabitych (każdy błąd programu)', () => {
  for (const err of ['ReferenceError: x is not defined', 'SyntaxError: zły token', 'RangeError: Maximum call stack', 'Error: Cannot find module \'x\'', 'ReferenceError: stryNS_9fa48 is not defined']) {
    const r = classifyMutant(mutant('1', 'Killed', { statusReason: `AssertionError\n${err}` }));
    assert.equal(r.status, 'killed-other', err);
  }
  assert.ok(PROGRAM_ERROR.test('stryker foo is not defined'));
});

test('classify: statusy niezabite zostają osobnymi kategoriami (Survived, Timeout, RuntimeError, CompileError, NoCoverage)', () => {
  for (const status of ['Survived', 'Timeout', 'RuntimeError', 'CompileError', 'NoCoverage', 'Ignored']) {
    assert.deepEqual(classifyMutant(mutant('1', status, { statusReason: ASSERT_OUT })), { status, failing: [] });
  }
});

test('classifyReport: liczby per status, wiersze z linią, id i mutatorem', () => {
  const report = { files: { 'A.js': { mutants: [mutant('1', 'Killed', { statusReason: ASSERT_OUT }), mutant('2', 'Survived'), mutant('3', 'Timeout')] }, 'B.js': { mutants: [mutant('4', 'Killed')] } } };
  const { counts, rows } = classifyReport(report);
  assert.deepEqual(counts, { 'killed-assert': 1, Survived: 1, Timeout: 1, 'killed-other': 1 });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { file: 'A.js', line: 11, id: '1', mutator: 'EqualityOperator', status: 'killed-assert', failing: ['liczy sumę', 'inny test'] });
  assert.equal(rows[3].file, 'B.js');
});

test('classify: nazwa padającego testu tylko z początku wiersza (z wcięciem), nie ze środka', () => {
  const r = classifyMutant(mutant('1', 'Killed', { statusReason: 'AssertionError\n   ✖ wciety (1.5ms)\nzaczyna się tekstem ✖ srodek (2.0ms)\n✖ bez wciecia (3ms)' }));
  assert.deepEqual(r.failing, ['wciety', 'bez wciecia']);
});

function runClassifyMain(argv, report) {
  const out = { log: [], error: [], exit: [], read: [] };
  classifyMain(argv, {
    read: f => { out.read.push(f); return JSON.stringify(report); },
    log: t => out.log.push(t), error: t => out.error.push(t), exit: c => out.exit.push(c)
  });
  return out;
}

test('classify main: domyślna ścieżka raportu, liczby, wynik i brak wyjścia przy ważnym pomiarze', () => {
  const report = { files: { 'A.js': { mutants: [mutant('1', 'Killed', { statusReason: ASSERT_OUT }), mutant('2', 'Killed', { statusReason: ASSERT_OUT }), mutant('3', 'Survived')] } } };
  const out = runClassifyMain(['node', 'classify.js'], report);
  assert.deepEqual(out.read, [path.join('reports', 'mutation', 'mutation.json')]);
  assert.deepEqual(out.log, ['{"killed-assert":2,"Survived":1}', 'wynik wg killed-assert: 2/3 = 66.7 %']);
  assert.deepEqual(out.error, []);
  assert.deepEqual(out.exit, []);
});

test('classify main: ścieżka z argumentu (dopiero od trzeciego miejsca, bez opcji) i lista wierszy', () => {
  const report = { files: { 'A.js': { mutants: [mutant('1', 'Killed', { statusReason: ASSERT_OUT })] } } };
  assert.deepEqual(runClassifyMain(['node', 'classify.js', 'inny.json'], report).read, ['inny.json']);
  assert.deepEqual(runClassifyMain(['node', 'klasyfikuj.json'], report).read, [path.join('reports', 'mutation', 'mutation.json')]);
  assert.deepEqual(runClassifyMain(['node', 'classify.js', '--list', 'po-opcji.json'], report).read, ['po-opcji.json']);
  const out = runClassifyMain(['node', 'classify.js', '--list'], report);
  assert.equal(out.log[1], 'killed-assert\tA.js:11\tid=1\tEqualityOperator\tliczy sumę ; inny test');
  assert.equal(runClassifyMain(['node', 'classify.js'], report).log.length, 2);
  const long = { files: { 'A.js': { mutants: [mutant('1', 'Killed', { statusReason: `AssertionError\n✖ ${'x'.repeat(150)} (1.0ms)` })] } } };
  assert.equal(runClassifyMain(['node', 'c.js', '--list'], long).log[1].split('\t')[4].length, 100);
});

test('classify main: brak zabitych z asercją => komunikat i kod 3, bez dalszych uwag', () => {
  const report = { files: { 'A.js': { mutants: [mutant('1', 'Killed'), mutant('2', 'Survived')] } } };
  const out = runClassifyMain(['node', 'classify.js'], report);
  assert.deepEqual(out.exit, [3]);
  assert.deepEqual(out.error, ['POMIAR NIEWAŻNY: brak zabitych z asercją (killed-assert).']);
  assert.equal(out.log[out.log.length - 1], 'wynik wg killed-assert: 0/2 = 0.0 %');
});

test('classify main: zabite bez asercji dają uwagę, a pomiar zostaje ważny', () => {
  const report = { files: { 'A.js': { mutants: [mutant('1', 'Killed', { statusReason: ASSERT_OUT }), mutant('2', 'Killed')] } } };
  const out = runClassifyMain(['node', 'classify.js'], report);
  assert.deepEqual(out.exit, []);
  assert.deepEqual(out.error, ['Uwaga: 1 zabitych bez asercji (killed-other) poza wynikiem; sprawdź ślad stosu.']);
});

// --- kanarek -----------------------------------------------------------------------------------

function canaryReport(statuses) {
  return { files: { 'MutationCanary.js': { mutants: statuses.map((s, i) => mutant(String(i), s, s === 'Killed' ? { statusReason: ASSERT_OUT } : {})) } } };
}

test('kanarek: wszystkie mutanty zabite z asercją i jest ich dość => ok', () => {
  const v = canaryVerdict(canaryReport(Array(MIN_MUTANTS).fill('Killed')));
  assert.equal(v.ok, true);
  assert.equal(v.counts['killed-assert'], MIN_MUTANTS);
});

test('kanarek: ocalały mutant, zabity bez asercji, przekroczenie czasu albo za mało mutantów => czerwono', () => {
  const full = Array(MIN_MUTANTS).fill('Killed');
  assert.equal(canaryVerdict(canaryReport([...full, 'Survived'])).ok, false);
  assert.match(canaryVerdict(canaryReport([...full, 'Survived'])).reason, /\d+ z \d+ mutantów zabitych z asercją/);
  assert.equal(canaryVerdict(canaryReport([...full, 'Timeout'])).ok, false);
  assert.equal(canaryVerdict(canaryReport(full.slice(1))).ok, false);
  assert.match(canaryVerdict(canaryReport(full.slice(1))).reason, new RegExp(`${MIN_MUTANTS - 1} mutantów, oczekiwano co najmniej ${MIN_MUTANTS}`));
  assert.equal(canaryVerdict(canaryReport([])).ok, false);
  const other = canaryReport(full);
  other.files['MutationCanary.js'].mutants[0].statusReason = 'TypeError: x';
  assert.equal(canaryVerdict(other).ok, false);
});

// --- dobór testów --------------------------------------------------------------------------------

const MAP = {
  baseline: { 'P.gs': [5] },
  tests: {
    'a.test.js': { exit: 0, sources: { 'P.gs': [10, 11, 12], 'Q.gs': [1] } },
    'b.test.js': { exit: 0, sources: { 'P.gs': [11, 20] } },
    'c.test.js': { exit: 0, sources: { 'Q.gs': [3] } }
  }
};
const MUT = [
  { id: 'm1', location: { start: { line: 10 }, end: { line: 10 } } },
  { id: 'm2', location: { start: { line: 11 }, end: { line: 11 } } },
  { id: 'm3', location: { start: { line: 5 }, end: { line: 5 } } },
  { id: 'm4', location: { start: { line: 99 }, end: { line: 99 } } },
  { id: 'm5', location: { start: { line: 19 }, end: { line: 21 } } }
];
const ALL = ['c.test.js', 'a.test.js', 'b.test.js'];

test('selection per-mutant: testy wykonujące linie mutanta, STATIC dla linii z bazy, pusta lista bez pokrycia', () => {
  const sel = buildSelection({ name: 'P.gs', mutants: MUT, suite: 'per-mutant', allTests: ALL, map: MAP });
  assert.deepEqual(sel.mutants, { m1: ['a.test.js'], m2: ['a.test.js', 'b.test.js'], m3: 'STATIC', m4: [], m5: ['b.test.js'] });
  assert.deepEqual(sel.covering, ['a.test.js', 'b.test.js']);
  assert.deepEqual(sel.all, ['a.test.js', 'b.test.js', 'c.test.js']);
  assert.equal(sel.source, 'P.gs');
  assert.deepEqual(selectionKinds(sel), { static: 1, none: 1, some: 3 });
});

test('selection per-mutant: plik bez wpisu w bazie i bez testów', () => {
  const sel = buildSelection({ name: 'Z.gs', mutants: MUT.slice(0, 1), suite: 'per-mutant', allTests: ALL, map: { baseline: {}, tests: MAP.tests } });
  assert.deepEqual(sel.mutants, { m1: [] });
  assert.deepEqual(sel.covering, []);
});

test('selection file: każdy mutant dostaje posortowaną listę testów pliku', () => {
  const sel = buildSelection({ name: 'P.gs', mutants: MUT.slice(0, 2), suite: 'file', allTests: ALL, fileTests: ['b.test.js', 'a.test.js'] });
  assert.deepEqual(sel.mutants, { m1: ['a.test.js', 'b.test.js'], m2: ['a.test.js', 'b.test.js'] });
  assert.deepEqual(sel.covering, ['a.test.js', 'b.test.js']);
  assert.deepEqual(buildSelection({ name: 'P.gs', mutants: MUT.slice(0, 1), suite: 'file', allTests: ALL }).mutants, { m1: [] });
});

test('selection full: każdy mutant dostaje ALL, a covering to wszystkie testy', () => {
  const sel = buildSelection({ name: 'P.gs', mutants: MUT.slice(0, 2), suite: 'full', allTests: ALL });
  assert.deepEqual(sel.mutants, { m1: 'ALL', m2: 'ALL' });
  assert.deepEqual(sel.covering, ['a.test.js', 'b.test.js', 'c.test.js']);
});

test('selection: nieznany zestaw to błąd, lista zestawów jest kompletna, wejście nie jest mutowane', () => {
  assert.throws(() => buildSelection({ name: 'P.gs', mutants: [], suite: 'losowy', allTests: ALL }), /Nieznany zestaw testów: losowy/);
  assert.deepEqual(SUITES, ['per-mutant', 'file', 'full']);
  const copy = [...ALL];
  buildSelection({ name: 'P.gs', mutants: MUT, suite: 'full', allTests: ALL });
  assert.deepEqual(ALL, copy);
});

test('tests-list: wszystkie testy poza skanującymi repozytorium, posortowane', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-list-'));
  fs.mkdirSync(path.join(dir, 'test'));
  for (const f of ['b.test.js', 'a.test.js', 'repo-identity.test.js', 'source-control-chars.test.js', 'mutation-tools.test.js', 'mutation-x.test.js', 'helper.js', 'x.test.json']) fs.writeFileSync(path.join(dir, 'test', f), '');
  assert.deepEqual(listTests(dir), ['a.test.js', 'b.test.js']);
  assert.deepEqual([...SKIP].sort(), ['repo-identity.test.js', 'source-control-chars.test.js']);
  assert.equal(isExcluded('mutation-isolation.test.js'), true);
  assert.equal(isExcluded('repo-identity.test.js'), true);
  assert.equal(isExcluded('mutation.test.js'), false);
  assert.equal(isExcluded('mutation-.test.js'), false);
  assert.equal(isExcluded('xmutation-a.test.js'), false);
  assert.equal(isExcluded('alerts.test.js'), false);
  // kolejność odczytu katalogu nie jest gwarantowana: lista ma być posortowana niezależnie od niej
  const original = fs.readdirSync;
  fs.readdirSync = () => ['z.test.js', 'm.test.js', 'a.test.js'];
  try {
    assert.deepEqual(listTests(dir), ['a.test.js', 'm.test.js', 'z.test.js']);
  } finally {
    fs.readdirSync = original;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- argumenty -----------------------------------------------------------------------------------

const argv = (...a) => ['node', 'x.js', ...a];

test('run-file parseArgs: domyślne wartości i poprawne opcje (także granice 1 i 0)', () => {
  assert.deepEqual(runFile.parseArgs(argv('Payloads.gs')), { name: 'Payloads.gs', stem: 'Payloads', suite: 'per-mutant', concurrency: 4, limit: 0, error: '' });
  assert.deepEqual(runFile.parseArgs(argv('Kod.gs', '--suite=full', '--concurrency=2', '--limit=30')), { name: 'Kod.gs', stem: 'Kod', suite: 'full', concurrency: 2, limit: 30, error: '' });
  assert.deepEqual(runFile.parseArgs(argv('Kod.gs', '--suite=file', '--concurrency=1', '--limit=0')), { name: 'Kod.gs', stem: 'Kod', suite: 'file', concurrency: 1, limit: 0, error: '' });
});

test('run-file parseArgs: błędne wywołania dają dokładny komunikat', () => {
  const usage = 'Podaj nazwę pliku z src/, np. WordPress.gs';
  for (const bad of [[], ['../Payloads.gs'], ['Payloads.js'], ['Pay loads.gs'], ['Payloads.gs\n'], ['Payloads.gsx'], ['x/Payloads.gs'], ['Payloads_gs'], ['.gs']]) {
    const parsed = runFile.parseArgs(argv(...bad));
    assert.equal(parsed.error, usage, bad.join(' '));
    assert.equal(parsed.stem, null);
  }
  assert.equal(runFile.parseArgs(argv('A.gs', '--suite=x')).error, 'Nieznany zestaw testów --suite=x (dozwolone: per-mutant, file, full)');
  for (const opt of ['--concurrency=0', '--concurrency=abc', '--concurrency=1.5', '--limit=-1', '--limit=x']) assert.equal(runFile.parseArgs(argv('A.gs', opt)).error, 'Nieprawidłowe --concurrency lub --limit', opt);
});

test('trial parseArgs: domyślne, opcje i ścieżki --outside tylko bezwzględne', () => {
  assert.deepEqual(trial.parseArgs(argv('Payloads.gs')), { name: 'Payloads.gs', stem: 'Payloads', suite: 'per-mutant', concurrency: 4, outside: [], error: '' });
  const ok = trial.parseArgs(argv('Kod.gs', '--suite=file', '--concurrency=2', '--outside=/a/b,/c'));
  assert.deepEqual([ok.suite, ok.concurrency, ok.outside, ok.error], ['file', 2, ['/a/b', '/c'], '']);
  assert.equal(trial.parseArgs(argv('Kod.gs', '--concurrency=1')).concurrency, 1);
  assert.equal(trial.parseArgs(argv('Kod.gs', '--concurrency=1')).error, '');
  assert.equal(trial.parseArgs(argv('Kod.gs', '--outside=/a,wzgledna')).error, '--outside przyjmuje tylko ścieżki bezwzględne');
  for (const bad of [[], ['Kod.gsx'], ['../Kod.gs'], ['Kod_gs'], ['.gs']]) {
    assert.equal(trial.parseArgs(argv(...bad)).error, 'Podaj nazwę pliku z src/, np. Payloads.gs', bad.join(' '));
    assert.equal(trial.parseArgs(argv(...bad)).stem, null);
  }
  assert.equal(trial.parseArgs(argv('A.gs', '--suite=zly')).error, 'Nieznany zestaw testów --suite=zly (dozwolone: per-mutant, file, full)');
  assert.equal(trial.parseArgs(argv('A.gs', '--concurrency=0')).error, 'Nieprawidłowe --concurrency');
  assert.equal(trial.parseArgs(argv('A.gs', '--concurrency=abc')).error, 'Nieprawidłowe --concurrency');
});

test('trial cleanRunArtifacts: usuwa reports, kopie cienia i katalog roboczy Strykera, resztę zostawia', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-clean-'));
  try {
    for (const dir of ['reports/mutation', '.stryker-shadow', '.stryker-tmp/sandbox-1', 'src']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of ['reports/mutation/index-X.json', '.stryker-shadow/X.js', '.stryker-tmp/sandbox-1/a', 'src/X.gs']) fs.writeFileSync(path.join(root, file), 'x');
    trial.cleanRunArtifacts(root);
    assert.deepEqual(fs.readdirSync(root), ['src']);
    assert.doesNotThrow(() => trial.cleanRunArtifacts(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('trial summarize i summaryMarkdown: liczby, wynik i czasy', () => {
  const report = { files: { 'P.js': { mutants: [mutant('1', 'Killed', { statusReason: ASSERT_OUT }), mutant('2', 'Killed', { statusReason: ASSERT_OUT }), mutant('3', 'Survived'), mutant('4', 'Timeout')] } } };
  const s = trial.summarize('P.gs', 'file', report, { indexSeconds: 3, runSeconds: 40, concurrency: 4 });
  assert.deepEqual(s, { file: 'P.gs', suite: 'file', mutants: 4, counts: { 'killed-assert': 2, Survived: 1, Timeout: 1 }, killedAssert: 2, score: 50, indexSeconds: 3, runSeconds: 40, concurrency: 4 });
  const md = trial.summaryMarkdown(s);
  assert.equal(md, [
    '## Próba mutacji: P.gs (zestaw testów: file)', '', '| Status | Liczba |', '| --- | ---: |',
    '| Survived | 1 |', '| Timeout | 1 |', '| killed-assert | 2 |', '',
    'Mutantów: 4; zabite z asercją: 2 (50 %).', 'Czas: indeks 3 s, przebieg 40 s, procesów Strykera: 4.', ''
  ].join('\n'));
  assert.equal(trial.summarize('E.gs', 'full', { files: { 'E.js': { mutants: [] } } }, {}).score, 0);
});

// --- kontrola zerowa -----------------------------------------------------------------------------

test('zero-check parseSummary: reporter spec i tap, brak podsumowania to null', () => {
  assert.deepEqual(zero.parseSummary('x\nℹ tests 1289\nℹ suites 3\nℹ pass 1288\nℹ fail 0\nℹ skipped 1\n'), { tests: 1289, pass: 1288, fail: 0 });
  assert.deepEqual(zero.parseSummary('# tests 5\n# pass 4\n# fail 1\n'), { tests: 5, pass: 4, fail: 1 });
  assert.equal(zero.parseSummary('ℹ tests 10\nℹ pass 10\n'), null);
  assert.equal(zero.parseSummary('ℹ tests x\n'), null);
  assert.equal(zero.parseSummary('ℹ tests 10 extra\nℹ pass 10\nℹ fail 0\n'), null);
  assert.equal(zero.parseSummary('xℹ tests 10\nℹ pass 10\nℹ fail 0\n'), null);
});

const run = (tests, pass, fail, status = 0) => ({ status, summary: { tests, pass, fail } });

test('zero-check parseSummary: bierze ostatnie podsumowanie, gdy wyjście ma kilka', () => {
  const text = 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n...\nℹ tests 20\nℹ pass 19\nℹ fail 1\n';
  assert.deepEqual(zero.parseSummary(text), { tests: 20, pass: 19, fail: 1 });
});

test('zero-check looksInstrumented: preludium Strykera i różnica względem oryginału', () => {
  const original = 'function a() { return 1; }';
  const instrumented = 'function stryNS_9fa48() {}\nfunction stryCov_9fa48() {}\nfunction a() { return 1; }';
  assert.equal(zero.looksInstrumented(instrumented, original), true);
  assert.equal(zero.looksInstrumented(original, original), false);
  assert.equal(zero.looksInstrumented(`${original} // __stryker__`, original), false);
  assert.equal(zero.looksInstrumented('function stryNS_9fa48() {}', original), false);
  assert.equal(zero.looksInstrumented('function stryCov_9fa48() {}', original), false);
  assert.equal(zero.looksInstrumented(original.replace('function', 'function stryNS_1() {} stryCov_1'), original), true);
  assert.equal(zero.looksInstrumented(`${original} stryNS_1 stryCov_1`, original), true);
  assert.equal(zero.looksInstrumented(null, original), false);
});

test('zero-check compareRuns: zgodne wyniki => ok z liczbą testów', () => {
  const v = zero.compareRuns(run(1289, 1289, 0), run(1289, 1289, 0), true);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'kod zinstrumentowany bez mutanta daje ten sam wynik: 1289 testów, 1289 zaliczonych, 0 porażek');
});

test('zero-check compareRuns: każde odstępstwo jest niezgodnością', () => {
  assert.match(zero.compareRuns(run(10, 10, 0), run(10, 10, 0), false).reason, /nie jest zinstrumentowany/);
  assert.match(zero.compareRuns(run(10, 10, 0), run(9, 9, 0), true).reason, /oryginalny 10\/10, zinstrumentowany 9\/9/);
  assert.equal(zero.compareRuns(run(10, 10, 0), run(10, 9, 0), true).reason, 'liczby testów się różnią: oryginalny 10/10, zinstrumentowany 10/9');
  assert.equal(zero.compareRuns(run(10, 10, 0), run(9, 10, 0), true).reason, 'liczby testów się różnią: oryginalny 10/10, zinstrumentowany 9/10');
  assert.match(zero.compareRuns(run(10, 10, 0, 1), run(10, 10, 0), true).reason, /kod oryginalny: kod wyjścia 1/);
  assert.match(zero.compareRuns(run(10, 9, 1), run(10, 10, 0), true).reason, /kod oryginalny: kod wyjścia 0, porażek 1/);
  assert.match(zero.compareRuns(run(10, 10, 0), run(10, 10, 0, null), true).reason, /kod zinstrumentowany: kod wyjścia null/);
  assert.match(zero.compareRuns(run(10, 10, 0), run(10, 9, 1), true).reason, /kod zinstrumentowany: kod wyjścia 0, porażek 1/);
  assert.match(zero.compareRuns({ status: 0, summary: null }, run(10, 10, 0), true).reason, /kod oryginalny: brak podsumowania/);
  assert.match(zero.compareRuns(run(10, 10, 0), { status: 0, summary: null }, true).reason, /kod zinstrumentowany: brak podsumowania/);
});

// --- sprawdzian doboru (validate-selection) ------------------------------------------------------

test('validate-selection every: równomierna próbka albo cała lista', () => {
  assert.deepEqual(validate.every([1, 2, 3], 3), [1, 2, 3]);
  assert.deepEqual(validate.every([1, 2, 3], 5), [1, 2, 3]);
  assert.deepEqual(validate.every([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5), [0, 2, 4, 6, 8]);
  assert.deepEqual(validate.every([0, 1, 2, 3, 4, 5], 4), [0, 1, 3, 4]);
});

test('validate-selection optionOf: wartość opcji albo undefined (także pusta)', () => {
  assert.equal(validate.optionOf(['--ids=1,2', '--nocov=7'], 'ids'), '1,2');
  assert.equal(validate.optionOf(['--ids='], 'ids'), '');
  assert.equal(validate.optionOf(['--idsx=1'], 'ids'), undefined);
  assert.equal(validate.optionOf([], 'ids'), undefined);
});

test('validate-selection chooseSample: ocalałe z testami, bez pokrycia, wskazane id', () => {
  const mutants = [
    { id: '1', status: 'Survived' }, { id: '2', status: 'Killed' }, { id: '3', status: 'Survived' }, { id: '4', status: 'Survived' }, { id: '5', status: 'Survived' }
  ];
  const sel = { mutants: { 1: ['t.js'], 2: ['t.js'], 3: [], 4: 'STATIC', 5: [] } };
  const all = validate.chooseSample(mutants, sel, []);
  assert.deepEqual(all.survivors.map(m => m.id), ['1', '4']);
  assert.deepEqual(all.noCov.map(m => m.id), ['3', '5']);
  assert.deepEqual(all.sample.map(m => m.id), ['1', '4', '3', '5']);
  assert.equal(all.noTests(mutants[2]), true);
  assert.equal(all.noTests(mutants[3]), false);
  const limited = validate.chooseSample(mutants, sel, ['--survived=1', '--nocov=1']);
  assert.deepEqual(limited.sample.map(m => m.id), ['1', '3']);
  assert.deepEqual(validate.chooseSample(mutants, sel, ['--ids=2,5']).sample.map(m => m.id), ['2', '5']);
});

test('validate-selection validationSelection: próbka dostaje ALL, reszta pustą listę, wykluczone testy znikają', () => {
  const sel = { source: 'P.gs', all: ['a', 'b', 'c'], covering: ['a'], mutants: { 1: ['a'] } };
  const mutants = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const val = validate.validationSelection(sel, mutants, [mutants[1]], ['b']);
  assert.deepEqual(val, { source: 'P.gs', all: ['a', 'c'], covering: ['a', 'c'], mutants: { 1: [], 2: 'ALL', 3: [] } });
});

// --- środowisko i LCOV ---------------------------------------------------------------------------

test('safe-env: przepuszcza tylko allowlistę i zmienne pilota, GIT_* nigdy', () => {
  const env = safeEnv({
    PATH: '/bin', SystemRoot: 'C:/Windows', TEMP: '/tmp', __STRYKER_ACTIVE_MUTANT__: '7', MUTATION_SELECTION: 'sel.json',
    SERVICE_PASSWORD: 'x', GITHUB_TOKEN: 'x', GIT_DIR: '/repo/.git', GIT_INDEX_FILE: 'i', HOME: '/home/u', NODE_OPTIONS: '--inspect', RANDOM_VAR: 'y'
  });
  assert.deepEqual(Object.keys(env).sort(), ['MUTATION_SELECTION', 'PATH', 'SystemRoot', 'TEMP', '__STRYKER_ACTIVE_MUTANT__']);
  assert.equal(safeEnv({ GIT_DIR: 'x', git_work_tree: 'y' }).GIT_DIR, undefined);
  assert.equal(Object.keys(safeEnv({ git_work_tree: 'y' })).length, 0);
});

test('safe-env: extra przepuszcza tylko zmienne pilota; allowlista jest zamknięta', () => {
  assert.equal(safeEnv({}, { MUTATION_SELECTION: 's.json' }).MUTATION_SELECTION, 's.json');
  assert.throws(() => safeEnv({}, { TOKEN: 'x' }), /safeEnv: zmienna TOKEN nie jest na liście pilota/);
  assert.throws(() => safeEnv({}, { GIT_DIR: 'x' }), /nie jest na liście pilota/);
  assert.deepEqual(PILOT, ['__STRYKER_ACTIVE_MUTANT__', 'MUTATION_SELECTION']);
  assert.deepEqual(ALLOWED, ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'CI']);
  assert.equal(safeEnv({ path: '/x', tz: 'UTC' }).path, '/x');
  assert.equal(safeEnv({ MUTATION_SELECTION: 'a', mutation_selection: 'b' }).mutation_selection, undefined);
});

test('lcov: trafienia linii i gałęzi per plik, nazwa pliku z ukośnikami Windows i Linuksa', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcov-'));
  const file = path.join(dir, 'x.info');
  fs.writeFileSync(file, [
    'TN:', 'SF:C:\\repo\\src\\Kod.gs', 'DA:1,3', 'DA:2,0', 'DA:1,2', 'BRDA:5,0,0,4', 'BRDA:5,0,1,-', 'BRDA:5,0,1,2', 'end_of_record',
    'SF:src/Inny.gs', 'DA:9,1', 'end_of_record', 'DA:77,7', 'BRDA:1,1,1,1', ''
  ].join('\r\n'));
  const out = parseLcov(file);
  assert.deepEqual(Object.keys(out), ['Kod.gs', 'Inny.gs']);
  assert.deepEqual([...out['Kod.gs'].lines], [[1, 5], [2, 0]]);
  assert.deepEqual([...out['Kod.gs'].branches], [['5:0:0', 4], ['5:0:1', 2]]);
  assert.deepEqual([...out['Inny.gs'].lines], [[9, 1]]);
  assert.equal(out['Inny.gs'].branches.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lcov ranges: kolejne linie jako zakresy', () => {
  assert.equal(ranges([1, 2, 3, 7]), '1-3 7');
  assert.equal(ranges([5]), '5');
  assert.equal(ranges([9, 1, 2]), '1-2 9');
  assert.equal(ranges([]), '');
  assert.equal(ranges(new Set([3, 4])), '3-4');
});

test('safe-env: żadna nazwa z allowlisty ani z listy pilota nie jest GIT_* (dlatego GIT_* nigdy nie przechodzi)', () => {
  for (const name of [...ALLOWED, ...PILOT]) assert.equal(/^GIT_/i.test(name), false, name);
  assert.throws(() => safeEnv({}, { GIT_DIR: 'x' }), /nie jest na liście pilota/);
});

test('lcov: pliki z końcami wierszy LF i CRLF, nazwa pliku bez katalogu, gałęzie z kluczem linia:blok:gałąź', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcov2-'));
  try {
    for (const eol of ['\n', '\r\n']) {
      const file = path.join(dir, 'y.info');
      fs.writeFileSync(file, ['SF:Goly.gs', 'DA:1,2', 'LF:1', 'DA:2,1', 'FNF:0', 'BRDA:7,1,2,3', 'BRDA:7,1,2,-', 'BRDA:7,1,3,-', 'end_of_record', ''].join(eol));
      const out = parseLcov(file);
      assert.deepEqual(Object.keys(out), ['Goly.gs'], JSON.stringify(eol));
      assert.deepEqual([...out['Goly.gs'].lines], [[1, 2], [2, 1]]);
      assert.deepEqual([...out['Goly.gs'].branches], [['7:1:2', 3], ['7:1:3', 0]]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('lcov ranges: nie łączy powtórzeń ani odstępów, sortuje liczbowo', () => {
  assert.equal(ranges([10, 9, 2, 1]), '1-2 9-10');
  assert.equal(ranges([1, 1, 2]), '1 1-2');
  assert.equal(ranges([1, 3, 5]), '1 3 5');
});

test('selection per-mutant: linie wielowierszowego mutanta, brak wpisu w bazie i kolejność niezależna od mapy', () => {
  const map = { baseline: {}, tests: { 'b.test.js': { sources: { 'P.gs': [11] } }, 'a.test.js': { sources: { 'P.gs': [12, 13] } }, 'z.test.js': { sources: { 'Q.gs': [1] } } } };
  const mutants = [{ id: 'w', location: { start: { line: 10 }, end: { line: 13 } } }, { id: 'j', location: { start: { line: 12 }, end: { line: 12 } } }, { id: 'n', location: { start: { line: 14 }, end: { line: 14 } } }];
  const sel = buildSelection({ name: 'P.gs', mutants, suite: 'per-mutant', allTests: ['b.test.js', 'a.test.js'], map });
  assert.deepEqual(sel.mutants, { w: ['a.test.js', 'b.test.js'], j: ['a.test.js'], n: [] });
  assert.deepEqual(sel.covering, ['a.test.js', 'b.test.js']);
  const withBase = buildSelection({ name: 'P.gs', mutants, suite: 'per-mutant', allTests: [], map: { ...map, baseline: { 'P.gs': [13] } } });
  assert.equal(withBase.mutants.w, 'STATIC');
  assert.deepEqual(withBase.mutants.j, ['a.test.js']);
});

test('tests-list isExcluded: tylko nazwy kończące się na .test.js', () => {
  assert.equal(isExcluded('mutation-a.test.json'), false);
  assert.equal(isExcluded('mutation-a.test.js.bak'), false);
});

test('classify CLI: domyślne wejście z pliku, wyjście i kod; import modułu niczego nie uruchamia', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-cli-'));
  try {
    const good = path.join(dir, 'good.json');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(good, JSON.stringify({ files: { 'A.js': { mutants: [mutant('1', 'Killed', { statusReason: ASSERT_OUT })] } } }));
    fs.writeFileSync(bad, JSON.stringify({ files: { 'A.js': { mutants: [mutant('1', 'Survived')] } } }));
    const script = path.resolve(__dirname, '..', 'scripts', 'mutation', 'classify.js');
    const ok = spawnSync(process.execPath, [script, good], { encoding: 'utf8' });
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout, '{"killed-assert":1}\nwynik wg killed-assert: 1/1 = 100.0 %\n');
    const fail = spawnSync(process.execPath, [script, bad], { encoding: 'utf8' });
    assert.equal(fail.status, 3);
    assert.match(fail.stderr, /POMIAR NIEWAŻNY/);
    classifyMain(['node', 'classify.js', good], { log: () => {}, error: () => {}, exit: () => {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
