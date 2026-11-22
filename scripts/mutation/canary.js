'use strict';

// Kanarek mutacyjny (kontrola dodatnia w KAŻDYM przebiegu, #253): Stryker mutuje maleńkie źródło
// scripts/mutation/canary/MutationCanary.gs tym samym łańcuchem co prawdziwe pliki (kopia cienia, instrumentacja,
// vm-preload.js, klasyfikacja) i wszystkie jego mutanty muszą zginąć z asercją (killed-assert). Inaczej łańcuch
// jest zepsuty (np. preload nie wstrzykuje mutanta albo nie przekierowuje źródła) i pomiar jest nieważny.
// Użycie: node scripts/mutation/canary.js   (kod 0 = kanarek zabity, 4 = pomiar nieważny, 3 = brak izolacji)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeEnv } = require('./safe-env.js');
const { requireIsolation } = require('./isolation-guard.js');
const { classifyReport } = require('./classify.js');

const ROOT = require('./repo-root.js');
const FIXTURE = path.join(__dirname, 'canary', 'MutationCanary.gs');
const REPORT = path.join('reports', 'mutation', 'canary-result.json');
/** Tyle mutantów ma kanarek co najmniej (3 funkcje); mniej oznacza, że Stryker nic sensownie nie zmutował. */
const MIN_MUTANTS = 8;

/** Werdykt kanarka z raportu Strykera: ok tylko, gdy wszystkie mutanty zabite z asercją i jest ich dość. */
function canaryVerdict(report) {
  const { counts, rows } = classifyReport(report);
  const killed = counts['killed-assert'] || 0;
  if (rows.length < MIN_MUTANTS) return { ok: false, reason: `kanarek ma ${rows.length} mutantów, oczekiwano co najmniej ${MIN_MUTANTS}`, counts };
  if (killed !== rows.length) return { ok: false, reason: `kanarek: ${killed} z ${rows.length} mutantów zabitych z asercją (reszta: ${JSON.stringify(counts)})`, counts };
  return { ok: true, reason: `kanarek: ${killed} z ${rows.length} zabitych z asercją`, counts };
}

/** Przebieg Strykera na kanarku; zwraca raport JSON albo null, gdy Stryker go nie zapisał. */
function runStryker(root, spawn) {
  const out = path.join(root, 'reports', 'mutation');
  const shadow = path.join(root, '.stryker-shadow', 'MutationCanary.js');
  fs.mkdirSync(path.dirname(shadow), { recursive: true });
  fs.copyFileSync(FIXTURE, shadow);
  fs.rmSync(path.join(root, REPORT), { force: true });
  const base = JSON.parse(fs.readFileSync(path.join(root, 'stryker.config.json')));
  const cfg = path.join(out, 'cfg-canary.json');
  fs.writeFileSync(cfg, JSON.stringify({
    ...base,
    mutate: ['.stryker-shadow/MutationCanary.js'],
    commandRunner: { command: 'node --require ./scripts/mutation/vm-preload.js --test scripts/mutation/canary/canary.test.js' },
    reporters: ['json'], jsonReporter: { fileName: REPORT }, concurrency: 2, timeoutMS: 60000
  }));
  const run = spawn(process.execPath, ['node_modules/@stryker-mutator/core/bin/stryker.js', 'run', cfg], { cwd: root, encoding: 'utf8', env: safeEnv(process.env) });
  fs.writeFileSync(path.join(out, 'canary-log.txt'), (run.stdout || '') + (run.stderr || ''));
  return fs.existsSync(path.join(root, REPORT)) ? JSON.parse(fs.readFileSync(path.join(root, REPORT))) : null;
}

/** `deps` podmienia korzeń, bramkę izolacji, uruchamianie procesów i wyjścia (testy; produkcyjnie domyślne). */
async function main(deps = {}) {
  const { root = ROOT, guard = requireIsolation, spawn = spawnSync, log = console.log, exit = process.exit } = deps;
  await guard('canary.js');
  fs.mkdirSync(path.join(root, 'reports', 'mutation'), { recursive: true });
  const report = runStryker(root, spawn);
  const verdict = report ? canaryVerdict(report) : { ok: false, reason: 'Stryker nie zapisał raportu kanarka (suchy przebieg z testem kanarka nie przeszedł albo awaria)', counts: {} };
  fs.writeFileSync(path.join(root, 'reports', 'mutation', 'canary.json'), JSON.stringify(verdict, null, 1));
  log(verdict.reason);
  exit(verdict.ok ? 0 : 4);
}

if (require.main === module) main();
module.exports = { canaryVerdict, main, MIN_MUTANTS };
