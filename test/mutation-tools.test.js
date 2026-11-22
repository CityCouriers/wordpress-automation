'use strict';

// Testy narzędzi mutacji .gs na tymczasowym drzewie (kopia scripts/mutation, własne src/ i test/): vm-preload,
// prepare-shadow, run-tests, run-for-mutant, report. Bramka izolacji jest tu zastąpiona atrapą WYŁĄCZNIE w testach
// (preload wstawia atrapę do require.cache procesu testowanego); kod produkcyjny nie ma żadnej flagi jej wyłączającej.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REAL = path.resolve(__dirname, '..', 'scripts', 'mutation');
const TREES = [];

function makeTree(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-tree-'));
  TREES.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts', 'mutation'), { recursive: true });
  for (const f of fs.readdirSync(REAL).filter(n => n.endsWith('.js') && !n.endsWith('.test.js'))) fs.copyFileSync(path.join(REAL, f), path.join(dir, 'scripts', 'mutation', f));
  const guard = path.join(dir, 'scripts', 'mutation', 'isolation-guard.js');
  fs.writeFileSync(path.join(dir, 'stub-guard.js'), `require.cache[${JSON.stringify(guard)}] = { id: ${JSON.stringify(guard)}, filename: ${JSON.stringify(guard)}, loaded: true, exports: { requireIsolationFacts() {}, requireIsolation: async () => [] } };\n`);
  fs.writeFileSync(path.join(dir, 'stryker-bridge.js'), BRIDGE);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

// Pomiar mutacyjny tych samych narzędzi (Stryker): zinstrumentowany kod w podprocesie bierze numer aktywnego mutanta
// z global.__stryker__.activeMutant, a gdy go nie ma, ze zmiennej __STRYKER_ACTIVE_MUTANT__. Ta zmienna ma w tych
// narzędziach własne znaczenie (testy podają ją jako id mutanta), więc bez mostu testowe id aktywowałoby przypadkowy
// mutant. Most (--require) ZAWSZE ustawia global: numer mutanta pomiaru przekazany osobno (MUT_OUTER_MUTANT) albo
// pusty napis (żaden mutant). Poza pomiarem kod nie jest zinstrumentowany, więc most nic nie zmienia.
const OUTER = process.env.__STRYKER_ACTIVE_MUTANT__;
const BRIDGE = "globalThis.__stryker__ = Object.assign(globalThis.__stryker__ || {}, { activeMutant: process.env.MUT_OUTER_MUTANT === undefined ? '' : process.env.MUT_OUTER_MUTANT });\n";

function node(tree, args, env = {}) {
  const outer = OUTER === undefined ? {} : { MUT_OUTER_MUTANT: OUTER };
  return spawnSync(process.execPath, ['--require', path.join(tree, 'stryker-bridge.js'), ...args], { cwd: tree, encoding: 'utf8', timeout: 120000, env: { PATH: process.env.PATH || process.env.Path || '', SystemRoot: process.env.SystemRoot || '', ...outer, ...env } });
}

const tool = (tree, name, args = [], env = {}) => node(tree, ['--require', path.join(tree, 'stub-guard.js'), path.join(tree, 'scripts', 'mutation', name), ...args], env);
const preload = tree => path.join(tree, 'scripts', 'mutation', 'vm-preload.js');

after(() => { for (const d of TREES) fs.rmSync(d, { recursive: true, force: true }); });

// --- vm-preload ------------------------------------------------------------------------------------

const READ_SRC = "const fs=require('fs');const path=require('path');const f=path.join(process.cwd(),process.argv[1]);process.stdout.write(String(fs.readFileSync(f,'utf8')));";

test('vm-preload: odczyt src/X.gs trafia do kopii cienia, gdy istnieje; bez niej do oryginału', () => {
  const tree = makeTree({ 'src/A.gs': 'ORYGINAŁ', '.stryker-shadow/A.js': 'CIEŃ', 'src/B.gs': 'ORYGINAŁ B' });
  assert.equal(node(tree, ['--require', preload(tree), '-e', READ_SRC, 'src/A.gs']).stdout, 'CIEŃ');
  assert.equal(node(tree, ['--require', preload(tree), '-e', READ_SRC, 'src/B.gs']).stdout, 'ORYGINAŁ B');
});

test('vm-preload: źródło, którego nie ma w src/ (kanarek), jest czytane z kopii cienia; bez cienia daje ENOENT', () => {
  const tree = makeTree({ '.stryker-shadow/Wirtualny.js': 'KANAREK' });
  assert.equal(node(tree, ['--require', preload(tree), '-e', READ_SRC, 'src/Wirtualny.gs']).stdout, 'KANAREK');
  const missing = node(tree, ['--require', preload(tree), '-e', READ_SRC, 'src/Brak.gs']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /ENOENT/);
});

test('vm-preload: przekierowanie dotyczy tylko plików .gs bezpośrednio pod src/ (nie innych rozszerzeń ani katalogów)', () => {
  const tree = makeTree({ 'src/A.txt': 'TXT', '.stryker-shadow/A.js': 'CIEŃ', 'inny/A.gs': 'INNY', 'src2/A.gs': 'SRC2' });
  assert.equal(node(tree, ['--require', preload(tree), '-e', READ_SRC, 'src/A.txt']).stdout, 'TXT');
  assert.equal(node(tree, ['--require', preload(tree), '-e', READ_SRC, 'inny/A.gs']).stdout, 'INNY');
  assert.equal(node(tree, ['--require', preload(tree), '-e', READ_SRC, 'src2/A.gs']).stdout, 'SRC2');
});

test('vm-preload: przekierowanie działa też dla odczytu z opcjami i dla Buffer (argumenty są przekazywane dalej)', () => {
  const tree = makeTree({ '.stryker-shadow/A.js': 'CIEŃ' });
  const code = "const fs=require('fs');const path=require('path');const b=fs.readFileSync(path.join(process.cwd(),'src','A.gs'));process.stdout.write(Buffer.isBuffer(b)?'buffer:'+b.toString():'string');";
  assert.equal(node(tree, ['--require', preload(tree), '-e', code]).stdout, 'buffer:CIEŃ');
});

test('vm-preload: odczyt przez deskryptor pliku (nie ścieżkę) działa bez zmian, a plik bez rozszerzenia .gs nie jest przekierowywany', () => {
  const tree = makeTree({ 'src/A.txt': 'TXT', '.stryker-shadow/A.txt.js': 'CIEŃ TXT', 'dane.bin': 'FD' });
  const fd = "const fs=require('fs');const d=fs.openSync('dane.bin','r');process.stdout.write(String(fs.readFileSync(d,'utf8')));";
  assert.equal(node(tree, ['--require', preload(tree), '-e', fd]).stdout, 'FD');
  assert.equal(node(tree, ['--require', preload(tree), '-e', READ_SRC, 'src/A.txt']).stdout, 'TXT');
});

const CONTEXT = "const vm=require('vm');const c=vm.createContext({});const d=Object.getOwnPropertyDescriptor(c,'__stryker__');process.stdout.write(JSON.stringify({value:d&&d.value,enumerable:d&&d.enumerable,writable:d&&d.writable,configurable:d&&d.configurable}));";

test('vm-preload: aktywny mutant trafia do kontekstu vm jako nieenumerowalne __stryker__.activeMutant', () => {
  const tree = makeTree();
  const out = JSON.parse(node(tree, ['--require', preload(tree), '-e', CONTEXT], { __STRYKER_ACTIVE_MUTANT__: '7' }).stdout);
  assert.deepEqual(out, { value: { activeMutant: '7' }, enumerable: false, writable: true, configurable: true });
});

test('vm-preload: bez aktywnego mutanta kontekst nie dostaje __stryker__; istniejące __stryker__ nie jest nadpisywane; createContext bez argumentu działa', () => {
  const tree = makeTree();
  assert.deepEqual(JSON.parse(node(tree, ['--require', preload(tree), '-e', CONTEXT]).stdout), {});
  const keep = "const vm=require('vm');const own={ activeMutant:'x' };const c=vm.createContext({__stryker__:own});process.stdout.write(String(c.__stryker__===own));";
  assert.equal(node(tree, ['--require', preload(tree), '-e', keep], { __STRYKER_ACTIVE_MUTANT__: '7' }).stdout, 'true');
  const empty = "const vm=require('vm');const c=vm.createContext();process.stdout.write(typeof c+':'+JSON.stringify(c.__stryker__));";
  assert.equal(node(tree, ['--require', preload(tree), '-e', empty], { __STRYKER_ACTIVE_MUTANT__: '3' }).stdout, 'object:{"activeMutant":"3"}');
});

// --- prepare-shadow --------------------------------------------------------------------------------

test('prepare-shadow: tworzy kopię cienia o identycznej treści i wypisuje mapowanie', () => {
  const tree = makeTree({ 'src/A.gs': 'function a() {}\n', 'src/B.gs': 'b', 'src/Wp09.gs': 'w' });
  const r = node(tree, [path.join(tree, 'scripts', 'mutation', 'prepare-shadow.js'), 'A.gs', 'B.gs', 'Wp09.gs']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'A.gs -> .stryker-shadow/A.js\nB.gs -> .stryker-shadow/B.js\nWp09.gs -> .stryker-shadow/Wp09.js\n');
  assert.equal(fs.readFileSync(path.join(tree, '.stryker-shadow', 'A.js'), 'utf8'), 'function a() {}\n');
});

test('prepare-shadow: nie przepisuje identycznej kopii, a zmienioną źródłem aktualizuje', () => {
  const tree = makeTree({ 'src/A.gs': 'jeden' });
  const script = path.join(tree, 'scripts', 'mutation', 'prepare-shadow.js');
  node(tree, [script, 'A.gs']);
  const shadow = path.join(tree, '.stryker-shadow', 'A.js');
  const past = new Date(2020, 0, 1);
  fs.utimesSync(shadow, past, past);
  node(tree, [script, 'A.gs']);
  assert.equal(fs.statSync(shadow).mtime.getFullYear(), 2020, 'identyczna kopia nie powinna być przepisana');
  fs.writeFileSync(path.join(tree, 'src', 'A.gs'), 'dwa');
  node(tree, [script, 'A.gs']);
  assert.equal(fs.readFileSync(shadow, 'utf8'), 'dwa');
});

test('prepare-shadow: brak nazw albo nieprawidłowa nazwa to kod 2 i nic nie powstaje', () => {
  const tree = makeTree({ 'src/A.gs': 'x' });
  const script = path.join(tree, 'scripts', 'mutation', 'prepare-shadow.js');
  const none = node(tree, [script]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Podaj nazwy plików z src\//);
  for (const bad of ['../A.gs', 'A.js', 'A B.gs', 'A.gs.js', 'A_gs', 'A.gsx', '.gs', 'A-B.gs', 'A/B.gs']) {
    const r = node(tree, [script, bad]);
    assert.equal(r.status, 2, bad);
    assert.ok(r.stderr.includes(`Nieprawidłowa nazwa pliku: ${bad}`), r.stderr);
  }
  assert.equal(fs.existsSync(path.join(tree, '.stryker-shadow', 'A.js')), false);
});

// --- run-tests -------------------------------------------------------------------------------------

const PASS = "const {test}=require('node:test');test('ok',()=>{});\n";
const FAIL = "const {test}=require('node:test');test('pada',()=>{throw new Error('x');});\n";

test('run-tests: bez argumentów uruchamia wszystkie testy poza skanującymi repozytorium; zielone => 0', () => {
  const tree = makeTree({ 'test/a.test.js': PASS, 'test/b.test.js': PASS, 'test/repo-identity.test.js': FAIL, 'test/source-control-chars.test.js': FAIL, 'test/helper.js': FAIL });
  const r = tool(tree, 'run-tests.js');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ℹ tests 2\b/);
});

test('run-tests: czerwony test daje kod niezerowy; podane pliki zawężają przebieg', () => {
  const tree = makeTree({ 'test/a.test.js': PASS, 'test/b.test.js': FAIL });
  assert.notEqual(tool(tree, 'run-tests.js').status, 0);
  const only = tool(tree, 'run-tests.js', ['test/a.test.js']);
  assert.equal(only.status, 0, only.stdout);
  assert.match(only.stdout, /ℹ tests 1\b/);
});

test('run-tests: testy dostają tylko allowlistę środowiska (bez poświadczeń i GIT_*)', () => {
  const probe = "const {test}=require('node:test');const assert=require('node:assert');test('env',()=>{assert.equal(process.env.GITHUB_TOKEN,undefined);assert.equal(process.env.GIT_DIR,undefined);assert.equal(process.env.CUSTOM,undefined);assert.ok(process.env.PATH);});\n";
  const tree = makeTree({ 'test/env.test.js': probe });
  const r = tool(tree, 'run-tests.js', [], { GITHUB_TOKEN: 'sekret', GIT_DIR: '/x', CUSTOM: '1' });
  assert.equal(r.status, 0, r.stdout);
});

test('run-tests: testy działają z preludium (przekierowanie źródła na cień)', () => {
  const t = "const {test}=require('node:test');const assert=require('node:assert');const fs=require('fs');const path=require('path');test('cień',()=>{assert.equal(fs.readFileSync(path.join(process.cwd(),'src','A.gs'),'utf8'),'CIEŃ');});\n";
  const tree = makeTree({ 'test/cien.test.js': t, 'src/A.gs': 'ORYGINAŁ', '.stryker-shadow/A.js': 'CIEŃ' });
  assert.equal(tool(tree, 'run-tests.js').status, 0);
});

// --- run-for-mutant --------------------------------------------------------------------------------

const logger = name => `require('fs').appendFileSync(require('path').join(__dirname,'..','run.log'),${JSON.stringify(name)}+'\\n');\n`;

function selectionTree(selection, tests) {
  const files = { 'selection.json': JSON.stringify(selection) };
  for (const [name, body] of Object.entries(tests)) files[`test/${name}`] = body;
  return makeTree(files);
}

const mutantRun = (tree, id, extra = {}) => tool(tree, 'run-for-mutant.js', [], { MUTATION_SELECTION: path.join(tree, 'selection.json'), ...(id === undefined ? {} : { __STRYKER_ACTIVE_MUTANT__: id }), ...extra });
const ranTests = tree => (fs.existsSync(path.join(tree, 'run.log')) ? fs.readFileSync(path.join(tree, 'run.log'), 'utf8').trim().split('\n') : []);

test('run-for-mutant: uruchamia testy mutanta od najmniejszego pliku, zielone => 0', () => {
  const tests = { 'big.test.js': `${logger('big')}${PASS}${'// '.padEnd(300, 'x')}\n`, 'small.test.js': `${logger('small')}${PASS}` };
  const tree = selectionTree({ covering: ['big.test.js'], all: ['big.test.js', 'small.test.js'], mutants: { 5: ['big.test.js', 'small.test.js'] } }, tests);
  const r = mutantRun(tree, '5');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(ranTests(tree), ['small', 'big']);
});

test('run-for-mutant: przerywa na pierwszej porażce i zwraca jej kod (zabicie)', () => {
  const tests = { 'a.test.js': `${logger('a')}${FAIL}`, 'bb.test.js': `${logger('bb')}${PASS}${'// '.padEnd(200, 'x')}\n` };
  const tree = selectionTree({ covering: [], all: [], mutants: { 1: ['a.test.js', 'bb.test.js'] } }, tests);
  const r = mutantRun(tree, '1');
  assert.notEqual(r.status, 0);
  assert.deepEqual(ranTests(tree), ['a']);
});

test('run-for-mutant: brak id (suchy przebieg) uruchamia testy pliku (covering); ALL i STATIC wybierają odpowiednie listy', () => {
  const tests = { 'a.test.js': `${logger('a')}${PASS}`, 'b.test.js': `${logger('b')}${PASS}${'// '.padEnd(80, 'x')}\n`, 'c.test.js': `${logger('c')}${PASS}${'// '.padEnd(160, 'x')}\n` };
  const selection = { covering: ['b.test.js'], all: ['a.test.js', 'b.test.js', 'c.test.js'], mutants: { 1: 'ALL', 2: 'STATIC', 3: [] } };
  const tree = selectionTree(selection, tests);
  assert.equal(mutantRun(tree, undefined).status, 0);
  assert.deepEqual(ranTests(tree), ['b']);
  fs.rmSync(path.join(tree, 'run.log'));
  assert.equal(mutantRun(tree, '1').status, 0);
  assert.deepEqual(ranTests(tree), ['a', 'b', 'c']);
  fs.rmSync(path.join(tree, 'run.log'));
  assert.equal(mutantRun(tree, '2').status, 0);
  assert.deepEqual(ranTests(tree), ['b']);
  fs.rmSync(path.join(tree, 'run.log'));
  assert.equal(mutantRun(tree, '3').status, 0);
  assert.deepEqual(ranTests(tree), [], 'mutant bez testów nie uruchamia niczego');
});

test('run-for-mutant: mutant spoza pliku wyboru to pomiar nieważny (kod 70), nic nie jest uruchamiane', () => {
  const tree = selectionTree({ covering: ['a.test.js'], all: [], mutants: { 1: ['a.test.js'] } }, { 'a.test.js': `${logger('a')}${PASS}` });
  const r = mutantRun(tree, '99');
  assert.equal(r.status, 70);
  assert.match(r.stderr, /Brak mutanta 99 w pliku wyboru: pomiar nieważny\./);
  assert.deepEqual(ranTests(tree), []);
});

test('run-for-mutant: testy dostają id mutanta i plik wyboru, ale nie poświadczenia ani GIT_*', () => {
  const probe = "const {test}=require('node:test');const assert=require('node:assert');test('env',()=>{assert.equal(process.env.__STRYKER_ACTIVE_MUTANT__,'4');assert.ok(process.env.MUTATION_SELECTION);assert.equal(process.env.GITHUB_TOKEN,undefined);assert.equal(process.env.GIT_DIR,undefined);});\n";
  const tree = selectionTree({ covering: [], all: [], mutants: { 4: ['e.test.js'] } }, { 'e.test.js': probe });
  assert.equal(mutantRun(tree, '4', { GITHUB_TOKEN: 'x', GIT_DIR: '/y' }).status, 0);
});

test('run-for-mutant: test padający z sygnałem (status null) daje kod 1', () => {
  const kill = "process.kill(process.pid, 'SIGKILL');\n";
  const tree = selectionTree({ covering: [], all: [], mutants: { 1: ['k.test.js'] } }, { 'k.test.js': kill });
  const r = mutantRun(tree, '1');
  assert.notEqual(r.status, 0);
});

// --- report ----------------------------------------------------------------------------------------

test('report: zestawienie per plik z wynikami, listami i tabelą', () => {
  const mutants = [
    { id: '1', status: 'Killed', statusReason: 'AssertionError', mutatorName: 'X', location: { start: { line: 3 }, end: { line: 3 } } },
    { id: '2', status: 'Killed', statusReason: 'TypeError: a', mutatorName: 'X', location: { start: { line: 4 }, end: { line: 4 } } },
    { id: '3', status: 'Survived', mutatorName: 'X', location: { start: { line: 5 }, end: { line: 5 } } },
    { id: '4', status: 'Survived', mutatorName: 'X', location: { start: { line: 6 }, end: { line: 6 } } },
    { id: '5', status: 'Timeout', mutatorName: 'X', location: { start: { line: 7 }, end: { line: 7 } } },
    { id: '6', status: 'RuntimeError', mutatorName: 'X', location: { start: { line: 8 }, end: { line: 8 } } },
    { id: '7', status: 'Survived', mutatorName: 'X', location: { start: { line: 9 }, end: { line: 9 } } }
  ];
  const tree = makeTree({
    'reports/mutation/result-P.json': JSON.stringify({ files: { 'P.js': { mutants } } }),
    'reports/mutation/selection-P.json': JSON.stringify({ mutants: { 1: ['t'], 2: ['t'], 3: ['t'], 4: [], 5: ['t'], 6: ['t'], 7: ['t'] } }),
    'reports/mutation/time-P.json': JSON.stringify({ runSeconds: 12, indexSeconds: 2 }),
    'coverage/lcov.info': 'SF:src/P.gs\nDA:1,1\nDA:2,0\nDA:3,1\nDA:4,1\nDA:5,1\nBRDA:3,0,0,1\nBRDA:3,0,1,0\nend_of_record\n',
    '.quality/coverage-policy.json': JSON.stringify({ defaultThreshold: 90, rules: [{ pattern: 'src/P.gs', threshold: 50 }] })
  });
  const r = node(tree, [path.join(tree, 'scripts', 'mutation', 'report.js'), 'P.gs']);
  assert.equal(r.status, 0, r.stderr);
  const out = dir => fs.readFileSync(path.join(tree, 'reports', 'mutation', dir), 'utf8');
  const summary = JSON.parse(out('summary.json'))['P.gs'];
  assert.deepEqual(summary, {
    mutants: 7, 'killed-assert': 1, 'killed-other': 1, Survived: 2, NoCoverage: 1, Timeout: 1, Error: 0, Ignored: 0, RuntimeError: 1,
    scoreAll: 14.3, scoreCovered: 16.7,
    lcov: { lines: 5, uncoveredLines: 1, linePct: 80, threshold: 50, gate: 'OK', branchTotal: 2, branchMissed: 1 },
    mutantsOnUncoveredLines: 0, survivedOnCoveredLines: 2, seconds: 12, indexSeconds: 2
  });
  const table = out('TABELA.md').split('\n');
  assert.equal(table[2], '| P.gs | 7 | 1 | 1 | 2 | 1 | 1 | 14.3 % | 80 % (50 %) | 1 |');
  assert.equal(table[3], '| **Razem** | **7** | **1** | **1** | **2** | **1** | **1** | **14.3 %** |  |  |');
  const lists = out('LISTY.md');
  for (const line of [
    '## P.gs', '- Niepokryte linie (LCOV, 1 z 5): 2', '- Ocalałe na liniach pokrytych (asercja nie łapie): 5 9 [2 mutantów]', '- Bez pokrycia (żaden test nie wykonuje linii): 6 [1 mutantów]',
    '- Przekroczenia czasu: 7 [1 mutantów]', '- Zabite bez asercji (nie liczone): 4 [1 mutantów]', '- Błędy kompilacji/uruchomienia mutanta: 8 [1 mutantów]'
  ]) assert.ok(lists.includes(line), line);
});

// --- coverage-map ----------------------------------------------------------------------------------

test('coverage-map: baza z samego ładowania, linie per test ponad bazą, bySource, pominięte testy skanujące repozytorium', () => {
  const tree = makeTree();
  fs.cpSync(path.join(__dirname, '..', 'src'), path.join(tree, 'src'), { recursive: true });
  fs.cpSync(path.join(__dirname, 'helpers'), path.join(tree, 'test', 'helpers'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'scripts', 'mutation', 'load-only.test.js'), fs.readFileSync(path.join(REAL, 'load-only.test.js'), 'utf8'));
  const header = "const { test } = require('node:test');\nconst { loadProject } = require('./helpers/gas.js');\n";
  fs.writeFileSync(path.join(tree, 'test', 'dates.test.js'), `${header}test('dates', () => { const c = loadProject(); c.cachedFormatDate_()(new Date(0)); });\n`);
  fs.writeFileSync(path.join(tree, 'test', 'load.test.js'), `${header}test('load', () => { loadProject(); });\n`);
  fs.writeFileSync(path.join(tree, 'test', 'repo-identity.test.js'), `${header}test('skip', () => { loadProject(); });\n`);
  const r = node(tree, [path.join(tree, 'scripts', 'mutation', 'coverage-map.js')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Zapisano reports\/mutation\/coverage-map\.json \(2 plików testów\)/);
  const map = JSON.parse(fs.readFileSync(path.join(tree, 'reports', 'mutation', 'coverage-map.json'), 'utf8'));
  assert.deepEqual(Object.keys(map.tests), ['dates.test.js', 'load.test.js']);
  assert.ok(map.baseline['Dates.gs'].length > 0, 'baza ma linie wykonane przy ładowaniu');
  assert.deepEqual(Object.keys(map.tests['load.test.js'].sources), []);
  assert.ok(map.tests['dates.test.js'].sources['Dates.gs'].length > 0);
  assert.ok(map.tests['dates.test.js'].sources['Dates.gs'].every(l => !map.baseline['Dates.gs'].includes(l)), 'linie testu są ponad bazą');
  assert.deepEqual(map.bySource['Dates.gs'], ['dates.test.js']);
  assert.equal(map.tests['dates.test.js'].exit, 0);
});
