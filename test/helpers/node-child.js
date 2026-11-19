'use strict';

/**
 * TYMCZASOWA DIAGNOSTYKA P1 (#297): potomek node (CLI drift, rekord wdrożenia, compare) kończył się sporadycznie
 * kodem 3221226505 (0xC0000409) z pustym stdout i stderr, tylko w pełnym biegu testów na Windows. Ten pomocnik uruchamia
 * potomka tak jak dotąd i zostawia ślad przy każdym wyjściu innym niż 0 i 1 (jedyne kody, jakie CLI zwracają same):
 * status, sygnał, błąd spawn, czas życia, liczbę równoległych potomków tego procesu, wolną pamięć i całość stdout/stderr.
 * Ślad idzie na stderr procesu testowego (widać go w wyniku testu i w logu hooka) oraz, gdy ustawiono CHILD_DIAG_DIR,
 * do pliku child-failures.log w tym katalogu. Z CHILD_DIAG_DIR potomek startuje też z raportem diagnostycznym Node
 * (--report-on-fatalerror, --report-uncaught-exception, --report-on-signal; pliki raportów trafiają do tego katalogu).
 *
 * WARUNEK USUNIĘCIA: gdy przyczyna zostanie ustalona i naprawiona albo po dwóch tygodniach bez awarii w CI i w hookach.
 * Usunięcie: wrócić w trzech plikach testów (apps-script-compare-drift, deployment-record, apps-script-compare)
 * do bezpośredniego `spawn`/`spawnSync` i skasować ten plik oraz test/node-child-diagnostics.test.js.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIAG_ENV = 'CHILD_DIAG_DIR';
const NORMAL_STATUSES = new Set([0, 1]);
let inflight = 0;

function diagDir() {
  return process.env[DIAG_ENV] || '';
}

function diagFlags() {
  const dir = diagDir();
  if (!dir) return [];
  fs.mkdirSync(dir, { recursive: true });
  return ['--report-on-fatalerror', '--report-uncaught-exception', '--report-on-signal', `--report-directory=${dir}`];
}

/** Opis nieudanego potomka do wypisania; niezerowy status inny niż 0 i 1 albo sygnał albo błąd spawn. */
function describeFailure(script, args, r) {
  return [
    `[DIAGNOSTYKA #297] potomek node zakończony nietypowo: status=${r.status}${typeof r.status === 'number' ? ` (0x${(r.status >>> 0).toString(16)})` : ''}, signal=${r.signal}, error=${r.error || 'brak'}`,
    `  skrypt=${path.basename(script)} args=${JSON.stringify(args)}`,
    `  pid=${r.pid}, start=${r.startedAt}, koniec=${r.endedAt} (czasy lokalnego zegara tego procesu, ISO UTC z ms)`,
    `  czas życia=${r.ms} ms, równoległych potomków w tym procesie=${r.active}, wolna pamięć=${Math.round(os.freemem() / 1048576)} MB, ` +
      `NODE_V8_COVERAGE=${process.env.NODE_V8_COVERAGE ? 'ustawione' : 'brak'}, ${new Date().toISOString()}`,
    `  stdout (${r.stdout.length} znaków): ${JSON.stringify(r.stdout)}`,
    `  stderr (${r.stderr.length} znaków): ${JSON.stringify(r.stderr)}`
  ].join('\n');
}

function isAbnormal(r) {
  return r.signal != null || Boolean(r.error) || !NORMAL_STATUSES.has(r.status);
}

function note(script, args, r) {
  if (!isAbnormal(r)) return;
  const text = describeFailure(script, args, r);
  process.stderr.write(`${text}\n`);
  const dir = diagDir();
  if (dir) fs.appendFileSync(path.join(dir, 'child-failures.log'), `${text}\n`);
}

/** Asynchronicznie (serwer atrapy działa w tym procesie): zwraca { status, signal, stdout, stderr, error, ms, active }. */
function runNode(script, args, { env, cwd } = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    inflight += 1;
    const active = inflight;
    const child = spawn(process.execPath, [...diagFlags(), script, ...args], { env, cwd });
    let stdout = '';
    let stderr = '';
    let error = null;
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', e => { error = e.message; });
    child.on('close', (status, signal) => {
      inflight -= 1;
      const t1 = Date.now();
      const r = { status, signal, stdout, stderr, error, ms: t1 - t0, active, pid: child.pid, startedAt, endedAt: new Date(t1).toISOString() };
      note(script, args, r);
      resolve(r);
    });
  });
}

/** Synchronicznie; opcje jak w spawnSync (encoding 'utf8' ustawiony tutaj), wynik jak w spawnSync plus ms i ślad. */
function runNodeSync(script, args, options = {}) {
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const r = spawnSync(process.execPath, [...diagFlags(), script, ...args], { encoding: 'utf8', ...options });
  const t1 = Date.now();
  const view = {
    status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? r.error.message : null,
    ms: t1 - t0, active: 1, pid: r.pid, startedAt, endedAt: new Date(t1).toISOString()
  };
  note(script, args, view);
  return r;
}

module.exports = { runNode, runNodeSync, describeFailure, isAbnormal, diagFlags, DIAG_ENV };
