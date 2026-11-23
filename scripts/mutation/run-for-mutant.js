'use strict';

// Komenda testowa StrykerJS z doborem testów per mutant (pilot mutacji). Stryker z runnerem `command`
// nie zna pokrycia per test, więc wybór robimy sami: plik wyboru (MUTATION_SELECTION) mapuje id
// mutanta na listę plików testów, które wykonują jego linie (z coverage-map.js).
//   - brak id (suchy przebieg): testy pliku, który mutujemy (selection.covering),
//   - 'STATIC': mutant wykonywany już przy ładowaniu projektu (np. stała); dostaje testy pliku
//     (selection.covering), bo pełny zestaw po kolei trwa ponad 2 min na mutant. Stała używana tylko
//     w innym pliku może więc umknąć: ocenia to validate-selection.js próbką na pełnym zestawie,
//   - 'ALL': wszystkie testy (używa validate-selection.js),
//   - pusta lista: żaden test nie wykonuje tej linii. Nic nie uruchamiamy, mutant wychodzi jako
//     `Survived` i jest oznaczany `NoCoverage` w raporcie (report.js).
// Pliki testów idą po kolei, od najmniejszego, i przerywamy na pierwszej porażce (kod != 0 to zabicie).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeEnv } = require('./safe-env.js');
const { requireIsolationFacts } = require('./isolation-guard.js');

const ROOT = require('./repo-root.js');

/** Wpis pliku wyboru dla mutanta `id` (undefined: suchy przebieg) albo undefined, gdy mutanta w nim nie ma. */
function entryOf(selection, id) {
  return id === undefined ? selection.covering : selection.mutants[id];
}

/** `deps` podmienia korzeń, otoczenie, bramkę, uruchamianie procesów i wyjścia (testy; produkcyjnie domyślne). */
function main({ root = ROOT, env = process.env, guard = requireIsolationFacts, spawn = spawnSync, error = console.error, exit = process.exit } = {}) {
  guard('run-for-mutant.js'); // bez izolatora odmowa (kod 3), zanim cokolwiek się uruchomi
  const selection = JSON.parse(fs.readFileSync(env.MUTATION_SELECTION));
  const id = env.__STRYKER_ACTIVE_MUTANT__;
  const entry = entryOf(selection, id);
  if (entry === undefined) {
    error(`Brak mutanta ${id} w pliku wyboru: pomiar nieważny.`);
    exit(70);
    return;
  }
  const files = (entry === 'ALL' ? selection.all : entry === 'STATIC' ? selection.covering : entry)
    .map(f => path.join('test', f))
    .sort((a, b) => fs.statSync(path.join(root, a)).size - fs.statSync(path.join(root, b)).size);

  for (const file of files) {
    const result = spawn(
      process.execPath,
      ['--require', path.join(__dirname, 'vm-preload.js'), '--test', file],
      { cwd: root, stdio: 'inherit', env: safeEnv(env) }
    );
    if (result.status !== 0) {
      exit(result.status === null ? 1 : result.status);
      return;
    }
  }
  exit(0);
}

if (require.main === module) main();
module.exports = { main, entryOf };
