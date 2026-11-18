'use strict';

/**
 * #295: magazyn stanu na prawdziwym gicie (katalog tymczasowy, bare origin i dwa klony). Osobny plik, bo
 * każdy proces gita bywa tu wolny (kilka sekund na przebieg); logikę protokołu pokrywają atrapy w innych plikach.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createGitStore } = require('../scripts/freshness-monitor/git-store');
const { gitExec } = require('../scripts/freshness-monitor/cli');
const { stripGitEnv } = require('./helpers/git-env');

stripGitEnv();

describe('#295 magazyn stanu na prawdziwym gicie (katalog tymczasowy)', () => {
  const run = (cwd, args) => {
    const out = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout.trim();
  };

  function twoClones() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-monitor-test-'));
    const origin = path.join(root, 'origin.git');
    run(root, ['init', '--bare', '--quiet', origin]);
    const clone = name => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      run(dir, ['init', '--quiet']);
      run(dir, ['remote', 'add', 'origin', origin]);
      return { dir, store: createGitStore({ exec: gitExec(dir) }) };
    };
    return { root, origin, a: clone('a'), b: clone('b') };
  }

  test('brak gałęzi, pierwszy zapis, odczyt i zapis na wersji z odczytu', async () => {
    const env = twoClones();
    try {
      assert.deepEqual(await env.a.store.read(), { text: null, version: null });
      const first = await env.a.store.write('{"a":1}\n', null);
      assert.equal(first.ok, true);
      assert.match(first.version, /^[0-9a-f]{40}$/);
      const read = await env.b.store.read();
      assert.deepEqual(read, { text: '{"a":1}\n', version: first.version });
      const second = await env.b.store.write('{"a":2}\n', read.version);
      assert.equal(second.ok, true);
      assert.equal(run(env.origin, ['rev-list', '--count', 'monitor-state']), '2');
      assert.equal(run(env.origin, ['show', 'monitor-state:state.json']), '{"a":2}');
      assert.equal(run(env.origin, ['log', '-1', '--format=%an <%ae>', 'monitor-state']), 'freshness-monitor <freshness-monitor@localhost>');
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  test('zapis na starej wersji to konflikt (non-fast-forward), a stan na gałęzi się nie zmienia', async () => {
    const env = twoClones();
    try {
      const first = await env.a.store.write('{"v":1}\n', null);
      const stale = await env.b.store.read();
      assert.equal(stale.version, first.version);
      const winner = await env.a.store.write('{"v":2}\n', first.version);
      assert.equal(winner.ok, true);
      assert.deepEqual(await env.b.store.write('{"v":3}\n', stale.version), { ok: false, conflict: true });
      assert.equal(run(env.origin, ['show', 'monitor-state:state.json']), '{"v":2}');
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });

  test('dwa pierwsze zapisy bez wersji: drugi to konflikt, nie nadpisanie', async () => {
    const env = twoClones();
    try {
      assert.equal((await env.a.store.write('{"w":"a"}\n', null)).ok, true);
      assert.deepEqual(await env.b.store.write('{"w":"b"}\n', null), { ok: false, conflict: true });
      assert.equal(run(env.origin, ['show', 'monitor-state:state.json']), '{"w":"a"}');
    } finally {
      fs.rmSync(env.root, { recursive: true, force: true });
    }
  });
});
