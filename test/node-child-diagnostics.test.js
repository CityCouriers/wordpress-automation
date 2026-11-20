'use strict';

/** Tymczasowa diagnostyka P1 (#297): pomocnik zostawia ślad przy nietypowym wyjściu potomka node i nie hałasuje przy 0 i 1. */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runNode, runNodeSync, describeFailure, isAbnormal, diagFlags, DIAG_ENV } = require('./helpers/node-child');

let dir;
let script;
let written;
const realWrite = process.stderr.write.bind(process.stderr);

function child(body) {
  script = path.join(dir, 'child.js');
  fs.writeFileSync(script, body);
  return script;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-'));
  written = '';
  process.stderr.write = chunk => { written += chunk; return true; };
});

afterEach(() => {
  process.stderr.write = realWrite;
  delete process.env[DIAG_ENV];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('klasyfikacja wyjścia', () => {
  test('0 i 1 są normalne; inny kod, sygnał albo błąd spawn to nietypowe wyjście', () => {
    const base = { stdout: '', stderr: '', signal: null, error: null };
    assert.equal(isAbnormal({ ...base, status: 0 }), false);
    assert.equal(isAbnormal({ ...base, status: 1 }), false);
    assert.equal(isAbnormal({ ...base, status: 3221226505 }), true);
    assert.equal(isAbnormal({ ...base, status: 2 }), true);
    assert.equal(isAbnormal({ ...base, status: null, signal: 'SIGABRT' }), true);
    assert.equal(isAbnormal({ ...base, status: 0, error: 'spawn ENOENT' }), true);
  });

  test('opis niesie status szesnastkowo, sygnał, czas, liczbę potomków i całe strumienie', () => {
    const text = describeFailure('/x/drift.js', ['--drift'], {
      status: 3221226505, signal: null, error: null, ms: 1234, active: 3, stdout: 'wyjście', stderr: 'błąd\n',
      pid: 4242, startedAt: '2026-11-19T19:00:00.123Z', endedAt: '2026-11-19T19:00:01.357Z'
    });
    assert.match(text, /status=3221226505 \(0xc0000409\)/);
    assert.match(text, /pid=4242, start=2026-11-19T19:00:00\.123Z, koniec=2026-11-19T19:00:01\.357Z/);
    assert.match(text, /czas życia=1234 ms, równoległych potomków w tym procesie=3/);
    assert.match(text, /skrypt=drift\.js args=\["--drift"\]/);
    assert.match(text, /stdout \(7 znaków\): "wyjście"/);
    assert.match(text, /stderr \(5 znaków\): "błąd\\n"/);
  });
});

describe('runNode (asynchronicznie)', () => {
  test('kod 0 i 1: wynik z kodem, strumieniami i czasem, bez śladu', async () => {
    const ok = await runNode(child('process.stdout.write("a"); process.stderr.write("b");'), [], { env: process.env });
    assert.deepEqual([ok.status, ok.stdout, ok.stderr, ok.signal, ok.error], [0, 'a', 'b', null, null]);
    assert.ok(ok.ms >= 0 && ok.active >= 1);
    const fail = await runNode(child('process.exit(1);'), [], { env: process.env });
    assert.equal(fail.status, 1);
    assert.equal(written, '', 'normalne wyjścia nie zostawiają śladu');
  });

  test('awaria procesu (abort): ślad na stderr z kodem i argumentami; bez CHILD_DIAG_DIR brak pliku', async () => {
    const r = await runNode(child('process.stdout.write("przed"); process.abort();'), ['--arg', 'x'], { env: process.env });
    assert.ok(r.status !== 0 && r.status !== 1 || r.signal, 'abort daje nietypowe wyjście');
    assert.match(written, /\[DIAGNOSTYKA #297\] potomek node zakończony nietypowo/);
    assert.match(written, /args=\["--arg","x"\]/);
    assert.match(written, /równoległych potomków w tym procesie=1/);
    assert.match(written, /pid=\d+, start=\d{4}-\d\d-\d\dT[\d:]+\.\d{3}Z, koniec=\d{4}-\d\d-\d\dT[\d:]+\.\d{3}Z/);
    assert.ok(Number.isInteger(r.pid) && r.pid > 0 && Date.parse(r.endedAt) >= Date.parse(r.startedAt));
    assert.deepEqual(fs.readdirSync(dir), ['child.js']);
  });

  test('z CHILD_DIAG_DIR ślad trafia też do pliku, a potomek dostaje flagi raportu', async () => {
    const diag = path.join(dir, 'diag');
    process.env[DIAG_ENV] = diag;
    assert.deepEqual(diagFlags(), ['--report-on-fatalerror', '--report-uncaught-exception', '--report-on-signal', `--report-directory=${diag}`]);
    await runNode(child('process.abort();'), [], { env: process.env });
    const log = fs.readFileSync(path.join(diag, 'child-failures.log'), 'utf8');
    assert.match(log, /\[DIAGNOSTYKA #297\]/);
  });

  test('nieobsłużony wyjątek z CHILD_DIAG_DIR zostawia raport diagnostyczny Node w katalogu', async () => {
    const diag = path.join(dir, 'diag');
    process.env[DIAG_ENV] = diag;
    const r = await runNode(child('throw new Error("boom");'), [], { env: process.env });
    assert.equal(r.status, 1);
    const reports = fs.readdirSync(diag).filter(n => /^report.*\.json$/.test(n));
    assert.equal(reports.length, 1, 'raport z --report-uncaught-exception');
    assert.match(fs.readFileSync(path.join(diag, reports[0]), 'utf8'), /boom/);
  });

  test('bez CHILD_DIAG_DIR nie ma flag raportu', () => {
    assert.deepEqual(diagFlags(), []);
  });

  test('równoległe potomki są liczone', async () => {
    const [a, b] = await Promise.all([
      runNode(child('setTimeout(() => {}, 300);'), [], { env: process.env }),
      runNode(child('setTimeout(() => {}, 300);'), [], { env: process.env })
    ]);
    assert.deepEqual([a.active, b.active].sort(), [1, 2]);
  });

  test('błąd spawn (nieistniejący katalog) jest raportowany jako nietypowy', async () => {
    const r = await runNode(child('1;'), [], { env: process.env, cwd: path.join(dir, 'brak') });
    assert.match(r.error, /ENOENT/);
    assert.match(written, /error=spawn .*ENOENT/);
  });
});

describe('runNodeSync', () => {
  test('zwraca wynik spawnSync; kod 0 bez śladu, abort ze śladem', () => {
    const ok = runNodeSync(child('process.stdout.write("x");'), [], { env: process.env });
    assert.deepEqual([ok.status, ok.stdout], [0, 'x']);
    assert.equal(written, '');
    runNodeSync(child('process.abort();'), ['s'], { env: process.env });
    assert.match(written, /\[DIAGNOSTYKA #297\].*\n.*args=\["s"\]/);
    assert.match(written, /pid=\d+, start=\d{4}-\d\d-\d\dT[\d:]+\.\d{3}Z, koniec=/);
  });

  test('opcje procesu (cwd) są przekazywane, błąd spawn raportowany', () => {
    const r = runNodeSync(child('1;'), [], { env: process.env, cwd: path.join(dir, 'brak') });
    assert.ok(r.error);
    assert.match(written, /status=null, signal=null, error=spawnSync .*ENOENT/);
  });
});

describe('NODE_V8_COVERAGE nie przechodzi do potomka (obejście P1, #297)', () => {
  const probe = 'process.stdout.write(process.env.NODE_V8_COVERAGE ? "jest:" + process.env.NODE_V8_COVERAGE : "brak");';
  let saved;

  beforeEach(() => {
    saved = process.env.NODE_V8_COVERAGE;
    process.env.NODE_V8_COVERAGE = path.join(dir, 'cov');
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = saved;
  });

  test('runNode: env rodzica przekazany wprost albo domyślny nie niesie zmiennej do potomka', async () => {
    const wprost = await runNode(child(probe), [], { env: { ...process.env } });
    assert.equal(wprost.stdout, 'brak');
    const domyslny = await runNode(child(probe), []);
    assert.equal(domyslny.stdout, 'brak');
  });

  test('runNodeSync: tak samo, także gdy zmienna jest w env podanym jawnie', () => {
    assert.equal(runNodeSync(child(probe), [], { env: { ...process.env } }).stdout, 'brak');
    assert.equal(runNodeSync(child(probe), []).stdout, 'brak');
    assert.equal(runNodeSync(child(probe), [], { env: { PATH: process.env.PATH, NODE_V8_COVERAGE: 'x' } }).stdout, 'brak');
    // Node dopisuje zmienną z żywego środowiska rodzica także wtedy, gdy podane env jej nie zawiera:
    assert.equal(runNodeSync(child(probe), [], { env: { PATH: process.env.PATH } }).stdout, 'brak');
  });

  test('opcja keepCoverageEnv zostawia zmienną (do sond porównawczych)', async () => {
    const r = await runNode(child(probe), [], { env: { ...process.env }, keepCoverageEnv: true });
    assert.equal(r.stdout, `jest:${path.join(dir, 'cov')}`);
    const s = runNodeSync(child(probe), [], { env: { ...process.env }, keepCoverageEnv: true });
    assert.equal(s.stdout, `jest:${path.join(dir, 'cov')}`);
  });

  test('ślad opisuje NODE_V8_COVERAGE z env potomka i osobno z rodzica', async () => {
    const base = { status: 3221226505, signal: null, error: null, ms: 1, active: 1, stdout: '', stderr: '', pid: 1, startedAt: 'a', endedAt: 'b' };
    assert.match(describeFailure('x.js', [], { ...base, childCoverage: false }), /NODE_V8_COVERAGE u potomka=brak \(rodzic: ustawione\)/);
    assert.match(describeFailure('x.js', [], { ...base, childCoverage: true }), /NODE_V8_COVERAGE u potomka=ustawione \(rodzic: ustawione\)/);
    delete process.env.NODE_V8_COVERAGE;
    assert.match(describeFailure('x.js', [], { ...base, childCoverage: false }), /NODE_V8_COVERAGE u potomka=brak \(rodzic: brak\)/);
  });

  test('ślad z prawdziwego uruchomienia niesie stan potomka: po obejściu zawsze brak, z keepCoverageEnv ustawione', async () => {
    await runNode(child('process.abort();'), [], { env: { ...process.env } });
    assert.match(written, /NODE_V8_COVERAGE u potomka=brak \(rodzic: ustawione\)/);
    written = '';
    await runNode(child('process.abort();'), [], { env: { ...process.env }, keepCoverageEnv: true });
    assert.match(written, /NODE_V8_COVERAGE u potomka=ustawione \(rodzic: ustawione\)/);
  });
});
