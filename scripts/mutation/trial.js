'use strict';

// Przebieg próby mutacji dla jednego pliku src/*.gs w izolatorze (#253), jedno wejście dla workflow:
//   0. bramka izolacji: fakty z /proc i sondy czynne (isolation-guard.js, isolation-probe.js), zanim cokolwiek
//      powstanie; odmowa kończy kodem 3 bez raportu,
//   1. kontrola zerowa (zero-check.js): kod zinstrumentowany bez mutanta = ten sam wynik i liczba testów,
//   2. kanarek (canary.js): kontrola dodatnia, wszystkie mutanty kanarka zabite z asercją,
//   3. mapa pokrycia (coverage-map.js), tylko dla --suite=per-mutant,
//   4. mutanty pliku (run-file.js) i klasyfikacja (classify.js): killed-assert, killed-other, Survived, Timeout,
//   5. podsumowanie: reports/mutation/summary.json i summary.md.
// Użycie: node scripts/mutation/trial.js Payloads.gs [--suite=per-mutant|file|full] [--concurrency=4] [--outside=/ścieżka,...]
// Kody: 0 = przebieg ważny, 2 = błędne wywołanie, 3 = brak izolacji (bez raportu), 4 = kontrola zerowa/kanarek/przebieg nieudany.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeEnv } = require('./safe-env.js');
const { requireIsolation } = require('./isolation-guard.js');
const { classifyReport } = require('./classify.js');
const { SUITES } = require('./selection.js');
const { stemOf } = require('./source-name.js');

const ROOT = require('./repo-root.js');

function parseArgs(argv) {
  const arg = key => (argv.find(a => a.startsWith(`--${key}=`)) || '').slice(key.length + 3);
  const name = argv[2];
  const suite = arg('suite') || 'per-mutant';
  const concurrency = Number(arg('concurrency') || 4);
  const outside = arg('outside').split(',').filter(Boolean);
  let error = '';
  const stem = stemOf(name);
  if (stem === null) error = 'Podaj nazwę pliku z src/, np. Payloads.gs';
  else if (!SUITES.includes(suite)) error = `Nieznany zestaw testów --suite=${suite} (dozwolone: ${SUITES.join(', ')})`;
  else if (!Number.isInteger(concurrency) || concurrency < 1) error = 'Nieprawidłowe --concurrency';
  else if (outside.some(p => !path.isAbsolute(p))) error = '--outside przyjmuje tylko ścieżki bezwzględne';
  return { name, stem, suite, concurrency, outside, error };
}

/** Podsumowanie przebiegu: liczby per status z klasyfikacji i czasy z run-file.js. */
function summarize(name, suite, report, time) {
  const { counts, rows } = classifyReport(report);
  const killedAssert = counts['killed-assert'] || 0;
  return {
    file: name, suite, mutants: rows.length, counts, killedAssert,
    score: rows.length ? Number((100 * killedAssert / rows.length).toFixed(1)) : 0,
    indexSeconds: time.indexSeconds, runSeconds: time.runSeconds, concurrency: time.concurrency
  };
}

function summaryMarkdown(s) {
  const lines = [`## Próba mutacji: ${s.file} (zestaw testów: ${s.suite})`, '', '| Status | Liczba |', '| --- | ---: |'];
  for (const [status, n] of Object.entries(s.counts).sort()) lines.push(`| ${status} | ${n} |`);
  lines.push('', `Mutantów: ${s.mutants}; zabite z asercją: ${s.killedAssert} (${s.score} %).`,
    `Czas: indeks ${s.indexSeconds} s, przebieg ${s.runSeconds} s, procesów Strykera: ${s.concurrency}.`);
  return `${lines.join('\n')}\n`;
}

/**
 * Raporty i pliki robocze mogą pochodzić wyłącznie z tego przebiegu: usuwa wszystko, co mogło zostać w kopii
 * repozytorium (reports/, kopie cienia i katalog roboczy Strykera), zanim powstanie pierwszy plik raportu.
 */
function cleanRunArtifacts(root) {
  for (const dir of ['reports', '.stryker-shadow', '.stryker-tmp']) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
}

function step(root, script, args, spawn) {
  const run = spawn(process.execPath, [path.join(__dirname, script), ...args], { cwd: root, stdio: 'inherit', env: safeEnv(process.env) });
  return run.status === null ? 1 : run.status;
}

/** `deps` podmienia korzeń, bramkę izolacji, uruchamianie procesów i wyjścia (testy; produkcyjnie domyślne). */
async function main(argv, deps = {}) {
  const { root = ROOT, guard = requireIsolation, spawn = spawnSync, log = console.log, error: logError = console.error, exit = process.exit } = deps;
  const { name, stem, suite, concurrency, outside, error } = parseArgs(argv);
  if (error) {
    logError(error);
    exit(2);
    return;
  }
  await guard('trial.js', { probeOptions: { outside } });
  cleanRunArtifacts(root);
  const out = path.join(root, 'reports', 'mutation');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'isolation.json'), JSON.stringify({ verified: true, node: process.version, platform: process.platform }));
  const plan = [['zero-check.js', [name]], ['canary.js', []]];
  if (suite === 'per-mutant') plan.push(['coverage-map.js', []]);
  plan.push(['run-file.js', [name, `--suite=${suite}`, `--concurrency=${concurrency}`]]);
  for (const [script, args] of plan) {
    const status = step(root, script, args, spawn);
    if (status !== 0) {
      logError(`${script}: kod ${status}, przebieg przerwany`);
      exit(status === 3 ? 3 : 4);
      return;
    }
  }
  const read = file => JSON.parse(fs.readFileSync(path.join(out, file)));
  const summary = summarize(name, suite, read(`result-${stem}.json`), read(`time-${stem}.json`));
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(out, 'summary.md'), summaryMarkdown(summary));
  log(summaryMarkdown(summary));
}

if (require.main === module) main(process.argv);
module.exports = { parseArgs, summarize, summaryMarkdown, cleanRunArtifacts, main };
