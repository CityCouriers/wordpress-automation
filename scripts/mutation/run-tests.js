'use strict';

// Komenda testowa dla StrykerJS (pilot mutacji). Uruchamia testy `node --test` z mostem
// vm-preload.js, bez testów skanujących samo repozytorium (git ls-files, wordpress/, .git):
// w kopii roboczej Strykera nie mają czego skanować i padają niezależnie od mutacji.
// Otoczenie testów to allowlista (safe-env.js): poświadczenia i GIT_* nie przechodzą.
// Użycie: node scripts/mutation/run-tests.js [plik.test.js ...]  (bez argumentów: wszystkie)
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeEnv } = require('./safe-env.js');
const { requireIsolationFacts } = require('./isolation-guard.js');
const { listTests } = require('./tests-list.js');

const ROOT = require('./repo-root.js');

/** `deps` podmienia korzeń, bramkę, uruchamianie procesu i wyjście (testy; produkcyjnie domyślne). */
function main(argv, { root = ROOT, guard = requireIsolationFacts, spawn = spawnSync, exit = process.exit } = {}) {
  // Komenda testowa Strykera jest też wejściem dla surowego `stryker run`: bez izolatora odmawia, więc mutanty nie ruszą.
  guard('run-tests.js');
  const requested = argv.slice(2);
  const files = requested.length > 0
    ? requested
    : listTests(root).map(f => path.join('test', f));

  const result = spawn(
    process.execPath,
    ['--require', path.join(__dirname, 'vm-preload.js'), '--test', '--test-concurrency=2', ...files],
    { cwd: root, stdio: 'inherit', env: safeEnv(process.env) }
  );
  exit(result.status === null ? 1 : result.status);
}

if (require.main === module) main(process.argv);
module.exports = { main };
