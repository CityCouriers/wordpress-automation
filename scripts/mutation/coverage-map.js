'use strict';

// Mapa "plik testów -> pliki src/*.gs, które naprawdę wykonuje" z pokrycia LCOV każdego pliku testów
// osobno, względem wzorca load-only. Wynik: reports/mutation/coverage-map.json
//   { baseline: { "<Plik.gs>": [linie wykonane już przy samym ładowaniu] }, tests: { "<test>": { "<Plik.gs>": [linie spoza wzorca] } }, bySource: { "<Plik.gs>": ["<test>", ...] } }
// Użycie: node scripts/mutation/coverage-map.js   (ok. 3-4 min, sekwencyjnie)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseLcov } = require('./lcov.js');
const { safeEnv } = require('./safe-env.js');
const { listTests } = require('./tests-list.js');

const ROOT = require('./repo-root.js');

function coverageOf(ctx, testFile, tag) {
  const lcov = path.join(ctx.tmp, `${tag}.info`);
  const r = ctx.spawn(process.execPath, [
    '--test', '--experimental-test-coverage', '--test-coverage-include=src/*.gs',
    '--test-reporter=lcov', `--test-reporter-destination=${lcov}`, testFile
  ], { cwd: ctx.root, encoding: 'utf8', env: safeEnv(process.env) });
  if (!fs.existsSync(lcov)) throw new Error(`Brak LCOV dla ${testFile}: ${r.stderr}`);
  return { exit: r.status, cov: parseLcov(lcov) };
}

/** Linie wykonane przez test ponad bazą (samo ładowanie projektu), posortowane. */
function extraLines(data, base) {
  return [...data.lines].filter(([line, hits]) => hits > 0 && !(base.get(line) > 0)).map(([line]) => line).sort((a, b) => a - b);
}

/** `deps` podmienia korzeń, uruchamianie procesów i wyjścia (testy; produkcyjnie domyślne). */
function main({ root = ROOT, spawn = spawnSync, log = console.log, progress = text => process.stderr.write(text) } = {}) {
  const out = path.join(root, 'reports', 'mutation');
  const tmp = path.join(out, 'tmp-lcov');
  fs.mkdirSync(tmp, { recursive: true });
  const ctx = { root, tmp, spawn };
  const baseline = coverageOf(ctx, path.join('scripts', 'mutation', 'load-only.test.js'), 'baseline').cov;
  const tests = {};
  const bySource = {};
  const files = listTests(root);
  for (const f of files) {
    const { exit, cov } = coverageOf(ctx, path.join('test', f), f.replace(/\W/g, '_'));
    tests[f] = { exit, sources: {} };
    for (const [src, data] of Object.entries(cov)) {
      const extra = extraLines(data, baseline[src] ? baseline[src].lines : new Map());
      if (extra.length) {
        tests[f].sources[src] = extra;
        (bySource[src] = bySource[src] || []).push(f);
      }
    }
    progress(`${f}: ${Object.keys(tests[f].sources).length} plików src\n`);
  }
  const baselineLines = Object.fromEntries(Object.entries(baseline).map(([src, d]) => [src, [...d.lines].filter(([, h]) => h > 0).map(([l]) => l).sort((a, b) => a - b)]));
  fs.writeFileSync(path.join(out, 'coverage-map.json'), JSON.stringify({ baseline: baselineLines, tests, bySource }, null, 1));
  log(`Zapisano reports/mutation/coverage-map.json (${files.length} plików testów)`);
}

if (require.main === module) main();
module.exports = { main, extraLines };
