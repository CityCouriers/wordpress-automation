'use strict';

// Dobór testów per mutant (mutacje .gs). Runner `command` nie zna pokrycia per test, więc wybór robimy
// sami: plik wyboru (MUTATION_SELECTION) mapuje id mutanta na listę plików testów (zob. run-for-mutant.js).
// Zestawy (`suite`):
//   per-mutant  testy wykonujące linie mutanta (z coverage-map.js); mutant wykonywany już przy ładowaniu
//               projektu (linia z bazy) dostaje 'STATIC' (testy pliku); żaden test = pusta lista (NoCoverage),
//   file        wszystkie testy pliku z .quality/mutation-tests.json (wąski zestaw bez mapy pokrycia),
//   full        wszystkie testy ('ALL'): pomiar kosztu pełnego zestawu i sprawdzian doboru.
const SUITES = ['per-mutant', 'file', 'full'];

/** Zbiór linii pokrywanych przez testy pliku `name` (test -> Set linii) z mapy pokrycia. */
function coveringTests(map, name) {
  const covering = {};
  for (const [test, value] of Object.entries(map.tests)) if (value.sources[name]) covering[test] = new Set(value.sources[name]);
  return covering;
}

function perMutantSelection(name, mutants, map) {
  const baseline = new Set(map.baseline[name]);
  const covering = coveringTests(map, name);
  const selected = {};
  for (const m of mutants) {
    let hitsBaseline = false;
    const tests = new Set();
    const { start, end } = m.location;
    for (const line of Array.from({ length: end.line - start.line + 1 }, (_, i) => start.line + i)) {
      if (baseline.has(line)) hitsBaseline = true;
      for (const [t, set] of Object.entries(covering)) if (set.has(line)) tests.add(t);
    }
    selected[m.id] = hitsBaseline ? 'STATIC' : [...tests].sort();
  }
  return { covering: Object.keys(covering).sort(), mutants: selected };
}

/**
 * Plik wyboru dla przebiegu. `allTests`: wszystkie pliki testów; `map`: coverage-map.json (tylko per-mutant);
 * `fileTests`: wpis pliku z mutation-tests.json (tylko file).
 */
function buildSelection({ name, mutants, suite, allTests, map, fileTests }) {
  if (!SUITES.includes(suite)) throw new Error(`Nieznany zestaw testów: ${suite}`);
  const all = [...allTests].sort();
  if (suite === 'full') return { source: name, all, covering: all, mutants: Object.fromEntries(mutants.map(m => [m.id, 'ALL'])) };
  if (suite === 'file') {
    const tests = [...(fileTests || [])].sort();
    return { source: name, all, covering: tests, mutants: Object.fromEntries(mutants.map(m => [m.id, tests])) };
  }
  const picked = perMutantSelection(name, mutants, map);
  return { source: name, all, covering: picked.covering, mutants: picked.mutants };
}

/** Liczby rodzajów wyboru: statyczne, bez testu, z doborem. */
function selectionKinds(selection) {
  const kinds = { static: 0, none: 0, some: 0 };
  for (const v of Object.values(selection.mutants)) kinds[v === 'STATIC' ? 'static' : v.length === 0 ? 'none' : 'some']++;
  return kinds;
}

module.exports = { SUITES, buildSelection, selectionKinds };
