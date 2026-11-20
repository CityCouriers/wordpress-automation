'use strict';

/**
 * Repozytorium git i "żywy projekt" do testów drift checku (#297).
 *
 * Historia: c0 (tag v0.9.0, źródła w katalogu głównym, układ sprzed #105), c1 (tag v1.0.0,
 * układ src/), c2 (tag v1.1.0), c3 (main, o jeden commit przed v1.1.0), plus commit
 * `side` na gałęzi bocznej (nie jest przodkiem main).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stripGitEnv } = require('./git-env');

// Hook pre-commit w drzewie roboczym ustawia GIT_DIR; `git init` w katalogu tymczasowym pisałby wtedy do prawdziwego repozytorium.
stripGitEnv();
const drift = require('../../scripts/quality/apps-script-drift');

const REPO = 'acme/repo';
const STAMP = { deployedAt: '2026-11-17T08:00:00Z', deployedBy: 'octocat' };

function makeRepo(roots) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfx-'));
  roots.push(dir);
  const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@example.pl']);
  g(['config', 'user.name', 't']);
  g(['config', 'core.autocrlf', 'false']);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const commit = msg => { g(['add', '-A']); g(['commit', '-q', '-m', msg]); return g(['rev-parse', 'HEAD']); };

  write('Kod.gs', 'function a() { return 0; }\n');
  write('GA4.gs', 'function b() {}\n');
  write('appsscript.json', '{"timeZone":"Europe/Warsaw"}\n');
  write('Version.gs', "const DEPLOYED_VERSION = { tag: 'dev' };\n");
  const c0 = commit('c0');
  g(['tag', 'v0.9.0']);

  g(['rm', '-q', '-r', '--cached', '.']);
  for (const f of ['Kod.gs', 'GA4.gs', 'appsscript.json', 'Version.gs']) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.renameSync(path.join(dir, f), path.join(dir, 'src', f));
  }
  write('package.json', '{"name":"x","version":"1.0.0"}\n');
  const c1 = commit('c1');
  g(['tag', 'v1.0.0']);

  write('src/Kod.gs', 'function a() { return 1; }\n');
  const c2 = commit('c2');
  g(['tag', 'v1.1.0']);

  write('src/Kod.gs', 'function a() { return 2; }\n');
  const c3 = commit('c3');

  g(['checkout', '-q', '-b', 'side', c1]);
  write('src/Side.gs', 'function side() {}\n');
  const side = commit('side');
  g(['checkout', '-q', 'main']);

  return { dir, g, write, shas: { c0, c1, c2, c3, side } };
}

/** Pliki żywego projektu odpowiadające rewizji `sha`, ze stemplowanym Version.gs. */
function liveFiles(repoDir, sha, tag, stamp = {}) {
  const files = new Map();
  const tree = drift.readTree(repoDir, sha);
  for (const [name, text] of tree.files) files.set(name, text);
  files.set('Version.gs', drift.renderVersionFile({ tag, commit: sha.slice(0, 7), ...STAMP, ...stamp }, REPO));
  return files;
}

/** Podstawia pobranie: wpisuje `files` do katalogu i zwraca tekst "pobrania". */
function fakePull(files, calls) {
  return dir => {
    if (calls) calls.push(dir);
    for (const [name, text] of files) fs.writeFileSync(path.join(dir, name), text);
    return 'Pulled files.';
  };
}

module.exports = { makeRepo, liveFiles, fakePull, REPO, STAMP };
