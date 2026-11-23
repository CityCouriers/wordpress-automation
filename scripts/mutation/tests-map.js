'use strict';

// Mapa „plik źródłowy -> pliki testów” (#253): .quality/mutation-tests.json. Powstaje z coverage-map.js (testy, które
// naprawdę wykonują linie danego pliku src/*.gs, poza samym ładowaniem projektu) i służy zestawowi --suite=file
// oraz późniejszemu jobowi na PR (#254). Plik jest ręcznie przeglądany jak inne pliki bramki.
// Użycie: node scripts/mutation/tests-map.js write   (z reports/mutation/coverage-map.json)
//         node scripts/mutation/tests-map.js check   (waliduje plik; kod 1 przy błędach)
const fs = require('node:fs');
const path = require('node:path');
const { isExcluded } = require('./tests-list.js');

const ROOT = require('./repo-root.js');
/** Plik mapy w drzewie o korzeniu `root`. */
const fileOf = root => path.join(root, '.quality', 'mutation-tests.json');

/** Z mapy pokrycia: każdy plik src/*.gs z posortowaną listą testów, które go wykonują (może być pusta). */
function buildTestsMap(coverageMap, sources) {
  const tests = {};
  for (const name of [...sources].sort()) tests[name] = [...(coverageMap.bySource[name] || [])].sort();
  return { version: 1, tests };
}

/** Lista błędów: klucze to istniejące pliki src, testy istnieją, nie są wykluczone, są posortowane i bez powtórzeń. */
function validateTestsMap(map, { sources, testFiles }) {
  const errors = [];
  if (!map || map.version !== 1 || typeof map.tests !== 'object' || map.tests === null) return ['mapa nie ma version 1 i obiektu tests'];
  for (const name of sources) if (!(name in map.tests)) errors.push(`brak wpisu dla ${name}`);
  for (const [name, list] of Object.entries(map.tests)) {
    if (!sources.includes(name)) errors.push(`${name}: nie ma takiego pliku w src/`);
    if (!Array.isArray(list)) {
      errors.push(`${name}: lista testów nie jest tablicą`);
      continue;
    }
    for (const t of list) {
      if (isExcluded(t)) errors.push(`${name}: ${t} nie może oceniać mutantów (skanuje repozytorium albo testuje sam potok mutacji)`);
      else if (!testFiles.includes(t)) errors.push(`${name}: nie ma testu ${t}`);
    }
    if (new Set(list).size !== list.length) errors.push(`${name}: powtórzenia na liście testów`);
    if (JSON.stringify(list) !== JSON.stringify([...list].sort())) errors.push(`${name}: lista testów nie jest posortowana`);
  }
  return errors;
}

function repoLists(root) {
  return {
    sources: fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.gs')),
    testFiles: fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.js'))
  };
}

/** `root` podmienia korzeń repozytorium (testy używają drzewa tymczasowego), `error` i `exit` wyjścia. */
function main(argv, { root = ROOT, error = console.error, exit = process.exit } = {}) {
  if (argv[2] === 'write') {
    const coverage = JSON.parse(fs.readFileSync(path.join(root, 'reports', 'mutation', 'coverage-map.json')));
    fs.mkdirSync(path.dirname(fileOf(root)), { recursive: true });
    fs.writeFileSync(fileOf(root), `${JSON.stringify(buildTestsMap(coverage, repoLists(root).sources), null, 2)}\n`);
    return;
  }
  const errors = validateTestsMap(JSON.parse(fs.readFileSync(fileOf(root))), repoLists(root));
  for (const e of errors) error(e);
  exit(errors.length ? 1 : 0);
}

if (require.main === module) main(process.argv);
module.exports = { buildTestsMap, validateTestsMap, main };
