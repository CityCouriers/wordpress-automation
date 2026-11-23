'use strict';

// Orkiestratory potoku mutacji (#253): canary.js, zero-check.js, trial.js, run-file.js, validate-selection.js.
// Uruchamiają Strykera i procesy potomne, więc tu dostają atrapy (bramka izolacji, spawn, wyjścia) i drzewo tymczasowe:
// sprawdzamy kolejność kroków, dokładne argumenty procesów, pliki konfiguracji i raportów oraz kody wyjścia.
// Prawdziwy przebieg w izolatorze to osobny dowód z pierwszego uruchomienia w CI.
const { test } = require('node:test');
require('./helpers/exit-guard.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const canary = require('../scripts/mutation/canary.js');
const zero = require('../scripts/mutation/zero-check.js');
const { safeEnv } = require('../scripts/mutation/safe-env.js');

const SCRIPTS = path.resolve(__dirname, '..', 'scripts', 'mutation');
const STRYKER = 'node_modules/@stryker-mutator/core/bin/stryker.js';
const TREES = [];

function makeRoot(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-orch-'));
  TREES.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

require('node:test').after(() => { for (const d of TREES) fs.rmSync(d, { recursive: true, force: true }); });

/** Atrapa spawnSync: `handler` dostaje wywołanie i może zapisać pliki; zwraca wynik procesu. */
function fakeSpawn(handler = () => ({})) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: '', stderr: '', ...handler({ cmd, args, opts, index: calls.length - 1 }) };
  };
  spawn.calls = calls;
  return spawn;
}

function recorder() {
  const events = [];
  return {
    events,
    log: t => events.push(['log', t]),
    error: t => events.push(['error', t]),
    exit: c => events.push(['exit', c]),
    guard: async tool => { events.push(['guard', tool]); },
    of: kind => events.filter(e => e[0] === kind).map(e => e[1])
  };
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const mutant = (id, status, reason = '') => ({ id, status, statusReason: reason, mutatorName: 'M', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } });
const ASSERT = 'AssertionError [ERR_ASSERTION]: x';

// --- canary.js ---------------------------------------------------------------------------------------

function canaryRoot() {
  return makeRoot({ 'stryker.config.json': JSON.stringify({ x: 1, mutate: ['stare'], concurrency: 9, timeoutMS: 1 }) });
}

const killedReport = n => ({ files: { 'MutationCanary.js': { mutants: Array.from({ length: n }, (_, i) => mutant(String(i), 'Killed', ASSERT)) } } });

test('canary main: kopia cienia kanarka, konfiguracja Strykera, dokładne argumenty procesu, raport i kod 0', async () => {
  const root = canaryRoot();
  const r = recorder();
  fs.mkdirSync(path.join(root, 'reports', 'mutation'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports', 'mutation', 'canary-result.json'), JSON.stringify(killedReport(1)));
  const spawn = fakeSpawn(({ opts }) => {
    assert.equal(exists(root, 'reports/mutation/canary-result.json'), false, 'stary raport usunięty przed przebiegiem');
    assert.equal(r.events[0][0], 'guard');
    fs.writeFileSync(path.join(opts.cwd, 'reports', 'mutation', 'canary-result.json'), JSON.stringify(killedReport(canary.MIN_MUTANTS)));
    return { stdout: 'OUT', stderr: 'ERR' };
  });
  await canary.main({ root, guard: r.guard, spawn, log: r.log, exit: r.exit });
  assert.deepEqual(r.of('guard'), ['canary.js']);
  assert.equal(read(root, '.stryker-shadow/MutationCanary.js'), fs.readFileSync(path.join(SCRIPTS, 'canary', 'MutationCanary.gs'), 'utf8'));
  const cfgPath = path.join(root, 'reports', 'mutation', 'cfg-canary.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')), {
    x: 1, mutate: ['.stryker-shadow/MutationCanary.js'], concurrency: 2, timeoutMS: 60000,
    commandRunner: { command: 'node --require ./scripts/mutation/vm-preload.js --test scripts/mutation/canary/canary.test.js' },
    reporters: ['json'], jsonReporter: { fileName: path.join('reports', 'mutation', 'canary-result.json') }
  });
  assert.equal(spawn.calls.length, 1);
  assert.deepEqual(spawn.calls[0], { cmd: process.execPath, args: [STRYKER, 'run', cfgPath], opts: { cwd: root, encoding: 'utf8', env: safeEnv(process.env) } });
  assert.equal(read(root, 'reports/mutation/canary-log.txt'), 'OUTERR');
  const verdict = canary.canaryVerdict(killedReport(canary.MIN_MUTANTS));
  assert.equal(read(root, 'reports/mutation/canary.json'), JSON.stringify(verdict, null, 1));
  assert.deepEqual(r.of('log'), [verdict.reason]);
  assert.deepEqual(r.of('exit'), [0]);
});

test('canary main: brak raportu Strykera albo zepsuty łańcuch to kod 4 z komunikatem; log z samego stdout lub stderr', async () => {
  const root = canaryRoot();
  const r = recorder();
  await canary.main({ root, guard: r.guard, spawn: fakeSpawn(() => ({ status: 1, stdout: undefined, stderr: 'E' })), log: r.log, exit: r.exit });
  assert.equal(read(root, 'reports/mutation/canary-log.txt'), 'E');
  assert.deepEqual(r.of('exit'), [4]);
  const missing = 'Stryker nie zapisał raportu kanarka (suchy przebieg z testem kanarka nie przeszedł albo awaria)';
  assert.deepEqual(r.of('log'), [missing]);
  assert.equal(read(root, 'reports/mutation/canary.json'), JSON.stringify({ ok: false, reason: missing, counts: {} }, null, 1));
  const r2 = recorder();
  await canary.main({ root, guard: r2.guard, spawn: fakeSpawn(() => ({ stdout: 'O', stderr: undefined })), log: r2.log, exit: r2.exit });
  assert.equal(read(root, 'reports/mutation/canary-log.txt'), 'O');
  const r3 = recorder();
  await canary.main({ root, guard: r3.guard, spawn: fakeSpawn(({ opts }) => {
    fs.writeFileSync(path.join(opts.cwd, 'reports', 'mutation', 'canary-result.json'), JSON.stringify({ files: { 'MutationCanary.js': { mutants: [...killedReport(8).files['MutationCanary.js'].mutants, mutant('9', 'Survived')] } } }));
    return {};
  }), log: r3.log, exit: r3.exit });
  assert.deepEqual(r3.of('exit'), [4]);
  assert.match(r3.of('log')[0], /8 z 9 mutantów zabitych z asercją/);
});

test('canary main: odmowa bramki przerywa przed jakimkolwiek zapisem i procesem', async () => {
  const root = canaryRoot();
  const spawn = fakeSpawn();
  await assert.rejects(canary.main({ root, guard: async () => { throw new Error('brak izolacji'); }, spawn }), /brak izolacji/);
  assert.equal(spawn.calls.length, 0);
  assert.equal(exists(root, 'reports'), false);
  assert.equal(exists(root, '.stryker-shadow'), false);
});

// --- zero-check.js -----------------------------------------------------------------------------------

const SUMMARY = (tests, pass, fail) => `ℹ tests ${tests}\nℹ suites 0\nℹ pass ${pass}\nℹ fail ${fail}\n`;
const ORIGINAL = 'function a() { return 1; }';
const INSTRUMENTED = `function stryNS_9fa48() {}\nfunction stryCov_9fa48() {}\n${ORIGINAL}`;

function zeroRoot(extra = {}) {
  return makeRoot({ 'stryker.config.json': JSON.stringify({ base: true, mutate: ['x'], reporters: ['json'] }), ...extra });
}

/** Atrapa potoku kontroli zerowej: prepare-shadow tworzy cień, Stryker kopię roboczą, run-tests wypisuje podsumowanie. */
function zeroSpawn(root, { baseOut = SUMMARY(10, 10, 0), sandboxOut = SUMMARY(10, 10, 0), baseErr = '', sandboxErr = '', shadow = ORIGINAL, instrumented = INSTRUMENTED, createSandbox = true, baseStatus = 0, sandboxStatus = 0 } = {}) {
  return fakeSpawn(({ args, opts }) => {
    if (args[0].endsWith('prepare-shadow.js')) {
      fs.mkdirSync(path.join(root, '.stryker-shadow'), { recursive: true });
      fs.writeFileSync(path.join(root, '.stryker-shadow', 'Tiny.js'), shadow);
      return {};
    }
    if (args[0] === STRYKER) {
      if (createSandbox) {
        fs.mkdirSync(path.join(root, '.stryker-tmp', 'sandbox-1', '.stryker-shadow'), { recursive: true });
        fs.writeFileSync(path.join(root, '.stryker-tmp', 'sandbox-1', '.stryker-shadow', 'Tiny.js'), instrumented);
      }
      return {};
    }
    const inSandbox = opts.cwd !== root;
    return inSandbox ? { status: sandboxStatus, stdout: sandboxOut, stderr: sandboxErr } : { status: baseStatus, stdout: baseOut, stderr: baseErr };
  });
}

test('zero-check main: kolejność kroków, argumenty procesów, konfiguracja suchego przebiegu, raport i kod 0', async () => {
  const root = zeroRoot();
  const r = recorder();
  const spawn = zeroSpawn(root);
  await zero.main(['node', 'zero-check.js', 'Tiny.gs'], { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
  assert.deepEqual(r.of('guard'), ['zero-check.js']);
  const env = safeEnv(process.env);
  const cfgPath = path.join(root, 'reports', 'mutation', 'cfg-zero-Tiny.json');
  assert.deepEqual(spawn.calls.map(c => c.args), [
    [path.join(SCRIPTS, 'prepare-shadow.js'), 'Tiny.gs'],
    [path.join('scripts', 'mutation', 'run-tests.js')],
    [STRYKER, 'run', cfgPath],
    [path.join('scripts', 'mutation', 'run-tests.js')]
  ]);
  assert.deepEqual(spawn.calls.map(c => c.opts.cwd), [root, root, root, path.join(root, '.stryker-tmp', 'sandbox-1')]);
  assert.deepEqual(spawn.calls[0].opts, { cwd: root, stdio: 'ignore', env });
  assert.deepEqual(spawn.calls[1].opts, { cwd: root, encoding: 'utf8', env });
  assert.deepEqual(spawn.calls[2].opts, { cwd: root, encoding: 'utf8', env });
  assert.ok(spawn.calls.every(c => c.cmd === process.execPath));
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')), {
    base: true, mutate: ['.stryker-shadow/Tiny.js'], commandRunner: { command: 'node -e "process.exit(0)"' },
    reporters: ['clear-text'], dryRunOnly: true, cleanTempDir: false, concurrency: 1
  });
  const reason = 'kod zinstrumentowany bez mutanta daje ten sam wynik: 10 testów, 10 zaliczonych, 0 porażek';
  assert.deepEqual(JSON.parse(read(root, 'reports/mutation/zero-check-Tiny.json')), { file: 'Tiny.gs', ok: true, reason, base: { tests: 10, pass: 10, fail: 0 }, instrumented: { tests: 10, pass: 10, fail: 0 } });
  assert.equal(read(root, 'reports/mutation/zero-check-Tiny.json'), JSON.stringify({ file: 'Tiny.gs', ok: true, reason, base: { tests: 10, pass: 10, fail: 0 }, instrumented: { tests: 10, pass: 10, fail: 0 } }, null, 1));
  assert.deepEqual(r.of('log'), [reason]);
  assert.deepEqual(r.of('error'), []);
  assert.deepEqual(r.of('exit'), [0]);
  assert.equal(exists(root, '.stryker-tmp'), false, 'kopia robocza Strykera sprzątana po kontroli');
});

test('zero-check main: nieprawidłowa nazwa pliku to kod 2 przed bramką i bez procesów', async () => {
  for (const argv of [['node', 'zero-check.js'], ['node', 'zero-check.js', '../x.gs'], ['node', 'zero-check.js', 'a b.gs'], ['node', 'zero-check.js', 'A.js'], ['node', 'zero-check.js', 'Tiny.gsx'], ['node', 'zero-check.js', 'x/Tiny.gs'], ['node', 'zero-check.js', 'Tiny_gs'], ['node', 'zero-check.js', '.gs']]) {
    const root = zeroRoot();
    const r = recorder();
    const spawn = fakeSpawn();
    await zero.main(argv, { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
    assert.deepEqual(r.events, [['error', 'Podaj nazwę pliku z src/, np. Payloads.gs'], ['exit', 2]], argv.join(' '));
    assert.equal(spawn.calls.length, 0);
  }
});

test('zero-check main: stara kopia robocza nie udaje wyniku, a brak kopii to kod 4 z pustą kontrolą', async () => {
  const root = zeroRoot({ '.stryker-tmp/sandbox-old/.stryker-shadow/Tiny.js': INSTRUMENTED });
  const r = recorder();
  const spawn = zeroSpawn(root, { createSandbox: false });
  await zero.main(['node', 'zero-check.js', 'Tiny.gs'], { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
  assert.deepEqual(r.of('exit'), [4]);
  assert.deepEqual(r.of('log'), ['plik w kopii roboczej Strykera nie jest zinstrumentowany: kontrola byłaby pusta']);
  assert.equal(spawn.calls.length, 3, 'bez kopii roboczej nie ma drugiego przebiegu testów');
  assert.deepEqual(r.of('error'), ['baza:\nℹ tests 10\nℹ suites 0\nℹ pass 10\nℹ fail 0\n\nzinstrumentowany:\n']);
  const report = JSON.parse(read(root, 'reports/mutation/zero-check-Tiny.json'));
  assert.deepEqual(report, { file: 'Tiny.gs', ok: false, reason: 'plik w kopii roboczej Strykera nie jest zinstrumentowany: kontrola byłaby pusta', base: { tests: 10, pass: 10, fail: 0 }, instrumented: null });
});

test('zero-check main: kopia robocza wybierana tylko spośród katalogów sandbox*, z plikiem pomiaru', async () => {
  // Stryker (atrapa) zostawia: katalog niebędący sandboxem (zinstrumentowany plik), sandbox bez pliku i właściwy sandbox.
  const layout = (root, shadow) => {
    const put = (dir, content) => {
      fs.mkdirSync(path.join(root, '.stryker-tmp', dir, '.stryker-shadow'), { recursive: true });
      if (content !== null) fs.writeFileSync(path.join(root, '.stryker-tmp', dir, '.stryker-shadow', 'Tiny.js'), content);
    };
    put('inny', INSTRUMENTED);
    put('sandbox-0', null);
    put('sandbox-1', shadow);
  };
  const run = async shadow => {
    const root = zeroRoot();
    const r = recorder();
    const inner = zeroSpawn(root, { createSandbox: false });
    const spawn = fakeSpawn(call => {
      const result = inner(call.cmd, call.args, call.opts);
      if (call.args[0] === STRYKER) layout(root, shadow);
      return result;
    });
    await zero.main(['node', 'zero-check.js', 'Tiny.gs'], { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
    return { root, r, spawn };
  };
  const good = await run(INSTRUMENTED);
  assert.deepEqual(good.r.of('exit'), [0]);
  assert.equal(good.spawn.calls[3].opts.cwd, path.join(good.root, '.stryker-tmp', 'sandbox-1'));
  const plain = await run(ORIGINAL);
  assert.deepEqual(plain.r.of('exit'), [4], 'katalog „inny” nie jest kopią roboczą, więc jego zinstrumentowany plik się nie liczy');
  assert.match(plain.r.of('log')[0], /nie jest zinstrumentowany/);
});

test('zero-check main: różnica w liczbie testów, porażka albo niezinstrumentowany plik to kod 4 z ogonem wyjścia', async () => {
  const longOut = `${Array.from({ length: 40 }, (_, i) => `linia ${i + 1}`).join('\n')}\n${SUMMARY(10, 10, 0)}`;
  const cases = [
    [{ sandboxOut: SUMMARY(9, 9, 0) }, /liczby testów się różnią/],
    [{ sandboxOut: SUMMARY(10, 9, 1), sandboxStatus: 1 }, /kod zinstrumentowany: kod wyjścia 1, porażek 1/],
    [{ baseStatus: 1, baseOut: SUMMARY(10, 9, 1) }, /kod oryginalny: kod wyjścia 1/],
    [{ instrumented: ORIGINAL }, /nie jest zinstrumentowany/],
    [{ baseOut: 'brak podsumowania' }, /kod oryginalny: brak podsumowania/]
  ];
  for (const [options, pattern] of cases) {
    const root = zeroRoot();
    const r = recorder();
    await zero.main(['node', 'zero-check.js', 'Tiny.gs'], { root, guard: r.guard, spawn: zeroSpawn(root, options), log: r.log, error: r.error, exit: r.exit });
    assert.deepEqual(r.of('exit'), [4], String(pattern));
    assert.match(r.of('log')[0], pattern);
    assert.equal(r.of('error').length, 1);
    assert.match(r.of('error')[0], /^baza:\n[\s\S]*\nzinstrumentowany:\n/);
  }
  const root = zeroRoot();
  const r = recorder();
  await zero.main(['node', 'zero-check.js', 'Tiny.gs'], { root, guard: r.guard, spawn: zeroSpawn(root, { baseOut: longOut, sandboxOut: SUMMARY(9, 9, 0) }), log: r.log, error: r.error, exit: r.exit });
  const tail = r.of('error')[0].split('\nzinstrumentowany:\n')[0].replace(/^baza:\n/, '').split('\n');
  assert.equal(tail.length, 30);
  assert.ok(!tail.includes('linia 1'));
  assert.ok(tail.includes('ℹ fail 0'));
});

test('zero-check main: odmowa bramki przerywa przed zapisem i procesem', async () => {
  const root = zeroRoot();
  const spawn = fakeSpawn();
  await assert.rejects(zero.main(['node', 'zero-check.js', 'Tiny.gs'], { root, guard: async () => { throw new Error('brak izolacji'); }, spawn }), /brak izolacji/);
  assert.equal(spawn.calls.length, 0);
  assert.equal(exists(root, 'reports'), false);
});

// --- trial.js ----------------------------------------------------------------------------------------

const trial = require('../scripts/mutation/trial.js');
const runFile = require('../scripts/mutation/run-file.js');

const trialReport = () => ({ files: { 'Tiny.js': { mutants: [mutant('1', 'Killed', ASSERT), mutant('2', 'Killed', ASSERT), mutant('3', 'Survived'), mutant('4', 'Killed', 'TypeError: x')] } } });
const TIME = { file: 'Tiny.gs', mutants: 4, indexSeconds: 3, runSeconds: 7, concurrency: 4 };

/** Atrapa kroków trialu: każdy skrypt zapisuje swoje pliki, jak prawdziwy; `statuses` wymusza kod danego skryptu. */
function trialSpawn(root, statuses = {}) {
  return fakeSpawn(({ args }) => {
    const script = path.basename(args[0]);
    if (script === 'run-file.js') {
      fs.writeFileSync(path.join(root, 'reports', 'mutation', 'result-Tiny.json'), JSON.stringify(trialReport()));
      fs.writeFileSync(path.join(root, 'reports', 'mutation', 'time-Tiny.json'), JSON.stringify(TIME));
    }
    return script in statuses ? { status: statuses[script] } : { status: 0 };
  });
}

test('trial main: wywołanie bez poprawnych argumentów to kod 2, bez bramki, czyszczenia i procesów', async () => {
  for (const argv of [['node', 't'], ['node', 't', 'Tiny.gs', '--suite=zly'], ['node', 't', 'Tiny.gs', '--concurrency=0'], ['node', 't', 'Tiny.gs', '--outside=wzgledna']]) {
    const root = makeRoot({ 'reports/stary.txt': 'x' });
    const r = recorder();
    const spawn = fakeSpawn();
    await trial.main(argv, { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
    assert.deepEqual(r.of('guard'), []);
    assert.deepEqual(r.of('exit'), [2]);
    assert.equal(r.of('error').length, 1);
    assert.equal(spawn.calls.length, 0);
    assert.equal(exists(root, 'reports/stary.txt'), true, 'nic nie jest czyszczone przed walidacją wejścia');
  }
});

test('trial main: bramka z opcjami sond, czyszczenie śladów, kolejność kroków z argumentami, podsumowanie', async () => {
  const root = makeRoot({ 'reports/stary.txt': 'x', '.stryker-shadow/stary.js': 'x', '.stryker-tmp/stary/plik': 'x', 'src/zostaje.txt': 'x' });
  const events = [];
  const guard = async (tool, options) => { events.push(['guard', tool, options]); assert.equal(exists(root, 'reports/stary.txt'), true, 'bramka przed czyszczeniem'); };
  const log = t => events.push(['log', t]);
  const spawn = trialSpawn(root);
  await trial.main(['node', 't', 'Tiny.gs', '--concurrency=2', '--outside=/a,/b'], { root, guard, spawn, log, error: () => assert.fail('bez błędu'), exit: c => events.push(['exit', c]) });
  assert.deepEqual(events[0], ['guard', 'trial.js', { probeOptions: { outside: ['/a', '/b'] } }]);
  assert.equal(exists(root, 'reports/stary.txt'), false);
  assert.equal(exists(root, '.stryker-shadow/stary.js'), false);
  assert.equal(exists(root, '.stryker-tmp'), false);
  assert.equal(exists(root, 'src/zostaje.txt'), true);
  assert.deepEqual(JSON.parse(read(root, 'reports/mutation/isolation.json')), { verified: true, node: process.version, platform: process.platform });
  const env = safeEnv(process.env);
  assert.deepEqual(spawn.calls.map(c => [path.basename(c.args[0]), c.args.slice(1)]), [
    ['zero-check.js', ['Tiny.gs']], ['canary.js', []], ['coverage-map.js', []], ['run-file.js', ['Tiny.gs', '--suite=per-mutant', '--concurrency=2']]
  ]);
  assert.ok(spawn.calls.every(c => c.cmd === process.execPath && c.args[0].startsWith(SCRIPTS)));
  assert.ok(spawn.calls.every(c => JSON.stringify(c.opts) === JSON.stringify({ cwd: root, stdio: 'inherit', env })));
  const summary = { file: 'Tiny.gs', suite: 'per-mutant', mutants: 4, counts: { 'killed-assert': 2, Survived: 1, 'killed-other': 1 }, killedAssert: 2, score: 50, indexSeconds: 3, runSeconds: 7, concurrency: 4 };
  assert.deepEqual(JSON.parse(read(root, 'reports/mutation/summary.json')), summary);
  assert.equal(read(root, 'reports/mutation/summary.json'), JSON.stringify(summary, null, 1));
  assert.equal(read(root, 'reports/mutation/summary.md'), trial.summaryMarkdown(summary));
  assert.deepEqual(events.slice(1), [['log', trial.summaryMarkdown(summary)]], 'bez wyjścia przy powodzeniu');
});

test('trial main: zestawy file i full nie liczą mapy pokrycia; domyślnie 4 procesy i zestaw per-mutant', async () => {
  for (const suite of ['file', 'full']) {
    const root = makeRoot();
    const spawn = trialSpawn(root);
    const r = recorder();
    await trial.main(['node', 't', 'Tiny.gs', `--suite=${suite}`], { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
    assert.deepEqual(spawn.calls.map(c => path.basename(c.args[0])), ['zero-check.js', 'canary.js', 'run-file.js']);
    assert.deepEqual(spawn.calls[2].args.slice(1), ['Tiny.gs', `--suite=${suite}`, '--concurrency=4']);
    assert.deepEqual(r.of('guard'), ['trial.js']);
    assert.equal(JSON.parse(read(root, 'reports/mutation/summary.json')).suite, suite);
  }
  const root = makeRoot();
  const spawn = trialSpawn(root);
  const r = recorder();
  await trial.main(['node', 't', 'Tiny.gs'], { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
  assert.deepEqual(spawn.calls[3].args.slice(1), ['Tiny.gs', '--suite=per-mutant', '--concurrency=4']);
});

test('trial main: nieudany krok przerywa przebieg; brak izolacji (3) zostaje 3, reszta (także brak kodu) to 4', async () => {
  const cases = [['zero-check.js', 3, 3, 1], ['canary.js', 1, 4, 2], ['coverage-map.js', null, 4, 3], ['run-file.js', 2, 4, 4], ['canary.js', 4, 4, 2]];
  for (const [script, status, expected, calls] of cases) {
    const root = makeRoot();
    const r = recorder();
    const spawn = trialSpawn(root, { [script]: status });
    await trial.main(['node', 't', 'Tiny.gs'], { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
    assert.deepEqual(r.of('exit'), [expected], `${script} ${status}`);
    assert.deepEqual(r.of('error'), [`${script}: kod ${status === null ? 1 : status}, przebieg przerwany`]);
    assert.equal(spawn.calls.length, calls, 'kolejne kroki się nie uruchamiają');
    assert.deepEqual(r.of('log'), []);
    assert.equal(exists(root, 'reports/mutation/summary.json'), false);
  }
});

test('trial main: odmowa bramki przerywa przed czyszczeniem i zapisem', async () => {
  const root = makeRoot({ 'reports/stary.txt': 'x' });
  const spawn = fakeSpawn();
  await assert.rejects(trial.main(['node', 't', 'Tiny.gs'], { root, guard: async () => { throw new Error('brak izolacji'); }, spawn }), /brak izolacji/);
  assert.equal(spawn.calls.length, 0);
  assert.equal(exists(root, 'reports/stary.txt'), true);
  assert.equal(exists(root, 'reports/mutation'), false);
});

// --- run-file.js -------------------------------------------------------------------------------------

const INDEX = { files: { '.stryker-shadow/Tiny.js': { mutants: [
  { id: '1', status: 'Survived', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } } },
  { id: '2', status: 'Survived', location: { start: { line: 4, column: 1 }, end: { line: 5, column: 5 } } }
] } } };

function runFileRoot(extra = {}) {
  return makeRoot({
    'stryker.config.json': JSON.stringify({ base: true, concurrency: 9 }),
    'test/b.test.js': '', 'test/a.test.js': '', 'test/mutation-x.test.js': '', 'test/repo-identity.test.js': '', 'test/pomocniczy.js': '',
    ...extra
  });
}

function runFileSpawn(root, { indexReport = INDEX, runStatus = 0, runOut = 'RO', runErr = 'RE' } = {}) {
  return fakeSpawn(({ args }) => {
    if (args[0].endsWith('prepare-shadow.js')) return {};
    if (path.basename(args[2]) === 'cfg-index-Tiny.json') {
      assert.equal(exists(root, 'reports/mutation/index-Tiny.json'), false, 'stary indeks usunięty przed przebiegiem');
      fs.writeFileSync(path.join(root, 'reports', 'mutation', 'index-Tiny.json'), JSON.stringify(indexReport));
      return {};
    }
    return { status: runStatus, stdout: runOut, stderr: runErr };
  });
}

function clock(...ticks) {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

test('run-file main: wywołanie bez poprawnych argumentów to kod 2 przed bramką i zapisem', async () => {
  for (const argv of [['node', 'r'], ['node', 'r', 'Tiny.gs', '--suite=zly'], ['node', 'r', 'Tiny.gs', '--concurrency=0'], ['node', 'r', 'Tiny.gs', '--limit=-1']]) {
    const root = runFileRoot();
    const r = recorder();
    const spawn = fakeSpawn();
    await runFile.main(argv, { root, guard: r.guard, spawn, error: r.error, exit: r.exit });
    assert.deepEqual(r.events.map(e => e[0]), ['error', 'exit']);
    assert.deepEqual(r.of('exit'), [2]);
    assert.equal(spawn.calls.length, 0);
    assert.equal(exists(root, 'reports'), false);
  }
});

test('run-file main: zestaw full, indeks, plik wyboru, konfiguracje przebiegów, log, czasy i kod wyjścia Strykera', async () => {
  const root = runFileRoot();
  const r = recorder();
  const spawn = runFileSpawn(root, { runStatus: 0 });
  await runFile.main(['node', 'r', 'Tiny.gs', '--suite=full', '--concurrency=3'], { root, guard: r.guard, spawn, now: clock(1000, 3600, 4000, 12400), error: r.error, exit: r.exit });
  assert.deepEqual(r.of('guard'), ['run-file.js']);
  const env = safeEnv(process.env);
  assert.equal(spawn.calls.length, 3);
  assert.deepEqual(spawn.calls[0].args, [path.join(SCRIPTS, 'prepare-shadow.js'), 'Tiny.gs']);
  assert.deepEqual(spawn.calls[0].opts, { cwd: root, stdio: 'ignore', env });
  const idxCfg = path.join(root, 'reports', 'mutation', 'cfg-index-Tiny.json');
  const runCfg = path.join(root, 'reports', 'mutation', 'cfg-run-Tiny.json');
  assert.deepEqual(spawn.calls[1].args, [STRYKER, 'run', idxCfg]);
  assert.deepEqual(spawn.calls[2].args, [STRYKER, 'run', runCfg]);
  assert.deepEqual(spawn.calls[1].opts, { cwd: root, encoding: 'utf8', env });
  assert.deepEqual(JSON.parse(fs.readFileSync(idxCfg, 'utf8')), {
    base: true, mutate: ['.stryker-shadow/Tiny.js'], commandRunner: { command: 'node -e "process.exit(process.env.__STRYKER_ACTIVE_MUTANT__!==undefined?1:0)"' },
    reporters: ['json'], jsonReporter: { fileName: path.join('reports', 'mutation', 'index-Tiny.json') }, concurrency: 4
  });
  const selFile = path.join(root, 'reports', 'mutation', 'selection-Tiny.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(runCfg, 'utf8')), {
    base: true, mutate: ['.stryker-shadow/Tiny.js'], commandRunner: { command: 'node scripts/mutation/run-for-mutant.js' },
    reporters: ['json', 'clear-text'], jsonReporter: { fileName: path.join('reports', 'mutation', 'result-Tiny.json') }, concurrency: 3, timeoutMS: 600000
  });
  assert.deepEqual(spawn.calls[2].opts, { cwd: root, encoding: 'utf8', env: safeEnv(process.env, { MUTATION_SELECTION: selFile }) });
  assert.equal(spawn.calls[2].opts.env.MUTATION_SELECTION, selFile);
  const tests = ['a.test.js', 'b.test.js'];
  assert.deepEqual(JSON.parse(fs.readFileSync(selFile, 'utf8')), { source: 'Tiny.gs', all: tests, covering: tests, mutants: { 1: 'ALL', 2: 'ALL' } });
  assert.equal(read(root, 'reports/mutation/log-Tiny.txt'), 'RORE');
  const time = { file: 'Tiny.gs', suite: 'full', mutants: 2, indexSeconds: 3, runSeconds: 8, concurrency: 3 };
  assert.equal(read(root, 'reports/mutation/time-Tiny.json'), JSON.stringify(time));
  assert.deepEqual(r.of('error'), ['indeks Tiny.gs: 2 mutantów w 3 s', 'wybór testów (full): statyczne=0 bez testu=0 z doborem=2', 'przebieg Tiny.gs: 8 s, exit 0']);
  assert.deepEqual(r.of('exit'), [0]);
});

test('run-file main: zestaw file bierze testy pliku z mapy, limit zawęża mutowane linie, nie-full ma krótszy limit czasu', async () => {
  const root = runFileRoot({ '.quality/mutation-tests.json': JSON.stringify({ version: 1, tests: { 'Tiny.gs': ['b.test.js', 'a.test.js'], 'Inny.gs': ['x'] } }) });
  const r = recorder();
  await runFile.main(['node', 'r', 'Tiny.gs', '--suite=file', '--limit=7'], { root, guard: r.guard, spawn: runFileSpawn(root), error: r.error, exit: r.exit });
  const cfg = JSON.parse(read(root, 'reports/mutation/cfg-run-Tiny.json'));
  assert.deepEqual(cfg.mutate, ['.stryker-shadow/Tiny.js:1-7']);
  assert.equal(cfg.timeoutMS, 90000);
  assert.equal(cfg.concurrency, 4, 'domyślna współbieżność');
  const sel = JSON.parse(read(root, 'reports/mutation/selection-Tiny.json'));
  assert.deepEqual(sel.covering, ['a.test.js', 'b.test.js']);
  assert.deepEqual(sel.mutants, { 1: ['a.test.js', 'b.test.js'], 2: ['a.test.js', 'b.test.js'] });
  const noEntry = runFileRoot({ '.quality/mutation-tests.json': JSON.stringify({ version: 1, tests: {} }) });
  const r2 = recorder();
  await runFile.main(['node', 'r', 'Tiny.gs', '--suite=file'], { root: noEntry, guard: r2.guard, spawn: runFileSpawn(noEntry), error: r2.error, exit: r2.exit });
  assert.deepEqual(JSON.parse(read(noEntry, 'reports/mutation/selection-Tiny.json')).mutants, { 1: [], 2: [] });
});

test('run-file main: zestaw per-mutant czyta mapę pokrycia i dzieli mutanty na statyczne, z doborem i bez testu', async () => {
  const coverage = { baseline: { 'Tiny.gs': [1] }, tests: { 'a.test.js': { sources: { 'Tiny.gs': [4] } }, 'b.test.js': { sources: {} } } };
  const root = runFileRoot({ 'reports/mutation/coverage-map.json': JSON.stringify(coverage) });
  const r = recorder();
  const third = { id: '3', status: 'Survived', location: { start: { line: 9, column: 1 }, end: { line: 9, column: 2 } } };
  const index = { files: { f: { mutants: [...INDEX.files['.stryker-shadow/Tiny.js'].mutants, third] } } };
  await runFile.main(['node', 'r', 'Tiny.gs'], { root, guard: r.guard, spawn: runFileSpawn(root, { indexReport: index }), error: r.error, exit: r.exit });
  assert.deepEqual(JSON.parse(read(root, 'reports/mutation/selection-Tiny.json')).mutants, { 1: 'STATIC', 2: ['a.test.js'], 3: [] });
  assert.ok(r.of('error').includes('wybór testów (per-mutant): statyczne=1 bez testu=1 z doborem=1'));
});

test('run-file main: kod wyjścia Strykera jest przekazywany, brak kodu to 1, a log składa się z samego stdout lub stderr', async () => {
  for (const [options, code, log] of [[{ runStatus: 2, runOut: 'O', runErr: null }, 2, 'O'], [{ runStatus: null, runOut: null, runErr: 'E' }, 1, 'E']]) {
    const root = runFileRoot();
    const r = recorder();
    await runFile.main(['node', 'r', 'Tiny.gs', '--suite=full'], { root, guard: r.guard, spawn: runFileSpawn(root, options), error: r.error, exit: r.exit });
    assert.deepEqual(r.of('exit'), [code]);
    assert.equal(read(root, 'reports/mutation/log-Tiny.txt'), log);
  }
});

test('run-file main: stary indeks nie udaje wyniku, a odmowa bramki przerywa przed zapisem', async () => {
  const root = runFileRoot({ 'reports/mutation/index-Tiny.json': JSON.stringify(INDEX) });
  const r = recorder();
  const spawn = fakeSpawn(() => ({ status: 1 }));
  await assert.rejects(runFile.main(['node', 'r', 'Tiny.gs', '--suite=full'], { root, guard: r.guard, spawn, error: r.error, exit: r.exit }), /ENOENT/);
  const spawn2 = fakeSpawn();
  const root2 = runFileRoot();
  await assert.rejects(runFile.main(['node', 'r', 'Tiny.gs'], { root: root2, guard: async () => { throw new Error('brak izolacji'); }, spawn: spawn2 }), /brak izolacji/);
  assert.equal(spawn2.calls.length, 0);
  assert.equal(exists(root2, 'reports'), false);
});

// --- validate-selection.js ---------------------------------------------------------------------------

const validate = require('../scripts/mutation/validate-selection.js');

const vm = (id, status, line, mutatorName = 'Op') => ({ id, status, mutatorName, location: { start: { line, column: 1 }, end: { line, column: 2 } } });

function validateRoot(extra = {}) {
  const mutants = [vm('1', 'Survived', 10), vm('2', 'Survived', 20), vm('3', 'Killed', 30), vm('4', 'Survived', 40)];
  const sel = { source: 'Tiny.gs', all: ['a.test.js', 'b.test.js', 'c.test.js'], covering: ['a.test.js'], mutants: { 1: ['a.test.js'], 2: 'STATIC', 3: ['a.test.js'], 4: [] } };
  return makeRoot({
    'stryker.config.json': JSON.stringify({ base: true, concurrency: 9 }),
    'reports/mutation/result-Tiny.json': JSON.stringify({ files: { f: { mutants } } }),
    'reports/mutation/selection-Tiny.json': JSON.stringify(sel),
    ...extra
  });
}

function validateSpawn(root, { report = true, valStatuses = { 1: 'Killed', 2: 'Survived', 4: 'Killed' }, runStatus = 0, stdout = '' } = {}) {
  return fakeSpawn(({ args }) => {
    if (args[0].endsWith('prepare-shadow.js')) return {};
    if (report) {
      const mutants = Object.entries(valStatuses).map(([id, status]) => ({ id, status }));
      fs.writeFileSync(path.join(root, 'reports', 'mutation', 'val-Tiny.json'), JSON.stringify({ files: { f: { mutants } } }));
    }
    return { status: runStatus, stdout };
  });
}

test('validate-selection main: wywołanie bez poprawnej nazwy to kod 2 przed bramką i zapisem', async () => {
  for (const argv of [['node', 'v'], ['node', 'v', '../x.gs'], ['node', 'v', 'x.js'], ['node', 'v', 'Tiny.gsx'], ['node', 'v', 'x/Tiny.gs'], ['node', 'v', 'Tiny_gs']]) {
    const root = validateRoot();
    const r = recorder();
    const spawn = fakeSpawn();
    await validate.main(argv, { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
    assert.deepEqual(r.events, [['error', 'Podaj nazwę pliku z src/, np. WordPress.gs'], ['exit', 2]]);
    assert.equal(spawn.calls.length, 0);
  }
});

test('validate-selection main: plik wyboru kontroli, konfiguracja, procesy z argumentami i raport zabitych pełnym zestawem', async () => {
  const root = validateRoot({ 'reports/mutation/val-Tiny.json': JSON.stringify({ stary: true }) });
  const r = recorder();
  const spawn = validateSpawn(root, { runStatus: 5 });
  await validate.main(['node', 'v', 'Tiny.gs', '--exclude=c.test.js'], { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
  assert.deepEqual(r.of('guard'), ['validate-selection.js']);
  const out = path.join(root, 'reports', 'mutation');
  const valFile = path.join(out, 'selection-val-Tiny.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(valFile, 'utf8')), {
    source: 'Tiny.gs', all: ['a.test.js', 'b.test.js'], covering: ['a.test.js', 'b.test.js'], mutants: { 1: 'ALL', 2: 'ALL', 3: [], 4: 'ALL' }
  });
  const cfgFile = path.join(out, 'cfg-val-Tiny.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')), {
    base: true, mutate: ['.stryker-shadow/Tiny.js'], commandRunner: { command: 'node scripts/mutation/run-for-mutant.js' },
    reporters: ['json'], jsonReporter: { fileName: path.join('reports', 'mutation', 'val-Tiny.json') }, concurrency: 4, timeoutMS: 600000
  });
  assert.equal(spawn.calls.length, 2);
  assert.deepEqual(spawn.calls[0].args, [path.join(SCRIPTS, 'prepare-shadow.js'), 'Tiny.gs']);
  assert.deepEqual(spawn.calls[0].opts, { cwd: root, stdio: 'ignore', env: safeEnv(process.env) });
  assert.deepEqual(spawn.calls[1].args, [STRYKER, 'run', cfgFile]);
  assert.deepEqual(spawn.calls[1].opts, { cwd: root, encoding: 'utf8', env: safeEnv(process.env, { MUTATION_SELECTION: valFile }) });
  assert.equal(spawn.calls[1].opts.env.MUTATION_SELECTION, valFile);
  const result = {
    file: 'Tiny.gs', exit: 5, probe: 3, survivors: 2, noCoverage: 1, staticInSample: 1,
    killedByFullSuite: [
      { static: false, id: '1', line: 10, mutator: 'Op', was: 'Survived', now: 'Killed' },
      { static: false, id: '4', line: 40, mutator: 'Op', was: 'NoCoverage', now: 'Killed' }
    ]
  };
  assert.deepEqual(JSON.parse(read(root, 'reports/mutation/validation-Tiny.json')), result);
  assert.equal(read(root, 'reports/mutation/validation-Tiny.json'), JSON.stringify(result, null, 1));
  assert.deepEqual(r.of('log'), [JSON.stringify(result, null, 1)]);
  assert.deepEqual(r.of('exit'), []);
});

test('validate-selection main: stary raport kontroli nie udaje wyniku; brak raportu to kod 1 z początkiem błędów Strykera', async () => {
  const root = validateRoot({ 'reports/mutation/val-Tiny.json': JSON.stringify({ files: { f: { mutants: [{ id: '1', status: 'Killed' }] } } }) });
  const r = recorder();
  const noise = ['ok', ...Array.from({ length: 20 }, (_, i) => `ERROR numer ${i}`), '✖ test', 'inne failed'].join('\n');
  const spawn = validateSpawn(root, { report: false, stdout: noise });
  await validate.main(['node', 'v', 'Tiny.gs'], { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
  assert.equal(exists(root, 'reports/mutation/val-Tiny.json'), false);
  assert.deepEqual(r.of('exit'), [1]);
  assert.deepEqual(r.of('error'), [Array.from({ length: 15 }, (_, i) => `ERROR numer ${i}`).join(' | ')]);
  assert.deepEqual(r.of('log'), []);
  assert.equal(exists(root, 'reports/mutation/validation-Tiny.json'), false);
  const r2 = recorder();
  const empty = fakeSpawn(() => ({ status: 1, stdout: undefined }));
  await validate.main(['node', 'v', 'Tiny.gs'], { root, guard: r2.guard, spawn: empty, log: r2.log, error: r2.error, exit: r2.exit });
  assert.deepEqual(r2.of('error'), ['']);
  assert.deepEqual(r2.of('exit'), [1]);
});

test('validate-selection main: opcje --ids i limity próbki trafiają do pliku wyboru kontroli', async () => {
  const root = validateRoot();
  const r = recorder();
  await validate.main(['node', 'v', 'Tiny.gs', '--ids=2'], { root, guard: r.guard, spawn: validateSpawn(root, { valStatuses: { 2: 'Killed' } }), log: r.log, error: r.error, exit: r.exit });
  assert.deepEqual(JSON.parse(read(root, 'reports/mutation/selection-val-Tiny.json')).mutants, { 1: [], 2: 'ALL', 3: [], 4: [] });
  const result = JSON.parse(read(root, 'reports/mutation/validation-Tiny.json'));
  assert.equal(result.probe, 1);
  assert.deepEqual(result.killedByFullSuite.map(k => [k.id, k.static]), [['2', true]]);
});

test('validate-selection main: odmowa bramki przerywa przed zapisem i procesem', async () => {
  const root = validateRoot();
  const spawn = fakeSpawn();
  await assert.rejects(validate.main(['node', 'v', 'Tiny.gs'], { root, guard: async () => { throw new Error('brak izolacji'); }, spawn }), /brak izolacji/);
  assert.equal(spawn.calls.length, 0);
  assert.equal(exists(root, 'reports/mutation/selection-val-Tiny.json'), false);
});

// --- run-tests.js ------------------------------------------------------------------------------------

const runTests = require('../scripts/mutation/run-tests.js');
const coverageMap = require('../scripts/mutation/coverage-map.js');
const report = require('../scripts/mutation/report.js');

test('run-tests main: bramka z nazwą narzędzia, wszystkie testy poza wykluczonymi, dokładne argumenty i kod wyjścia', () => {
  const root = makeRoot({ 'test/b.test.js': '', 'test/a.test.js': '', 'test/mutation-x.test.js': '', 'test/repo-identity.test.js': '', 'test/inny.js': '' });
  const r = recorder();
  const spawn = fakeSpawn(() => ({ status: 7 }));
  runTests.main(['node', 'run-tests.js'], { root, guard: name => r.events.push(['guard', name]), spawn, exit: c => r.events.push(['exit', c]) });
  assert.deepEqual(r.events, [['guard', 'run-tests.js'], ['exit', 7]]);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].cmd, process.execPath);
  assert.deepEqual(spawn.calls[0].args, ['--require', path.join(SCRIPTS, 'vm-preload.js'), '--test', '--test-concurrency=2', path.join('test', 'a.test.js'), path.join('test', 'b.test.js')]);
  assert.deepEqual(spawn.calls[0].opts, { cwd: root, stdio: 'inherit', env: safeEnv(process.env) });
});

test('run-tests main: wskazane pliki przechodzą bez zmian, brak kodu procesu to 1, odmowa bramki przerywa przed procesem', () => {
  const root = makeRoot({ 'test/a.test.js': '' });
  const events = [];
  const spawn = fakeSpawn(() => ({ status: null }));
  runTests.main(['node', 'run-tests.js', 'test/x.test.js', 'test/y.test.js'], { root, guard: () => {}, spawn, exit: c => events.push(c) });
  assert.deepEqual(spawn.calls[0].args.slice(4), ['test/x.test.js', 'test/y.test.js']);
  assert.deepEqual(events, [1]);
  const spawn2 = fakeSpawn();
  assert.throws(() => runTests.main(['node', 'run-tests.js'], { root, guard: () => { throw new Error('brak izolacji'); }, spawn: spawn2, exit: () => assert.fail('bez wyjścia') }), /brak izolacji/);
  assert.equal(spawn2.calls.length, 0);
});

// --- coverage-map.js ---------------------------------------------------------------------------------

const lcovText = (...sources) => sources.map(([name, hits]) => `SF:C:\\repo\\src\\${name}\n${hits.map(([l, h]) => `DA:${l},${h}`).join('\n')}\nend_of_record\n`).join('');

/** Atrapa pomiaru pokrycia: wskazany plik testu dostaje LCOV z `byTest`, nieznany bez LCOV. */
function coverageSpawn(byTest, statuses = {}) {
  return fakeSpawn(({ args }) => {
    const testFile = args[args.length - 1];
    const destination = args.find(a => a.startsWith('--test-reporter-destination=')).slice('--test-reporter-destination='.length);
    if (byTest[testFile] !== undefined) fs.writeFileSync(destination, byTest[testFile]);
    return { status: statuses[testFile] === undefined ? 0 : statuses[testFile], stderr: 'BŁĄD' };
  });
}

test('coverage-map main: baza, linie testu ponad bazą, bySource, exit testu, postęp i podsumowanie', () => {
  const root = makeRoot({ 'test/b.test.js': '', 'test/a.test.js': '', 'test/repo-identity.test.js': '', 'test/mutation-x.test.js': '' });
  const byTest = {
    [path.join('scripts', 'mutation', 'load-only.test.js')]: lcovText(['Dates.gs', [[9, 1], [1, 1], [7, 1], [8, 1], [2, 0]]]),
    [path.join('test', 'a.test.js')]: lcovText(['Dates.gs', [[1, 1], [2, 3], [3, 1], [4, 0], [10, 1]]], ['Nowy.gs', [[5, 1], [6, 0]]]),
    [path.join('test', 'b.test.js')]: lcovText(['Dates.gs', [[1, 5], [2, 0]]])
  };
  const spawn = coverageSpawn(byTest, { [path.join('test', 'b.test.js')]: 1 });
  const logs = [];
  const progress = [];
  coverageMap.main({ root, spawn, log: t => logs.push(t), progress: t => progress.push(t) });
  const tmp = path.join(root, 'reports', 'mutation', 'tmp-lcov');
  assert.deepEqual(spawn.calls.map(c => c.args), [
    ['--test', '--experimental-test-coverage', '--test-coverage-include=src/*.gs', '--test-reporter=lcov', `--test-reporter-destination=${path.join(tmp, 'baseline.info')}`, path.join('scripts', 'mutation', 'load-only.test.js')],
    ['--test', '--experimental-test-coverage', '--test-coverage-include=src/*.gs', '--test-reporter=lcov', `--test-reporter-destination=${path.join(tmp, 'a_test_js.info')}`, path.join('test', 'a.test.js')],
    ['--test', '--experimental-test-coverage', '--test-coverage-include=src/*.gs', '--test-reporter=lcov', `--test-reporter-destination=${path.join(tmp, 'b_test_js.info')}`, path.join('test', 'b.test.js')]
  ]);
  assert.ok(spawn.calls.every(c => c.cmd === process.execPath && JSON.stringify(c.opts) === JSON.stringify({ cwd: root, encoding: 'utf8', env: safeEnv(process.env) })));
  const expected = {
    baseline: { 'Dates.gs': [1, 7, 8, 9] },
    tests: { 'a.test.js': { exit: 0, sources: { 'Dates.gs': [2, 3, 10], 'Nowy.gs': [5] } }, 'b.test.js': { exit: 1, sources: {} } },
    bySource: { 'Dates.gs': ['a.test.js'], 'Nowy.gs': ['a.test.js'] }
  };
  assert.equal(read(root, 'reports/mutation/coverage-map.json'), JSON.stringify(expected, null, 1));
  assert.deepEqual(progress, ['a.test.js: 2 plików src\n', 'b.test.js: 0 plików src\n']);
  assert.deepEqual(logs, ['Zapisano reports/mutation/coverage-map.json (2 plików testów)']);
});

test('coverage-map main: domyślny postęp trafia na stderr procesu', () => {
  const root = makeRoot({ 'test/a.test.js': '' });
  const spawn = coverageSpawn({
    [path.join('scripts', 'mutation', 'load-only.test.js')]: lcovText(['Dates.gs', [[1, 1]]]),
    [path.join('test', 'a.test.js')]: lcovText(['Dates.gs', [[1, 1], [2, 1]]])
  });
  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = text => { written.push(text); return true; };
  try {
    coverageMap.main({ root, spawn, log: () => {} });
  } finally {
    process.stderr.write = realWrite;
  }
  assert.deepEqual(written, ['a.test.js: 1 plików src\n']);
});

test('coverage-map main: brak LCOV to błąd z nazwą testu i stderr procesu', () => {
  const root = makeRoot({ 'test/a.test.js': '' });
  assert.throws(() => coverageMap.main({ root, spawn: coverageSpawn({}), log: () => {}, progress: () => {} }), error => error.message === `Brak LCOV dla ${path.join('scripts', 'mutation', 'load-only.test.js')}: BŁĄD`);
  const spawn = coverageSpawn({ [path.join('scripts', 'mutation', 'load-only.test.js')]: lcovText(['Dates.gs', [[1, 1]]]) });
  assert.throws(() => coverageMap.main({ root, spawn, log: () => {}, progress: () => {} }), error => error.message === `Brak LCOV dla ${path.join('test', 'a.test.js')}: BŁĄD`);
});

test('coverage-map extraLines: tylko linie z trafieniem ponad bazą, rosnąco', () => {
  const data = { lines: new Map([[9, 1], [3, 2], [5, 0], [7, 4], [8, 1]]) };
  assert.deepEqual(coverageMap.extraLines(data, new Map([[7, 1], [8, 0]])), [3, 8, 9]);
  assert.deepEqual(coverageMap.extraLines(data, new Map()), [3, 7, 8, 9]);
});

// --- report.js ---------------------------------------------------------------------------------------

function reportRoot() {
  const m = (id, status, line, statusReason) => ({ id, status, statusReason, location: { start: { line } } });
  const mutantsA = [
    m('1', 'Killed', 1, 'AssertionError [ERR_ASSERTION]: x'), m('2', 'Killed', 2, 'AssertionError ... ReferenceError: y'), m('3', 'Survived', 3), m('4', 'Survived', 4),
    m('5', 'Survived', 3), m('6', 'Survived', 9), m('7', 'CompileError', 10), m('8', 'Timeout', 11), m('9', 'Ignored', 13), m('10', 'Killed', 12)
  ];
  const selA = { 1: ['t'], 2: ['t'], 3: ['t'], 4: [], 5: ['t'], 6: ['t'], 7: ['t'], 8: [], 9: ['t'], 10: ['t'] };
  const put = (stem, mutants, sel) => ({
    [`reports/mutation/result-${stem}.json`]: JSON.stringify({ files: { f: { mutants } } }),
    [`reports/mutation/selection-${stem}.json`]: JSON.stringify({ mutants: sel })
  });
  return makeRoot({
    ...put('A', mutantsA, selA),
    ...put('B', [m('1', 'Survived', 1)], { 1: [] }),
    ...put('D.json', [m('1', 'Killed', 1, 'AssertionError'), m('2', 'Killed', 2, 'AssertionError')], { 1: ['t'], 2: ['t'] }),
    ...put('c', [m('1', 'Killed', 1, 'AssertionError')], { 1: ['t'] }),
    ...put('Xresult-Y', [m('1', 'Killed', 1, 'AssertionError')], { 1: ['t'] }),
    'reports/mutation/time-A.json': JSON.stringify({ runSeconds: 12, indexSeconds: 2 }),
    'reports/mutation/result-x.txt': 'x', 'reports/mutation/xresult-C.json': '{}', 'reports/mutation/result-E.json.bak': '{}', 'reports/mutation/resultF.json': '{}',
    'coverage/lcov.info': 'SF:src/A.gs\nDA:1,1\nDA:2,0\nDA:3,0\nDA:4,1\nBRDA:1,0,0,0\nBRDA:1,0,1,2\nBRDA:2,0,0,-\nend_of_record\n',
    '.quality/coverage-policy.json': JSON.stringify({ defaultThreshold: 70, rules: [{ pattern: 'src/Inny.gs', threshold: 10 }, { pattern: 'src/A.gs', threshold: 90 }] })
  });
}

test('report main: bez argumentów bierze result-*.json, liczy statusy, progi LCOV, listy i tabelę', () => {
  const root = reportRoot();
  const logs = [];
  report.main(['node', 'report.js'], { root, log: t => logs.push(t) });
  const summary = JSON.parse(read(root, 'reports/mutation/summary.json'));
  assert.deepEqual(Object.keys(summary), ['A.gs', 'B.gs', 'D.json.gs', 'Xresult-Y.gs', 'c.gs']);
  assert.deepEqual(summary['A.gs'], {
    mutants: 10, 'killed-assert': 1, 'killed-other': 2, Survived: 3, NoCoverage: 1, Timeout: 1, Error: 0, Ignored: 1, CompileError: 1,
    scoreAll: 10, scoreCovered: 11.1,
    lcov: { lines: 4, uncoveredLines: 2, linePct: 50, threshold: 90, gate: 'FAIL', branchTotal: 3, branchMissed: 2 },
    mutantsOnUncoveredLines: 3, survivedOnCoveredLines: 1, seconds: 12, indexSeconds: 2
  });
  assert.deepEqual(summary['B.gs'], {
    mutants: 1, 'killed-assert': 0, 'killed-other': 0, Survived: 0, NoCoverage: 1, Timeout: 0, Error: 0, Ignored: 0,
    scoreAll: 0, scoreCovered: null,
    lcov: { lines: 0, uncoveredLines: 0, linePct: 100, threshold: 70, gate: 'OK', branchTotal: 0, branchMissed: 0 },
    mutantsOnUncoveredLines: 0, survivedOnCoveredLines: 0
  });
  assert.equal(summary['Xresult-Y.gs'].scoreAll, 100);
  assert.equal(summary['D.json.gs'].scoreAll, 100);
  assert.equal(summary['D.json.gs'].scoreCovered, 100);
  assert.equal(read(root, 'reports/mutation/summary.json'), JSON.stringify(summary, null, 1));
  assert.deepEqual(logs, [JSON.stringify(summary, null, 1)]);
  const table = read(root, 'reports/mutation/TABELA.md').split('\n');
  assert.equal(table.length, 9);
  assert.ok(table[0].startsWith('| Plik | Mutantów |') && table[0].endsWith('| Niepokryte linie |'));
  assert.equal(table[1], '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  assert.equal(table[2], '| A.gs | 10 | 1 | 2 | 3 | 1 | 1 | 10 % | 50 % (90 %) | 2 |');
  assert.equal(table[3], '| B.gs | 1 | 0 | 0 | 0 | 1 | 0 | 0 % | 100 % (70 %) | 0 |');
  assert.equal(table[4], '| D.json.gs | 2 | 2 | 0 | 0 | 0 | 0 | 100 % | 100 % (70 %) | 0 |');
  assert.equal(table[5], '| Xresult-Y.gs | 1 | 1 | 0 | 0 | 0 | 0 | 100 % | 100 % (70 %) | 0 |');
  assert.equal(table[6], '| c.gs | 1 | 1 | 0 | 0 | 0 | 0 | 100 % | 100 % (70 %) | 0 |');
  assert.equal(table[7], '| **Razem** | **15** | **5** | **2** | **3** | **2** | **1** | **33.3 %** |  |  |');
  assert.equal(table[8], '');
  const lists = read(root, 'reports/mutation/LISTY.md').split('\n');
  assert.deepEqual(lists.slice(0, 11), [
    '# Listy: pokrycie i mutacje (pilot)', '', '## A.gs', '',
    '- Niepokryte linie (LCOV, 2 z 4): 2-3',
    '- Ocalałe na liniach pokrytych (asercja nie łapie): 3 9 [3 mutantów]',
    '- Bez pokrycia (żaden test nie wykonuje linii): 4 [1 mutantów]',
    '- Przekroczenia czasu: 11 [1 mutantów]',
    '- Zabite bez asercji (nie liczone): 2 12 [2 mutantów]',
    '- Błędy kompilacji/uruchomienia mutanta: 10 [1 mutantów]', ''
  ]);
  assert.deepEqual(lists.slice(11, 19), [
    '## B.gs', '', '- Niepokryte linie (LCOV, 0 z 0): brak', '- Ocalałe na liniach pokrytych (asercja nie łapie): brak',
    '- Bez pokrycia (żaden test nie wykonuje linii): 1 [1 mutantów]', '- Przekroczenia czasu: brak', '- Zabite bez asercji (nie liczone): brak', '- Błędy kompilacji/uruchomienia mutanta: brak'
  ]);
});

test('report main: wskazane pliki, bez progu w polityce domyślny, bez pliku czasu pola czasu puste, próg równy to OK', () => {
  const root = reportRoot();
  fs.writeFileSync(path.join(root, '.quality', 'coverage-policy.json'), JSON.stringify({ defaultThreshold: 50, rules: [] }));
  report.main(['node', 'report.js', 'A.gs'], { root, log: () => {} });
  const summary = JSON.parse(read(root, 'reports/mutation/summary.json'));
  assert.deepEqual(Object.keys(summary), ['A.gs']);
  assert.equal(summary['A.gs'].lcov.threshold, 50);
  assert.equal(summary['A.gs'].lcov.gate, 'OK', 'linePct równy progowi to OK');
  fs.rmSync(path.join(root, 'reports', 'mutation', 'time-A.json'));
  report.main(['node', 'report.js', 'A.gs'], { root, log: () => {} });
  const again = JSON.parse(read(root, 'reports/mutation/summary.json'))['A.gs'];
  assert.equal('seconds' in again, false);
  assert.equal('indexSeconds' in again, false);
});

test('report lineList i PROGRAM_ERROR: zakresy z liczbą mutantów, błędy programu rozpoznawane', () => {
  assert.equal(report.lineList([5, 3, 4, 4, 9]), '3-5 9 [5 mutantów]');
  for (const text of ['ReferenceError: x', 'SyntaxError', 'Cannot find module a', 'stryker_x is not defined']) assert.ok(report.PROGRAM_ERROR.test(text), text);
  for (const text of ['MyReferenceErrors', 'Cannot find a', 'AssertionError']) assert.equal(report.PROGRAM_ERROR.test(text), false, text);
});

// --- brak skutków ubocznych przy wczytaniu modułu ------------------------------------------------------

test('wczytanie modułu narzędzia nie uruchamia go (warunek require.main === module)', () => {
  const childProcess = require('node:child_process');
  const real = childProcess.spawnSync;
  const exits = [];
  const realExit = process.exit;
  const realLog = console.log;
  const spawned = [];
  const logged = [];
  childProcess.spawnSync = (...args) => { spawned.push(args); return { status: 0, stdout: '', stderr: '' }; };
  process.exit = code => { exits.push(code); };
  console.log = (...args) => { logged.push(args); };
  try {
    for (const tool of ['baseline.js', 'canary.js', 'classify.js', 'coverage-map.js', 'report.js', 'run-file.js', 'run-for-mutant.js', 'run-tests.js', 'tests-map.js', 'trial.js', 'validate-selection.js', 'zero-check.js']) {
      const file = path.join(SCRIPTS, tool);
      delete require.cache[require.resolve(file)];
      require(file);
    }
  } finally {
    childProcess.spawnSync = real;
    process.exit = realExit;
    console.log = realLog;
  }
  assert.deepEqual(exits, []);
  assert.deepEqual(spawned, []);
  assert.deepEqual(logged, []);
});

// --- stałe i komunikaty --------------------------------------------------------------------------------

test('repo-root: korzeń repozytorium to dwa katalogi nad scripts/mutation', () => {
  assert.equal(require('../scripts/mutation/repo-root.js'), path.resolve(__dirname, '..'));
});

test('canaryVerdict: dokładne komunikaty dla zbyt małej liczby mutantów, ocalałych i powodzenia', () => {
  assert.deepEqual(canary.canaryVerdict(killedReport(8)), { ok: true, reason: 'kanarek: 8 z 8 zabitych z asercją', counts: { 'killed-assert': 8 } });
  assert.deepEqual(canary.canaryVerdict(killedReport(3)), { ok: false, reason: 'kanarek ma 3 mutantów, oczekiwano co najmniej 8', counts: { 'killed-assert': 3 } });
  const mixed = { files: { 'MutationCanary.js': { mutants: [...killedReport(8).files['MutationCanary.js'].mutants, mutant('9', 'Survived')] } } };
  assert.deepEqual(canary.canaryVerdict(mixed), {
    ok: false, reason: 'kanarek: 8 z 9 mutantów zabitych z asercją (reszta: {"killed-assert":8,"Survived":1})', counts: { 'killed-assert': 8, Survived: 1 }
  });
});

// --- zero-check: instrumentacja i ogon wyjścia -----------------------------------------------------------

test('zero-check looksInstrumented: preludium Strykera i różnica względem cienia, tylko dla tekstu', () => {
  const marked = 'stryNS_9fa48 stryCov_9fa48';
  assert.equal(zero.looksInstrumented(marked, 'inny tekst'), true);
  assert.equal(zero.looksInstrumented(marked, marked), false, 'identyczny z cieniem to brak instrumentacji');
  assert.equal(zero.looksInstrumented(Buffer.from(marked), 'inny tekst'), false, 'bufor nie jest tekstem pliku');
  assert.equal(zero.looksInstrumented(5, 'x'), false);
  assert.equal(zero.looksInstrumented(undefined, 'x'), false);
  assert.equal(zero.looksInstrumented('stryNS_9fa48', 'x'), false);
  assert.equal(zero.looksInstrumented('stryCov_9fa48', 'x'), false);
  assert.equal(zero.looksInstrumented('stryNS_ stryCov_', 'x'), false, 'po podkreślniku musi być znak nazwy');
  assert.equal(zero.looksInstrumented('stryNS_a', 'stryCov_a'), false);
  assert.equal(zero.looksInstrumented('zwykły kod', 'x'), false);
});

test('zero-check main: kopia robocza identyczna z cieniem nie jest zinstrumentowana nawet ze znacznikami w tekście', async () => {
  const root = zeroRoot();
  const r = recorder();
  const spawn = zeroSpawn(root, { shadow: INSTRUMENTED, instrumented: INSTRUMENTED });
  await zero.main(['node', 'zero-check.js', 'Tiny.gs'], { root, guard: r.guard, spawn, log: r.log, error: r.error, exit: r.exit });
  assert.deepEqual(r.of('exit'), [4]);
  assert.deepEqual(r.of('log'), ['plik w kopii roboczej Strykera nie jest zinstrumentowany: kontrola byłaby pusta']);
});

test('zero-check main: ogon wyjścia składa się ze stdout i stderr (każde może być puste)', async () => {
  const tailOf = text => text.split('\n').slice(-30).join('\n');
  const cases = [
    { baseOut: 'O1', baseErr: 'E1', sandboxOut: 'O2', sandboxErr: 'E2', base: 'O1E1', instr: 'O2E2' },
    { baseOut: '', baseErr: 'E1', sandboxOut: SUMMARY(9, 9, 0), sandboxErr: null, base: 'E1', instr: tailOf(SUMMARY(9, 9, 0)) },
    { baseOut: null, baseErr: 'E1', sandboxOut: 'O2', sandboxErr: '', base: 'E1', instr: 'O2' }
  ];
  for (const c of cases) {
    const root = zeroRoot();
    const r = recorder();
    await zero.main(['node', 'zero-check.js', 'Tiny.gs'], { root, guard: r.guard, spawn: zeroSpawn(root, c), log: r.log, error: r.error, exit: r.exit });
    assert.deepEqual(r.of('exit'), [4]);
    assert.deepEqual(r.of('error'), [`baza:\n${c.base}\nzinstrumentowany:\n${c.instr}`]);
  }
});

test('zero-check main: stdout przebiegu bazowego z podsumowaniem i pustym stderr daje poprawny wynik, a null w stdout nie psuje', async () => {
  const root = zeroRoot();
  const r = recorder();
  await zero.main(['node', 'zero-check.js', 'Tiny.gs'], { root, guard: r.guard, spawn: zeroSpawn(root, { baseOut: SUMMARY(10, 10, 0), baseErr: null, sandboxErr: null }), log: r.log, error: r.error, exit: r.exit });
  assert.deepEqual(r.of('exit'), [0]);
});

// --- nazwa pliku -------------------------------------------------------------------------------------

test('source-name stemOf: rdzeń nazwy dla poprawnej nazwy, null dla pozostałych', () => {
  const { stemOf } = require('../scripts/mutation/source-name.js');
  assert.equal(stemOf('Payloads.gs'), 'Payloads');
  assert.equal(stemOf('a1Z9.gs'), 'a1Z9');
  for (const bad of ['', undefined, null, 'Payloads', 'Payloads.js', 'Payloads.gsx', 'xPayloads.gs.js', '../Payloads.gs', 'a/b.gs', 'a b.gs', 'a-b.gs', '.gs', 'Pay_loads.gs', 'Payloads.gs\n', 'Payloads_gs', 'Payloadsxgs']) {
    assert.equal(stemOf(bad), null, String(bad));
  }
});

test('report main: nazwa z kropką w rdzeniu (np. Z.gsX.gs) czyta wyniki pod pełnym rdzeniem', () => {
  const root = makeRoot({
    'reports/mutation/result-Z.gsX.json': JSON.stringify({ files: { f: { mutants: [{ id: '1', status: 'Killed', statusReason: 'AssertionError', location: { start: { line: 1 } } }] } } }),
    'reports/mutation/selection-Z.gsX.json': JSON.stringify({ mutants: { 1: ['t'] } }),
    'coverage/lcov.info': '',
    '.quality/coverage-policy.json': JSON.stringify({ defaultThreshold: 1, rules: [] })
  });
  report.main(['node', 'report.js', 'Z.gsX.gs'], { root, log: () => {} });
  assert.deepEqual(Object.keys(JSON.parse(read(root, 'reports/mutation/summary.json'))), ['Z.gsX.gs']);
});

// --- validate-selection: próbka ------------------------------------------------------------------------

test('validate-selection every: równomierna próbka, a przy n nie mniejszym niż długość cała lista', () => {
  assert.deepEqual(validate.every([1, 2, 3], 3), [1, 2, 3]);
  assert.deepEqual(validate.every([1, 2, 3], 5), [1, 2, 3]);
  assert.deepEqual(validate.every([1, 2, 3, 4, 5, 6], 3), [1, 3, 5]);
  assert.deepEqual(validate.every([1, 2, 3, 4, 5], 2), [1, 3]);
  assert.deepEqual(validate.every([], 3), []);
});

test('validate-selection chooseSample: ocalałe z testami i bez, tylko Survived, mutant spoza wyboru liczy się jako z testami, wiele id', () => {
  const mutants = [vm('1', 'Survived', 1), vm('2', 'Killed', 2), vm('3', 'Killed', 3), vm('4', 'Survived', 4), vm('12', 'Survived', 5), vm('5', 'Survived', 6)];
  const sel = { mutants: { 1: ['t'], 2: ['t'], 3: [], 4: [], 12: 'STATIC' } };
  const all = validate.chooseSample(mutants, sel, ['node', 'v']);
  assert.deepEqual(all.survivors.map(m => m.id), ['1', '12', '5']);
  assert.deepEqual(all.noCov.map(m => m.id), ['4']);
  assert.deepEqual(all.sample.map(m => m.id), ['1', '12', '5', '4']);
  assert.deepEqual(validate.chooseSample(mutants, sel, ['node', 'v', '--ids=12,4']).sample.map(m => m.id), ['4', '12']);
  assert.deepEqual(validate.chooseSample(mutants, sel, ['node', 'v', '--ids=12']).sample.map(m => m.id), ['12']);
  assert.deepEqual(validate.chooseSample(mutants, sel, ['node', 'v', '--survived=1', '--nocov=0']).sample.map(m => m.id), ['1']);
  assert.equal(all.noTests(mutants[3]), true);
  assert.equal(all.noTests(mutants[0]), false);
  assert.equal(all.noTests(mutants[5]), false);
});

test('validate-selection excludedOf: lista testów z opcji albo pusta', () => {
  assert.deepEqual(validate.excludedOf(['node', 'v']), []);
  assert.deepEqual(validate.excludedOf(['node', 'v', '--exclude=a.test.js,b.test.js']), ['a.test.js', 'b.test.js']);
  assert.deepEqual(validate.excludedOf(['node', 'v', '--survived=3']), []);
});

// --- wejścia z wiersza poleceń (z mostem Strykera, by zmutowany kod w podprocesie był aktywny) ----------------

const CLI_OUTER = process.env.__STRYKER_ACTIVE_MUTANT__;
const CLI_BRIDGE = "globalThis.__stryker__ = Object.assign(globalThis.__stryker__ || {}, { activeMutant: process.env.MUT_OUTER_MUTANT === undefined ? '' : process.env.MUT_OUTER_MUTANT });\n";

function cli(tool, args = []) {
  const dir = makeRoot({ 'stryker-bridge.js': CLI_BRIDGE });
  const outer = CLI_OUTER === undefined ? {} : { MUT_OUTER_MUTANT: CLI_OUTER };
  return require('node:child_process').spawnSync(process.execPath, ['--require', path.join(dir, 'stryker-bridge.js'), path.join(SCRIPTS, tool), ...args], {
    cwd: dir, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH || process.env.Path || '', SystemRoot: process.env.SystemRoot || '', ...outer }
  });
}

test('wejścia CLI: bez nazwy pliku kod 2 z komunikatem, jeszcze przed bramką izolacji', () => {
  const messages = {
    'run-file.js': 'Podaj nazwę pliku z src/, np. WordPress.gs\n', 'validate-selection.js': 'Podaj nazwę pliku z src/, np. WordPress.gs\n',
    'trial.js': 'Podaj nazwę pliku z src/, np. Payloads.gs\n', 'zero-check.js': 'Podaj nazwę pliku z src/, np. Payloads.gs\n'
  };
  for (const [tool, message] of Object.entries(messages)) {
    const r = cli(tool);
    assert.equal(r.status, 2, `${tool}: ${r.stderr}`);
    assert.equal(r.stderr, message, tool);
  }
});

test('wejścia CLI: poza izolatorem bramka odmawia kodem 3', () => {
  for (const [tool, args] of [['canary.js', []], ['run-tests.js', []], ['trial.js', ['Tiny.gs']], ['run-file.js', ['Tiny.gs']], ['zero-check.js', ['Tiny.gs']], ['validate-selection.js', ['Tiny.gs']]]) {
    const r = cli(tool, args);
    assert.equal(r.status, 3, `${tool}: ${r.stderr}`);
    assert.match(r.stderr, /no-go-izolacja/, tool);
  }
});

// --- run-for-mutant.js (w procesie, z atrapami) --------------------------------------------------------

const runForMutant = require('../scripts/mutation/run-for-mutant.js');

function mutantRoot(selection) {
  return makeRoot({
    'selection.json': JSON.stringify(selection),
    'test/big.test.js': 'x'.repeat(40), 'test/mid.test.js': 'x'.repeat(20), 'test/small.test.js': 'x'.repeat(5)
  });
}

function mutantRun(root, id, spawn, extraEnv = {}) {
  const r = recorder();
  const env = { PATH: 'p', GITHUB_TOKEN: 'sekret', MUTATION_SELECTION: path.join(root, 'selection.json'), ...(id === undefined ? {} : { __STRYKER_ACTIVE_MUTANT__: id }), ...extraEnv };
  const guard = tool => r.events.push(['guard', tool]);
  const exit = c => r.events.push(['exit', c]);
  runForMutant.main({ root, env, guard, spawn, error: t => r.events.push(['error', t]), exit });
  return { r, env };
}

test('run-for-mutant main: bramka najpierw, testy od najmniejszego pliku, dokładne argumenty i otoczenie procesu, kod 0', () => {
  const root = mutantRoot({ covering: ['mid.test.js'], all: ['big.test.js'], mutants: { 7: ['mid.test.js', 'big.test.js', 'small.test.js'] } });
  const spawn = fakeSpawn();
  const { r, env } = mutantRun(root, '7', spawn);
  assert.deepEqual(r.events, [['guard', 'run-for-mutant.js'], ['exit', 0]]);
  assert.deepEqual(spawn.calls.map(c => c.args[3]), [path.join('test', 'small.test.js'), path.join('test', 'mid.test.js'), path.join('test', 'big.test.js')]);
  for (const call of spawn.calls) {
    assert.equal(call.cmd, process.execPath);
    assert.deepEqual(call.args.slice(0, 3), ['--require', path.join(SCRIPTS, 'vm-preload.js'), '--test']);
    assert.equal(call.opts.cwd, root);
    assert.equal(call.opts.stdio, 'inherit');
    assert.deepEqual(call.opts.env, safeEnv(env));
    assert.equal(call.opts.env.GITHUB_TOKEN, undefined);
    assert.equal(call.opts.env.__STRYKER_ACTIVE_MUTANT__, '7');
  }
});

test('run-for-mutant main: brak id to testy pliku (covering), ALL to wszystkie, STATIC to testy pliku; pusta lista nic nie uruchamia', () => {
  const root = mutantRoot({ covering: ['mid.test.js'], all: ['big.test.js', 'small.test.js'], mutants: { A: 'ALL', S: 'STATIC', E: [], undefined: ['big.test.js'] } });
  const files = (id) => {
    const spawn = fakeSpawn();
    const { r } = mutantRun(root, id, spawn);
    assert.deepEqual(r.of('exit'), [0], `id ${id}`);
    return spawn.calls.map(c => path.basename(c.args[3]));
  };
  assert.deepEqual(files(undefined), ['mid.test.js']);
  assert.deepEqual(files('A'), ['small.test.js', 'big.test.js']);
  assert.deepEqual(files('S'), ['mid.test.js']);
  assert.deepEqual(files('E'), []);
});

test('run-for-mutant main: pierwsza porażka przerywa i zwraca swój kod; sygnał (status null) to 1; wyjście tylko raz', () => {
  const root = mutantRoot({ covering: [], mutants: { 1: ['small.test.js', 'mid.test.js', 'big.test.js'] } });
  const failing = fakeSpawn(({ index }) => (index === 1 ? { status: 5 } : {}));
  const first = mutantRun(root, '1', failing);
  assert.deepEqual(first.r.of('exit'), [5]);
  assert.equal(failing.calls.length, 2, 'po porażce nic więcej nie jest uruchamiane');
  const signalled = fakeSpawn(({ index }) => (index === 0 ? { status: null } : {}));
  const second = mutantRun(root, '1', signalled);
  assert.deepEqual(second.r.of('exit'), [1]);
  assert.equal(signalled.calls.length, 1);
});

test('run-for-mutant main: mutant spoza pliku wyboru to kod 70 z komunikatem, bez uruchamiania testów i bez drugiego wyjścia', () => {
  const root = mutantRoot({ covering: ['mid.test.js'], mutants: { 1: ['mid.test.js'] } });
  const spawn = fakeSpawn();
  const { r } = mutantRun(root, '99', spawn);
  assert.deepEqual(r.events, [['guard', 'run-for-mutant.js'], ['error', 'Brak mutanta 99 w pliku wyboru: pomiar nieważny.'], ['exit', 70]]);
  assert.equal(spawn.calls.length, 0);
});

test('run-for-mutant entryOf: bez id covering, z id wpis mutanta albo undefined', () => {
  const selection = { covering: ['c'], mutants: { 1: ['a'], undefined: ['u'] } };
  assert.deepEqual(runForMutant.entryOf(selection, undefined), ['c']);
  assert.deepEqual(runForMutant.entryOf(selection, '1'), ['a']);
  assert.equal(runForMutant.entryOf(selection, '2'), undefined);
});
