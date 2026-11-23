'use strict';

// Kontrola zerowa pomiaru (#253): kod ZINSTRUMENTOWANY przez Strykera, ale bez aktywnego mutanta, musi dać
// ten sam wynik i tę samą liczbę testów co kod oryginalny (te same testy `run-tests.js`, bez instrumentacji).
// Inaczej sama instrumentacja zmienia zachowanie i wynik mutacji nic nie mówi.
//   1. baza: testy na kopii cienia równej src/ (bez instrumentacji),
//   2. Stryker w trybie suchego przebiegu (--dryRunOnly) tworzy kopię roboczą ze zinstrumentowanym plikiem
//      i ją zostawia (cleanTempDir: false),
//   3. te same testy w kopii roboczej Strykera, bez zmiennej aktywnego mutanta,
//   4. porównanie: kod wyjścia 0 w obu, te same liczby tests/pass/fail oraz dowód, że plik w kopii
//      roboczej jest naprawdę zinstrumentowany (inaczej kontrola byłaby pusta).
// Użycie: node scripts/mutation/zero-check.js WordPress.gs   (kod 0 = zgodne, 4 = niezgodne, 3 = brak izolacji)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeEnv } = require('./safe-env.js');
const { requireIsolation } = require('./isolation-guard.js');
const { stemOf } = require('./source-name.js');

const ROOT = require('./repo-root.js');
const TEMP = '.stryker-tmp';

/** Liczby z podsumowania `node --test` (reporter spec: „ℹ tests N”; tap: „# tests N”). */
function parseSummary(text) {
  // Ostatnie wystąpienie: podsumowanie zbiorcze kończy wyjście, a testy zagnieżdżone mogą drukować własne.
  const pick = key => {
    const all = [...text.matchAll(new RegExp(`^(?:ℹ|#) ${key} (\\d+)\\s*$`, 'gm'))];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  const summary = { tests: pick('tests'), pass: pick('pass'), fail: pick('fail') };
  return Object.values(summary).includes(null) ? null : summary;
}

/**
 * Czy plik w kopii roboczej Strykera jest naprawdę zinstrumentowany: ma preludium instrumentacji (`stryNS_`,
 * `stryCov_`) i różni się od kopii cienia. Sama obecność tekstu `__stryker__` nie wystarcza (mógłby być w kodzie).
 */
function looksInstrumented(content, original) {
  return typeof content === 'string' && /stryNS_\w/.test(content) && /stryCov_\w/.test(content) && content !== original;
}

/** Porównanie bazy z przebiegiem na kodzie zinstrumentowanym. `instrumented`: czy plik ma ślad instrumentacji. */
function compareRuns(base, instrumented, isInstrumented) {
  if (!isInstrumented) return { ok: false, reason: 'plik w kopii roboczej Strykera nie jest zinstrumentowany: kontrola byłaby pusta' };
  for (const [label, run] of [['oryginalny', base], ['zinstrumentowany', instrumented]]) {
    if (!run.summary) return { ok: false, reason: `kod ${label}: brak podsumowania testów w wyjściu` };
    if (run.status !== 0 || run.summary.fail !== 0) return { ok: false, reason: `kod ${label}: kod wyjścia ${run.status}, porażek ${run.summary.fail}` };
  }
  if (base.summary.tests !== instrumented.summary.tests || base.summary.pass !== instrumented.summary.pass) {
    return { ok: false, reason: `liczby testów się różnią: oryginalny ${base.summary.tests}/${base.summary.pass}, zinstrumentowany ${instrumented.summary.tests}/${instrumented.summary.pass}` };
  }
  return { ok: true, reason: `kod zinstrumentowany bez mutanta daje ten sam wynik: ${base.summary.tests} testów, ${base.summary.pass} zaliczonych, 0 porażek` };
}

function runTests(cwd, spawn) {
  const run = spawn(process.execPath, [path.join('scripts', 'mutation', 'run-tests.js')], { cwd, encoding: 'utf8', env: safeEnv(process.env) });
  const text = (run.stdout || '') + (run.stderr || '');
  return { status: run.status, summary: parseSummary(text), tail: text.split('\n').slice(-30).join('\n') };
}

/** Kopia robocza Strykera z zinstrumentowanym plikiem `stem`: ścieżka pliku albo null. */
function findInstrumented(root, stem) {
  const temp = path.join(root, TEMP);
  if (!fs.existsSync(temp)) return null;
  for (const dir of fs.readdirSync(temp).filter(d => d.startsWith('sandbox'))) {
    const file = path.join(temp, dir, '.stryker-shadow', `${stem}.js`);
    if (fs.existsSync(file)) return { sandbox: path.join(temp, dir), file };
  }
  return null;
}

function dryRun(root, stem, spawn) {
  const base = JSON.parse(fs.readFileSync(path.join(root, 'stryker.config.json')));
  const cfg = path.join(root, 'reports', 'mutation', `cfg-zero-${stem}.json`);
  fs.writeFileSync(cfg, JSON.stringify({
    ...base, mutate: [`.stryker-shadow/${stem}.js`], commandRunner: { command: 'node -e "process.exit(0)"' },
    reporters: ['clear-text'], dryRunOnly: true, cleanTempDir: false, concurrency: 1
  }));
  return spawn(process.execPath, ['node_modules/@stryker-mutator/core/bin/stryker.js', 'run', cfg], { cwd: root, encoding: 'utf8', env: safeEnv(process.env) });
}

/** `deps` podmienia korzeń, bramkę izolacji, uruchamianie procesów i wyjścia (testy; produkcyjnie domyślne). */
async function main(argv, deps = {}) {
  const { root = ROOT, guard = requireIsolation, spawn = spawnSync, log = console.log, error = console.error, exit = process.exit } = deps;
  const name = argv[2];
  const stem = stemOf(name);
  if (stem === null) {
    error('Podaj nazwę pliku z src/, np. Payloads.gs');
    exit(2);
    return;
  }
  await guard('zero-check.js');
  const out = path.join(root, 'reports', 'mutation');
  fs.mkdirSync(out, { recursive: true });
  spawn(process.execPath, [path.join(__dirname, 'prepare-shadow.js'), name], { cwd: root, stdio: 'ignore', env: safeEnv(process.env) });
  fs.rmSync(path.join(root, TEMP), { recursive: true, force: true });
  const base = runTests(root, spawn);
  dryRun(root, stem, spawn);
  const found = findInstrumented(root, stem);
  const instrumented = found ? runTests(found.sandbox, spawn) : { status: null, summary: null, tail: '' };
  const original = fs.readFileSync(path.join(root, '.stryker-shadow', `${stem}.js`), 'utf8');
  const isInstrumented = Boolean(found) && looksInstrumented(fs.readFileSync(found.file, 'utf8'), original);
  const verdict = compareRuns(base, instrumented, isInstrumented);
  fs.writeFileSync(path.join(out, `zero-check-${stem}.json`), JSON.stringify({ file: name, ...verdict, base: base.summary, instrumented: instrumented.summary }, null, 1));
  fs.rmSync(path.join(root, TEMP), { recursive: true, force: true });
  log(verdict.reason);
  if (!verdict.ok) error(`baza:\n${base.tail}\nzinstrumentowany:\n${instrumented.tail}`);
  exit(verdict.ok ? 0 : 4);
}

if (require.main === module) main(process.argv);
module.exports = { parseSummary, compareRuns, looksInstrumented, main };
