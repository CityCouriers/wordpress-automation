'use strict';

// Sprawdzian doboru testów (mutacje .gs, wyłącznie w izolatorze z #253): próbka mutantów, które wyszły
// jako ocalałe albo bez pokrycia przy wybranych testach, jest uruchamiana jeszcze raz z CAŁYM zestawem
// testów. Jeśli któryś zginie, dobór testów z selection.js ukrywał zabicia.
// Użycie: node scripts/mutation/validate-selection.js WordPress.gs [--survived=50] [--nocov=30]
//         node scripts/mutation/validate-selection.js WordPress.gs --ids=12,34,56   (konkretne mutanty)
// Testy czytające src/*.gs jako TEKST (scheduled-jobs, *-completeness itd.) widzą w kopii zinstrumentowanej
// inny tekst i padają bez względu na mutanta; wykluczamy je przez --exclude=a.test.js,b.test.js.
// Suchy przebieg używa całej listy, więc taki test wychodzi od razu (Stryker przerywa).
// Limit czasu mutanta: 10 min, bo pełny zestaw po kolei trwa ponad 2 min.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeEnv } = require('./safe-env.js');
const { requireIsolation } = require('./isolation-guard.js');
const { stemOf } = require('./source-name.js');

const ROOT = require('./repo-root.js');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file));
}

/** Równomierna próbka n elementów listy (cała lista, gdy jest krótsza). */
function every(list, n) {
  const step = Math.max(list.length / n, 1);
  return Array.from({ length: Math.min(n, list.length) }, (_, i) => list[Math.floor(i * step)]);
}

/** Wartość `--klucz=wartość` z argumentów albo `undefined`. */
function optionOf(argv, key) {
  const hit = argv.find(a => a.startsWith(`--${key}=`));
  return hit === undefined ? undefined : hit.slice(key.length + 3);
}

/** Próbka do ponownego sprawdzenia: ocalałe z testami, bez pokrycia albo wskazane id. */
function chooseSample(mutants, sel, argv) {
  const noTests = m => sel.mutants[m.id]?.length === 0;
  const survivors = every(mutants.filter(m => m.status === 'Survived' && !noTests(m)), Number(optionOf(argv, 'survived') || 50));
  const noCov = every(mutants.filter(m => m.status === 'Survived' && noTests(m)), Number(optionOf(argv, 'nocov') || 30));
  const ids = optionOf(argv, 'ids');
  const sample = ids ? mutants.filter(m => ids.split(',').includes(m.id)) : [...survivors, ...noCov];
  return { sample, survivors, noCov, noTests };
}

/** Testy wykluczone z kontroli (`--exclude=a.test.js,b.test.js`) albo pusta lista. */
function excludedOf(argv) {
  const list = optionOf(argv, 'exclude');
  return list === undefined ? [] : list.split(',');
}

/** Plik wyboru kontroli: reszta mutantów dostaje pustą listę (kończy się od razu), próbka: wszystkie testy. */
function validationSelection(sel, mutants, sample, exclude) {
  const all = sel.all.filter(t => !exclude.includes(t));
  const val = { ...sel, all, covering: all, mutants: Object.fromEntries(mutants.map(m => [m.id, []])) };
  for (const m of sample) val.mutants[m.id] = 'ALL';
  return val;
}

/** `deps` podmienia korzeń, bramkę izolacji, uruchamianie procesów i wyjścia (testy; produkcyjnie domyślne). */
async function main(argv, deps = {}) {
  const { root = ROOT, guard = requireIsolation, spawn = spawnSync, log = console.log, error = console.error, exit = process.exit } = deps;
  const name = argv[2];
  const stem = stemOf(name);
  if (stem === null) {
    error('Podaj nazwę pliku z src/, np. WordPress.gs');
    exit(2);
    return;
  }
  await guard('validate-selection.js'); // bez izolatora odmowa kodem 3, zanim powstanie plik
  const out = path.join(root, 'reports', 'mutation');
  const mutants = Object.values(readJson(path.join(out, `result-${stem}.json`)).files)[0].mutants;
  const sel = readJson(path.join(out, `selection-${stem}.json`));
  const { sample, survivors, noCov, noTests } = chooseSample(mutants, sel, argv);
  const valFile = path.join(out, `selection-val-${stem}.json`);
  fs.writeFileSync(valFile, JSON.stringify(validationSelection(sel, mutants, sample, excludedOf(argv))));

  const base = readJson(path.join(root, 'stryker.config.json'));
  const valReport = path.join('reports', 'mutation', `val-${stem}.json`);
  fs.writeFileSync(path.join(out, `cfg-val-${stem}.json`), JSON.stringify({
    ...base, mutate: [`.stryker-shadow/${stem}.js`], commandRunner: { command: 'node scripts/mutation/run-for-mutant.js' },
    reporters: ['json'], jsonReporter: { fileName: valReport }, concurrency: 4, timeoutMS: 600000
  }));
  fs.rmSync(path.join(root, valReport), { force: true });
  spawn(process.execPath, [path.join(__dirname, 'prepare-shadow.js'), name], { cwd: root, stdio: 'ignore', env: safeEnv(process.env) });
  const run = spawn(process.execPath, ['node_modules/@stryker-mutator/core/bin/stryker.js', 'run', path.join(out, `cfg-val-${stem}.json`)], {
    cwd: root, encoding: 'utf8', env: safeEnv(process.env, { MUTATION_SELECTION: valFile })
  });
  if (!fs.existsSync(path.join(root, valReport))) {
    error(String(run.stdout).split(/\r?\n/).filter(l => /✖|ERROR|failed/.test(l)).slice(0, 15).join(' | '));
    exit(1);
    return;
  }
  const status = Object.fromEntries(Object.values(readJson(path.join(root, valReport)).files)[0].mutants.map(m => [m.id, m.status]));
  const result = {
    file: name, exit: run.status, probe: sample.length, survivors: survivors.length, noCoverage: noCov.length,
    staticInSample: sample.filter(m => sel.mutants[m.id] === 'STATIC').length,
    killedByFullSuite: sample.filter(m => status[m.id] !== 'Survived').map(m => ({
      static: sel.mutants[m.id] === 'STATIC', id: m.id, line: m.location.start.line, mutator: m.mutatorName, was: noTests(m) ? 'NoCoverage' : 'Survived', now: status[m.id]
    }))
  };
  fs.writeFileSync(path.join(out, `validation-${stem}.json`), JSON.stringify(result, null, 1));
  log(JSON.stringify(result, null, 1));
}

if (require.main === module) main(process.argv);
module.exports = { every, optionOf, excludedOf, chooseSample, validationSelection, main };
