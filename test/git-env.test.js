'use strict';

/**
 * #292: testy pomocnika `test/helpers/git-env.js` (`stripGitEnv`).
 *
 * Hook pre-commit dziedziczy po gicie `GIT_INDEX_FILE`, a uruchomiony w powiązanym drzewie roboczym także `GIT_DIR`.
 * Test, który w katalogu tymczasowym woła `git init` i `git config user.*` z takim otoczeniem, pisze do prawdziwego
 * repozytorium (zdarzyło się: `core.bare=true` i `user.name=test` we wspólnym `.git/config`). Tu dowodzimy tego na
 * prawdziwym gicie i prawdziwym repozytorium zewnętrznym (katalog tymczasowy, nie to repozytorium, w którym działa
 * test): scenariusz ze zdjętymi zmiennymi nie rusza zewnętrznego repozytorium, ten sam scenariusz bez zdjęcia je zmienia.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stripGitEnv } = require('./helpers/git-env');

const HELPER = path.resolve(__dirname, 'helpers', 'git-env.js');
const roots = [];

after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

// Własne polecenia gita tego testu (budowa i odczyt repozytoriów tymczasowych) nigdy nie dziedziczą GIT_* po hooku.
const cleanEnv = () => stripGitEnv({ ...process.env });
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
const tmp = prefix => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('stripGitEnv: zdejmowanie zmiennych GIT_*', () => {
  test('usuwa każdą zmienną zaczynającą się od GIT_ i zostawia pozostałe', () => {
    const env = stripGitEnv({
      GIT_DIR: '/x/.git', GIT_INDEX_FILE: '/x/.git/index', GIT_WORK_TREE: '/x', GIT_: 'pusty-sufiks',
      PATH: '/bin', HOME: '/home/u', GITHUB_TOKEN: 'nie-zaczyna-sie-od-GIT_', MY_GIT_DIR: 'GIT_w-srodku', DIGIT_X: '1'
    });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/home/u', GITHUB_TOKEN: 'nie-zaczyna-sie-od-GIT_', MY_GIT_DIR: 'GIT_w-srodku', DIGIT_X: '1' });
  });

  test('zwraca ten sam obiekt, który dostał (czyści w miejscu)', () => {
    const env = { GIT_DIR: 'x', KEEP: '1' };
    assert.equal(stripGitEnv(env), env);
    assert.equal('GIT_DIR' in env, false);
  });

  test('pusty obiekt zostaje pusty', () => {
    assert.deepEqual(stripGitEnv({}), {});
  });

  test('bez argumentu czyści process.env', () => {
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE, keep: process.env.GIT_ENV_TEST_KEEP };
    process.env.GIT_DIR = path.join(os.tmpdir(), 'nie-ma-takiego-katalogu');
    process.env.GIT_INDEX_FILE = path.join(os.tmpdir(), 'nie-ma-indeksu');
    process.env.GIT_ENV_TEST_KEEP = '1';
    try {
      assert.equal(stripGitEnv(), process.env);
      assert.equal(process.env.GIT_DIR, undefined);
      assert.equal(process.env.GIT_INDEX_FILE, undefined);
      assert.equal(process.env.GIT_ENV_TEST_KEEP, undefined, 'każda zmienna z prefiksem GIT_ znika, nie tylko dwie znane');
      assert.ok(process.env.PATH || process.env.Path, 'zmienne bez prefiksu zostają');
    } finally {
      for (const [name, value] of [['GIT_DIR', saved.dir], ['GIT_INDEX_FILE', saved.index], ['GIT_ENV_TEST_KEEP', saved.keep]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});

describe('stripGitEnv: hookowe GIT_DIR i GIT_INDEX_FILE nie przekierowują poleceń gita do cudzego repozytorium', () => {
  // Potomek odtwarza początek fikstury testowej: opcjonalnie zdejmuje GIT_*, potem `git init` i `git config user.*` w katalogu roboczym.
  const CHILD = `
    const { execFileSync } = require('child_process');
    const [, helper, dir, mode] = process.argv;
    if (mode === 'strip') require(helper).stripGitEnv();
    const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    g(['init', '-q']);
    g(['config', 'user.email', 'fikstura@example.pl']);
    g(['config', 'user.name', 'fikstura']);
  `;

  /** Zewnętrzne repozytorium z jednym commitem i własną tożsamością: "prawdziwe" repo, do którego hook kieruje GIT_DIR. */
  function externalRepo() {
    const dir = tmp('gitenv-ext-');
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'core.autocrlf', 'false']);
    git(dir, ['config', 'user.email', 'wlasciciel@example.pl']);
    git(dir, ['config', 'user.name', 'wlasciciel']);
    fs.writeFileSync(path.join(dir, 'plik.txt'), 'zawartość\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'pierwszy']);
    return dir;
  }

  const snapshot = ext => ({
    config: fs.readFileSync(path.join(ext, '.git', 'config'), 'utf8'),
    head: fs.readFileSync(path.join(ext, '.git', 'HEAD'), 'utf8'),
    index: sha(path.join(ext, '.git', 'index')),
    commit: git(ext, ['rev-parse', 'HEAD']),
    log: git(ext, ['log', '--format=%s']),
    status: git(ext, ['status', '--porcelain'])
  });

  /** Uruchamia potomka z GIT_* wskazującymi na `ext`, tak jak ustawia je hook w powiązanym drzewie roboczym. */
  function runChild(ext, work, mode) {
    const env = {
      ...cleanEnv(),
      GIT_DIR: path.join(ext, '.git'),
      GIT_INDEX_FILE: path.join(ext, '.git', 'index'),
      GIT_WORK_TREE: ext
    };
    return spawnSync(process.execPath, ['-e', CHILD, HELPER, work, mode], { env, encoding: 'utf8' });
  }

  test('po stripGitEnv zewnętrzne repozytorium zostaje bez zmian, a fikstura dostaje własne .git z własną tożsamością', () => {
    const ext = externalRepo();
    const work = tmp('gitenv-work-');
    const before = snapshot(ext);

    const r = runChild(ext, work, 'strip');

    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(snapshot(ext), before, 'zewnętrzne repozytorium (config, HEAD, indeks, historia, status) bez zmian');
    assert.doesNotMatch(before.config, /fikstura/);
    const own = fs.readFileSync(path.join(work, '.git', 'config'), 'utf8');
    assert.match(own, /name = fikstura/, 'tożsamość trafiła do repozytorium w katalogu roboczym');
    assert.match(own, /email = fikstura@example\.pl/);
  });

  test('kontrola: bez stripGitEnv ten sam scenariusz zmienia zewnętrzne repozytorium (test umie paść)', () => {
    const ext = externalRepo();
    const work = tmp('gitenv-work-');
    const before = snapshot(ext);

    const r = runChild(ext, work, 'bez');

    assert.equal(r.status, 0, r.stderr);
    assert.notDeepEqual(snapshot(ext), before, 'zewnętrzne repozytorium zostało zmienione');
    assert.match(fs.readFileSync(path.join(ext, '.git', 'config'), 'utf8'), /name = fikstura/, 'tożsamość fikstury w cudzym repozytorium');
    assert.equal(fs.existsSync(path.join(work, '.git')), false, 'katalog roboczy nie dostał własnego repozytorium');
  });
});
