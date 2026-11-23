'use strict';

// Pełny pomiar mutacyjny jednego pliku src/*.gs (mutacje .gs, wyłącznie w izolatorze z #253).
//   0. bramka izolacji (isolation-guard.js): odmowa kodem 3, zanim powstanie jakikolwiek plik,
//   1. kopia cienia pliku,
//   2. przebieg indeksujący: komenda przechodzi bez mutanta i pada z mutantem, więc Stryker szybko
//      wypisuje wszystkie mutanty z id i lokalizacją (id są deterministyczne dla tej samej treści),
//   3. plik wyboru testów (selection.js; zestaw --suite=per-mutant|file|full),
//   4. właściwy przebieg ze wszystkimi mutatorami, bez wykluczeń.
// Użycie: node scripts/mutation/run-file.js WordPress.gs [--concurrency=4] [--limit=N] [--suite=per-mutant]
// Wyniki: reports/mutation/result-<Plik>.json (raport Strykera), selection-<Plik>.json, time-<Plik>.json
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeEnv } = require('./safe-env.js');
const { requireIsolation } = require('./isolation-guard.js');
const { SUITES, buildSelection, selectionKinds } = require('./selection.js');
const { listTests } = require('./tests-list.js');
const { stemOf } = require('./source-name.js');

const ROOT = require('./repo-root.js');
const STRYKER = ['node_modules/@stryker-mutator/core/bin/stryker.js', 'run'];

/** Argumenty wywołania; `error` niepusty = wywołanie nieprawidłowe (kod 2). */
function parseArgs(argv) {
  const arg = k => argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
  const name = argv[2];
  const suite = arg('suite') || 'per-mutant';
  const concurrency = Number(arg('concurrency') || 4);
  const limit = Number(arg('limit') || 0);
  let error = '';
  const stem = stemOf(name);
  if (stem === null) error = 'Podaj nazwę pliku z src/, np. WordPress.gs';
  else if (!SUITES.includes(suite)) error = `Nieznany zestaw testów --suite=${suite} (dozwolone: ${SUITES.join(', ')})`;
  else if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(limit) || limit < 0) error = 'Nieprawidłowe --concurrency lub --limit';
  return { name, stem, suite, concurrency, limit, error };
}

/** Stryker nie ma opcji CLI dla jsonReporter, więc każdy przebieg dostaje własny plik konfiguracji. */
function run(ctx, tag, overrides, env) {
  const base = JSON.parse(fs.readFileSync(path.join(ctx.root, 'stryker.config.json')));
  const cfg = path.join(ctx.out, `cfg-${tag}.json`);
  fs.writeFileSync(cfg, JSON.stringify({ ...base, ...overrides }));
  return ctx.spawn(process.execPath, [...STRYKER, cfg], { cwd: ctx.root, encoding: 'utf8', env: safeEnv(process.env, env) });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file));
}

/** Przebieg indeksujący: lista mutantów pliku. */
function indexMutants(ctx, stem, shadow) {
  const idxReport = path.join('reports', 'mutation', `index-${stem}.json`);
  // Indeks zawsze z tego przebiegu: stary plik (np. z kopii repozytorium) nie może udawać wyniku nieudanego Strykera.
  fs.rmSync(path.join(ctx.root, idxReport), { force: true });
  const idxCmd = 'node -e "process.exit(process.env.__STRYKER_ACTIVE_MUTANT__!==undefined?1:0)"';
  run(ctx, `index-${stem}`, { mutate: [shadow], commandRunner: { command: idxCmd }, reporters: ['json'], jsonReporter: { fileName: idxReport }, concurrency: 4 });
  return Object.values(readJson(path.join(ctx.root, idxReport)).files)[0].mutants;
}

/** Wąski zestaw pliku z .quality/mutation-tests.json (tylko --suite=file). */
function fileTestsOf(root, name) {
  const map = readJson(path.join(root, '.quality', 'mutation-tests.json'));
  return map.tests[name] || [];
}

/** `deps` podmienia korzeń, bramkę izolacji, uruchamianie procesów, zegar i wyjścia (testy; produkcyjnie domyślne). */
async function main(argv, deps = {}) {
  const { root = ROOT, guard = requireIsolation, spawn = spawnSync, now = Date.now, error: logError = console.error, exit = process.exit } = deps;
  const { name, stem, suite, concurrency, limit, error } = parseArgs(argv);
  if (error) {
    logError(error);
    exit(2);
    return;
  }
  await guard('run-file.js');
  const out = path.join(root, 'reports', 'mutation');
  const ctx = { root, out, spawn };
  fs.mkdirSync(out, { recursive: true });
  spawn(process.execPath, [path.join(__dirname, 'prepare-shadow.js'), name], { cwd: root, stdio: 'ignore', env: safeEnv(process.env) });
  const shadow = `.stryker-shadow/${stem}.js`;

  const t0 = now();
  const mutants = indexMutants(ctx, stem, shadow);
  logError(`indeks ${name}: ${mutants.length} mutantów w ${Math.round((now() - t0) / 1000)} s`);

  const map = suite === 'per-mutant' ? readJson(path.join(out, 'coverage-map.json')) : null;
  const sel = buildSelection({ name, mutants, suite, allTests: listTests(root), map, fileTests: suite === 'file' ? fileTestsOf(root, name) : null });
  const selFile = path.join(out, `selection-${stem}.json`);
  fs.writeFileSync(selFile, JSON.stringify(sel));
  const kinds = selectionKinds(sel);
  logError(`wybór testów (${suite}): statyczne=${kinds.static} bez testu=${kinds.none} z doborem=${kinds.some}`);

  const resFile = path.join('reports', 'mutation', `result-${stem}.json`);
  const t1 = now();
  const res = run(ctx, `run-${stem}`, {
    mutate: [limit > 0 ? `${shadow}:1-${limit}` : shadow], commandRunner: { command: 'node scripts/mutation/run-for-mutant.js' },
    reporters: ['json', 'clear-text'], jsonReporter: { fileName: resFile }, concurrency, timeoutMS: suite === 'full' ? 600000 : 90000
  }, { MUTATION_SELECTION: selFile });
  fs.writeFileSync(path.join(out, `log-${stem}.txt`), (res.stdout || '') + (res.stderr || ''));
  const t2 = now();
  logError(`przebieg ${name}: ${Math.round((t2 - t1) / 1000)} s, exit ${res.status}`);
  fs.writeFileSync(path.join(out, `time-${stem}.json`), JSON.stringify({
    file: name, suite, mutants: mutants.length, indexSeconds: Math.round((t1 - t0) / 1000), runSeconds: Math.round((t2 - t1) / 1000), concurrency
  }));
  exit(res.status === null ? 1 : res.status);
}

if (require.main === module) main(process.argv);
module.exports = { parseArgs, main };
