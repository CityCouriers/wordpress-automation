'use strict';

/**
 * #297: jawny rekord wdrożenia w GitHub Deployments (środowisko apps-script-live).
 * Testy chodzą przez prawdziwy HTTP na serwerze udającym API (test/helpers/fake-github.js):
 * sprawdzają utworzenie rekordu, statusy, wybór najnowszego rekordu z jego najnowszym
 * statusem i cztery ścieżki wdrożenia na prawdziwym repozytorium git.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stripGitEnv } = require('./helpers/git-env');
const { runNode } = require('./helpers/node-child');

// Hook pre-commit w drzewie roboczym ustawia GIT_DIR; `git init` w katalogu tymczasowym pisałby wtedy do prawdziwego repozytorium.
stripGitEnv();
const rec = require('../scripts/quality/deployment-record');
const { startFakeGithub } = require('./helpers/fake-github');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'quality', 'deployment-record.js');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const roots = [];
let fake;

before(async () => { fake = await startFakeGithub(); });
after(async () => {
  await fake.close();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** Asynchronicznie: spawnSync zablokowałby pętlę zdarzeń i serwer w tym procesie nie odpowiedziałby. */
function runCli(args, { env, cwd } = {}) {
  // Tymczasowa diagnostyka P1 (#297): ślad przy nietypowym wyjściu potomka, patrz test/helpers/node-child.js.
  return runNode(SCRIPT, args, { env, cwd });
}

function reset() {
  fake.state.deployments.length = 0;
  fake.state.requests.length = 0;
}

describe('createRecord', () => {
  test('tworzy rekord ze środowiskiem apps-script-live, pełnym SHA w ref i tagiem w payload, potem ustawia in_progress', async () => {
    reset();
    const id = await rec.createRecord(fake.ctx, { sha: SHA_A, tag: 'v2.43.0' });
    const [post, status] = fake.state.requests;
    assert.equal(post.method, 'POST');
    assert.equal(post.path, '/repos/acme/repo/deployments');
    assert.equal(post.headers.authorization, 'Bearer test-token');
    assert.equal(post.headers.accept, 'application/vnd.github+json');
    assert.equal(post.headers['content-type'], 'application/json');
    assert.equal(post.headers['x-github-api-version'], '2022-11-28');
    assert.deepEqual(post.body, {
      ref: SHA_A,
      environment: 'apps-script-live',
      auto_merge: false,
      required_contexts: [],
      payload: { tag: 'v2.43.0' },
      description: 'Apps Script: v2.43.0',
      transient_environment: false,
      production_environment: false
    });
    assert.equal(status.method, 'POST');
    assert.equal(status.path, `/repos/acme/repo/deployments/${id}/statuses`);
    assert.deepEqual(status.body, { state: 'in_progress', environment: 'apps-script-live', description: 'Wdrażanie v2.43.0' });
    assert.equal(fake.state.requests.length, 2);
    assert.equal(fake.state.deployments[0].id, id);
  });

  test('niepoprawny SHA albo tag odrzucony przed jakimkolwiek żądaniem (także próba wstrzyknięcia)', async () => {
    reset();
    for (const sha of ['abc123', SHA_A.toUpperCase(), SHA_A + 'a', '$(id)'.padEnd(40, 'a'), '']) {
      await assert.rejects(() => rec.createRecord(fake.ctx, { sha, tag: 'main' }), /SHA checkoutu ma niepoprawną postać/);
    }
    for (const tag of ['', 'feature/x', 'v', 'V1', 'main2', 'v1\nrm', 'v1 ; rm -rf /', 'master', 'xmain', 'notmain', '1v1.0', 'xv1',
      'v1.2', 'v1.2.3.4', 'v2.43.0-rc.1', 'v1_x', 'v0', 'v1.2.x', 'v1.2.3\n', 'v1..2.3']) {
      await assert.rejects(() => rec.createRecord(fake.ctx, { sha: SHA_A, tag }), /DEPLOY_REF musi być "main" albo tagiem vX\.Y\.Z: /);
    }
    assert.equal(fake.state.requests.length, 0);
  });

  test('przyjmowane są wyłącznie main i tagi vX.Y.Z (#296, AC-3)', async () => {
    reset();
    for (const tag of ['main', 'v2.9.1', 'v2.43.0', 'v0.0.0', 'v10.20.300']) {
      await rec.createRecord(fake.ctx, { sha: SHA_A, tag });
    }
    assert.equal(fake.state.deployments.length, 5);
  });

  test('błąd API przy tworzeniu to wyjątek z kodem i treścią, bez ustawiania statusu', async () => {
    const bad = await startFakeGithub({ failOn: { 'POST /deployments': 500 } });
    try {
      await assert.rejects(() => rec.createRecord(bad.ctx, { sha: SHA_A, tag: 'main' }), /GitHub API POST \/deployments: HTTP 500 .*wymuszony błąd/);
      assert.equal(bad.state.requests.length, 1);
    } finally { await bad.close(); }
  });

  /** Serwer HTTP o zadanej odpowiedzi; zamykany w finally także przy porażce asercji (inaczej proces testów wisi). */
  async function withServer(respond, fn) {
    const http = require('node:http');
    const srv = http.createServer(respond);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      return await fn({ ...fake.ctx, apiUrl: `http://127.0.0.1:${srv.address().port}` });
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
  }

  test('odpowiedź bez numeru rekordu jest błędem, a nie cichym sukcesem', async () => {
    reset();
    // 201 z pustym obiektem i 201 bez treści: oba bez id
    await withServer((req, res) => { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{}'); },
      ctx => assert.rejects(() => rec.createRecord(ctx, { sha: SHA_A, tag: 'main' }), /brak numeru w odpowiedzi/));
    await withServer((req, res) => { res.writeHead(201); res.end(); },
      ctx => assert.rejects(() => rec.createRecord(ctx, { sha: SHA_A, tag: 'main' }), /brak numeru w odpowiedzi/));
    assert.equal(fake.state.requests.length, 0);
  });

  test('nieudany status in_progress po utworzeniu rekordu to wyjątek', async () => {
    const bad = await startFakeGithub({ failOn: { 'POST /deployments/:id/statuses': 422 } });
    try {
      await assert.rejects(() => rec.createRecord(bad.ctx, { sha: SHA_A, tag: 'main' }), /statuses: HTTP 422/);
    } finally { await bad.close(); }
  });

  test('zły token to czytelny błąd 401', async () => {
    await assert.rejects(() => rec.createRecord({ ...fake.ctx, token: 'zly' }, { sha: SHA_A, tag: 'main' }), /HTTP 401/);
  });
});

describe('setStatus', () => {
  test('dopisuje status success albo failure do wskazanego rekordu', async () => {
    reset();
    const id = await rec.createRecord(fake.ctx, { sha: SHA_A, tag: 'main' });
    await rec.setStatus(fake.ctx, id, 'success', 'ok');
    await rec.setStatus(fake.ctx, id, 'failure', 'zle');
    const states = fake.state.deployments[0].statuses.map(s => s.state);
    assert.deepEqual(states, ['in_progress', 'success', 'failure']);
    const last = fake.state.requests[fake.state.requests.length - 1];
    assert.deepEqual(last.body, { state: 'failure', environment: 'apps-script-live', description: 'zle' });
  });

  test('niedozwolony status jest odrzucany bez żądania', async () => {
    reset();
    for (const s of ['inactive', 'error', 'queued', '', 'SUCCESS']) {
      await assert.rejects(() => rec.setStatus(fake.ctx, 1, s, 'x'), /Niedozwolony status rekordu/);
    }
    assert.equal(fake.state.requests.length, 0);
  });
});

describe('latestRecord: wybór najnowszego rekordu i jego najnowszego statusu przez API', () => {
  test('brak rekordów w środowisku → null (zapytanie z filtrem środowiska i stroną 100)', async () => {
    reset();
    assert.equal(await rec.latestRecord(fake.ctx), null);
    const [req] = fake.state.requests;
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/repos/acme/repo/deployments');
    assert.deepEqual(req.query, { environment: 'apps-script-live', per_page: '100' });
    assert.equal(fake.state.requests.length, 1);
  });

  for (const order of ['desc', 'asc', 'shuffled']) {
    test(`wybiera rekord o największym numerze niezależnie od kolejności odpowiedzi (${order})`, async () => {
      const srv = await startFakeGithub({ order });
      try {
        srv.seed({ ref: SHA_A, tag: 'v1.0.0' });
        srv.seed({ ref: SHA_B, tag: 'v1.1.0' });
        const newest = srv.seed({ ref: 'c'.repeat(40), tag: 'v1.2.0' });
        srv.seed({ ref: 'd'.repeat(40), tag: 'v0.9.0', statuses: ['success'] }); // starszy numer nie występuje: kolejność zasiewu rośnie
        srv.state.deployments.sort((x, y) => x.id - y.id);
        const top = srv.state.deployments[srv.state.deployments.length - 1];
        const r = await rec.latestRecord(srv.ctx);
        assert.equal(r.id, top.id);
        assert.notEqual(newest.id, undefined);
      } finally { await srv.close(); }
    });
  }

  test('ignoruje rekordy innych środowisk, także nowsze (automatyczny rekord production)', async () => {
    reset();
    fake.seed({ ref: SHA_A, tag: 'v1.0.0' });
    fake.seed({ ref: SHA_B, tag: 'main', environment: 'production' });
    const r = await rec.latestRecord(fake.ctx);
    assert.equal(r.ref, SHA_A);
    assert.equal(r.tag, 'v1.0.0');
  });

  test('zwraca najnowszy status rekordu niezależnie od kolejności statusów w odpowiedzi', async () => {
    for (const order of ['desc', 'asc', 'shuffled']) {
      const srv = await startFakeGithub({ order });
      try {
        srv.seed({ ref: SHA_A, tag: 'v1.0.0', statuses: ['queued', 'in_progress', 'success', 'failure'] });
        const r = await rec.latestRecord(srv.ctx);
        assert.equal(r.state, 'failure', `kolejność ${order}`);
        const statusReq = srv.state.requests.find(x => /statuses$/.test(x.path));
        assert.equal(statusReq.query.per_page, '100');
      } finally { await srv.close(); }
    }
  });

  test('rekord bez statusu ma state null; payload inny niż obiekt z tagiem daje tag undefined', async () => {
    reset();
    fake.seed({ ref: SHA_A, tag: 'v1.0.0', statuses: [] });
    assert.equal((await rec.latestRecord(fake.ctx)).state, null);
    fake.state.deployments[0].payload = '{"tag":"v7.0.0"}';
    assert.equal((await rec.latestRecord(fake.ctx)).tag, undefined, 'tekst JSON nie jest rekordem z kroku deployu');
    fake.state.deployments[0].payload = 'nie-json';
    assert.equal((await rec.latestRecord(fake.ctx)).tag, undefined);
    fake.state.deployments[0].payload = null;
    assert.equal((await rec.latestRecord(fake.ctx)).tag, undefined);
    fake.state.deployments[0].payload = 42;
    assert.equal((await rec.latestRecord(fake.ctx)).tag, undefined);
  });

  test('zwraca ref i rozwiązany sha osobno', async () => {
    reset();
    fake.seed({ ref: 'main', sha: SHA_B, tag: 'main' });
    const r = await rec.latestRecord(fake.ctx);
    assert.equal(r.ref, 'main');
    assert.equal(r.resolvedSha, SHA_B);
  });

  test('błąd API przy odczycie to wyjątek', async () => {
    const bad = await startFakeGithub({ failOn: { 'GET /deployments': 503 } });
    try {
      await assert.rejects(() => rec.latestRecord(bad.ctx), /HTTP 503/);
    } finally { await bad.close(); }
  });
});

describe('classifyRecord', () => {
  const good = { id: 7, ref: SHA_A, resolvedSha: SHA_A, tag: 'v2.43.0', state: 'success' };

  test('success z pełnym SHA i poprawnym tagiem jest akceptowany, z podaniem źródła', () => {
    assert.deepEqual(rec.classifyRecord(good), { ok: true, id: 7, sha: SHA_A, tag: 'v2.43.0', source: 'rekord Deployments #7 (apps-script-live)' });
    assert.equal(rec.classifyRecord({ ...good, tag: 'main' }).ok, true);
  });

  test('brak rekordu = czerwone "brak dowodu wdrożenia", nie domniemane wdrożenie', () => {
    const c = rec.classifyRecord(null);
    assert.equal(c.ok, false);
    assert.equal(c.kind, 'no-record');
    assert.match(c.message, /^BRAK DOWODU WDROŻENIA: brak rekordu Deployments w środowisku apps-script-live/);
  });

  for (const state of ['in_progress', 'failure', 'error', 'queued', 'pending', 'inactive', null, '', 'cokolwiek']) {
    test(`najnowszy rekord w stanie ${JSON.stringify(state)} = czerwone fail-closed, bez cofania do starszego`, () => {
      const c = rec.classifyRecord({ ...good, state });
      assert.equal(c.ok, false);
      assert.equal(c.kind, 'unfinished');
      assert.match(c.message, /^OSTATNIE WDROŻENIE NIEZAKOŃCZONE: rekord Deployments #7 \(apps-script-live\) ma status /);
      assert.match(c.message, /starszego wdrożenia nie wolno traktować jako obowiązującego/);
      if (state === null) assert.match(c.message, /ma status "brak"/);
      else assert.ok(c.message.includes(JSON.stringify(state)), c.message);
    });
  }

  test('niespójny ref, sha albo tag = czerwone "niespójny tag/SHA"', () => {
    const bad = [
      { ...good, ref: 'main' },
      { ...good, ref: SHA_A.slice(0, 39) },
      { ...good, ref: SHA_A.toUpperCase(), resolvedSha: SHA_A.toUpperCase() },
      { ...good, resolvedSha: SHA_B },
      { ...good, resolvedSha: undefined },
      { ...good, tag: 'feature' },
      { ...good, tag: undefined },
      { ...good, tag: 'v1\n::error::x' }
    ];
    for (const r of bad) {
      const c = rec.classifyRecord(r);
      assert.equal(c.ok, false, JSON.stringify(r));
      assert.equal(c.kind, 'inconsistent');
      assert.match(c.message, /^NIESPÓJNY TAG\/SHA: rekord Deployments #7 \(apps-script-live\) ma ref /);
      assert.ok(!c.message.includes('\n'), 'komunikat nie niesie złamań linii z danych rekordu');
    }
  });

  test('wartości z rekordu w komunikacie są ucięte do 80 znaków i zacytowane', () => {
    const c = rec.classifyRecord({ ...good, ref: 'x'.repeat(200), resolvedSha: 'x'.repeat(200) });
    assert.ok(c.message.includes(JSON.stringify('x'.repeat(80))));
    assert.ok(!c.message.includes('x'.repeat(81)));
  });
});

describe('contextFromEnv', () => {
  const base = { GITHUB_REPOSITORY: 'acme/repo', GH_TOKEN: 't' };

  test('adres API z env, domyślnie api.github.com, bez końcowych ukośników', () => {
    assert.equal(rec.contextFromEnv(base).apiUrl, 'https://api.github.com');
    assert.equal(rec.contextFromEnv({ ...base, GITHUB_API_URL: 'http://x.test///' }).apiUrl, 'http://x.test');
  });

  test('token z GH_TOKEN albo GITHUB_TOKEN; brak tokenu to błąd', () => {
    assert.equal(rec.contextFromEnv(base).token, 't');
    assert.equal(rec.contextFromEnv({ GITHUB_REPOSITORY: 'acme/repo', GITHUB_TOKEN: 'g' }).token, 'g');
    assert.equal(rec.contextFromEnv({ ...base, GITHUB_TOKEN: 'g' }).token, 't');
    assert.throws(() => rec.contextFromEnv({ GITHUB_REPOSITORY: 'acme/repo' }), /Brak GH_TOKEN/);
  });

  test('repozytorium musi mieć postać właściciel/nazwa', () => {
    for (const r of ['', 'acme', 'acme/repo/x', 'a c/repo', 'acme/re;po', '/repo', 'acme/']) {
      assert.throws(() => rec.contextFromEnv({ ...base, GITHUB_REPOSITORY: r }), /GITHUB_REPOSITORY musi mieć postać/);
    }
    assert.throws(() => rec.contextFromEnv({ GH_TOKEN: 't' }), /GITHUB_REPOSITORY/);
    assert.equal(rec.contextFromEnv({ ...base, GITHUB_REPOSITORY: 'A_b-1.x/r.e_p-o' }).repo, 'A_b-1.x/r.e_p-o');
  });
});

describe('CLI start/finish: rekord opisuje checkout, nie zdarzenie (cztery ścieżki wdrożenia)', () => {
  let repoDir;
  let c1;
  let c2;
  let c3;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-'));
    roots.push(repoDir);
    const g = args => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@example.pl']);
    g(['config', 'user.name', 't']);
    const commit = n => { fs.writeFileSync(path.join(repoDir, 'f.txt'), n); g(['add', '-A']); g(['commit', '-q', '-m', n]); return g(['rev-parse', 'HEAD']); };
    c1 = commit('1');
    g(['tag', 'v1.0.0']);
    c2 = commit('2');
    c3 = commit('3');
  });

  const git = args => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();

  async function start(env) {
    const out = path.join(repoDir, 'gh-output.txt');
    fs.rmSync(out, { force: true });
    const r = await runCli(['start', '--cwd', repoDir], { env: { ...process.env, ...fake.env, GITHUB_OUTPUT: out, ...env } });
    return { status: r.status, out: r.stdout + r.stderr, output: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '' };
  }

  function lastRecord() {
    const d = fake.state.deployments[fake.state.deployments.length - 1];
    return d;
  }

  test('release z taga: ref = SHA taga, payload.tag = tag, status in_progress, id w GITHUB_OUTPUT', async () => {
    reset();
    git(['checkout', '-q', '--detach', 'v1.0.0']);
    const r = await start({ DEPLOY_REF: 'v1.0.0', GITHUB_SHA: c1 });
    assert.equal(r.status, 0, r.out);
    const d = lastRecord();
    assert.equal(d.ref, c1);
    assert.deepEqual(d.payload, { tag: 'v1.0.0' });
    assert.equal(d.environment, 'apps-script-live');
    assert.deepEqual(d.statuses.map(s => s.state), ['in_progress']);
    assert.equal(r.output, `id=${d.id}\n`);
    assert.match(r.out, new RegExp(`Rekord wdrożenia #${d.id}: v1\\.0\\.0 \\(${c1}\\), status in_progress\\.`));
  });

  test('ręczne deploy_ref=main: ref = SHA main', async () => {
    reset();
    git(['checkout', '-q', 'main']);
    const r = await start({ DEPLOY_REF: 'main', GITHUB_SHA: c3 });
    assert.equal(r.status, 0, r.out);
    assert.equal(lastRecord().ref, c3);
    assert.deepEqual(lastRecord().payload, { tag: 'main' });
  });

  test('ręczny rollback do starszego taga uruchomiony z main: rekord ma SHA taga, nie SHA uruchomienia', async () => {
    reset();
    git(['checkout', '-q', '--detach', 'v1.0.0']);
    const r = await start({ DEPLOY_REF: 'v1.0.0', GITHUB_SHA: c3 });
    assert.equal(r.status, 0, r.out);
    assert.equal(lastRecord().ref, c1);
    assert.notEqual(lastRecord().ref, c3);
    assert.deepEqual(lastRecord().payload, { tag: 'v1.0.0' });
  });

  test('zmiana HEAD main między dispatch a checkoutem: rekord ma SHA checkoutu, nie zdarzenia', async () => {
    reset();
    git(['checkout', '-q', 'main']);
    const r = await start({ DEPLOY_REF: 'main', GITHUB_SHA: c2 });
    assert.equal(r.status, 0, r.out);
    assert.equal(lastRecord().ref, c3);
    assert.notEqual(lastRecord().ref, c2);
  });

  test('niepoprawny DEPLOY_REF kończy się błędem bez żadnego żądania do API', async () => {
    reset();
    for (const ref of ['', 'feature/x', 'v1; echo hacked']) {
      const r = await start({ DEPLOY_REF: ref });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /\[deployment-record\] FAIL: DEPLOY_REF musi być/);
    }
    assert.equal(fake.state.requests.length, 0);
  });

  test('bez GITHUB_OUTPUT też działa, a brak tokenu kończy błędem', async () => {
    reset();
    // Środowisko procesu bez zmiennych kroku (nie okrojone do PATH: pomiar mutacyjny przekazuje dzieciom własny znacznik).
    const bare = { ...process.env };
    for (const k of ['GITHUB_OUTPUT', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_API_URL', 'DEPLOY_REF']) delete bare[k];
    const noOut = await runCli(['start', '--cwd', repoDir], { env: { ...bare, ...fake.env, DEPLOY_REF: 'main' } });
    assert.equal(noOut.status, 0, noOut.stderr);
    const noTok = await runCli(['start', '--cwd', repoDir], { env: { ...bare, GITHUB_REPOSITORY: 'acme/repo', DEPLOY_REF: 'main' } });
    assert.equal(noTok.status, 1);
    assert.match(noTok.stderr, /Brak GH_TOKEN/);
  });

  test('finish ustawia status końcowy rekordu; niepoprawne argumenty odrzucone', async () => {
    reset();
    const id = fake.seed({ ref: SHA_A, tag: 'main', statuses: ['in_progress'] }).id;
    const run = args => runCli(args, { env: { ...process.env, ...fake.env } });
    const ok = await run(['finish', '--id', String(id), '--state', 'success']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`Rekord wdrożenia #${id}: status success\\.`));
    assert.deepEqual(fake.state.deployments[0].statuses.map(s => s.state), ['in_progress', 'success']);
    const fail = await run(['finish', '--id', String(id), '--state', 'failure']);
    assert.equal(fail.status, 0, fail.stderr);
    assert.equal(fake.state.deployments[0].statuses.pop().state, 'failure');
    const n = fake.state.requests.length;
    for (const args of [['finish', '--id', 'x', '--state', 'success'], ['finish', '--id', '12x', '--state', 'success'], ['finish', '--id', '', '--state', 'success'], ['finish', '--id', '5', '--state', 'in_progress'], ['finish', '--id', '5'], ['finish', '--state', 'success']]) {
      assert.equal((await run(args)).status, 1, args.join(' '));
    }
    assert.equal(fake.state.requests.length, n, 'żadne żądanie nie wyszło');
    const unknown = await run(['start', '--bogus']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown argument: --bogus/);
    const noValue = await run(['finish', '--id']);
    assert.match(noValue.stderr, /--id requires a value/);
    const noCmd = await run([]);
    assert.match(noCmd.stderr, /Użycie: deployment-record\.js start \| finish/);
    assert.equal((await run(['deploy'])).status, 1);
  });
});

describe('szczegóły odczytu i błędów', () => {
  test('rekordy innych środowisk zwrócone przez API mimo filtra są pomijane po stronie klienta', async () => {
    const srv = await startFakeGithub({ ignoreEnvFilter: true });
    try {
      srv.seed({ ref: SHA_A, tag: 'v1.0.0' });
      srv.seed({ ref: SHA_B, tag: 'main', environment: 'production' });
      assert.equal((await rec.latestRecord(srv.ctx)).ref, SHA_A);
    } finally { await srv.close(); }
    const none = await startFakeGithub({ ignoreEnvFilter: true });
    try {
      none.seed({ ref: SHA_B, tag: 'main', environment: 'production' });
      assert.equal(await rec.latestRecord(none.ctx), null);
    } finally { await none.close(); }
  });

  test('treść błędu API jest ucięta do 200 znaków', async () => {
    const http = require('node:http');
    const srv = http.createServer((req, res) => { res.writeHead(500); res.end('x'.repeat(1000)); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(() => rec.request({ ...fake.ctx, apiUrl: `http://127.0.0.1:${srv.address().port}` }, 'GET', '/x'), e => {
        assert.equal(e.message, `GitHub API GET /x: HTTP 500 ${'x'.repeat(200)}`);
        return true;
      });
    } finally { srv.closeAllConnections(); srv.close(); }
  });

  test('latestReleaseTag: tag najnowszego wydania, a brak wydania i błąd API dają dokładnie null', async () => {
    reset();
    fake.state.release = { tag_name: 'v3.0.0' };
    assert.equal(await rec.latestReleaseTag(fake.ctx), 'v3.0.0');
    assert.deepEqual(fake.state.requests.map(r => [r.method, r.path]), [['GET', '/repos/acme/repo/releases/latest']]);
    fake.state.release = null;
    assert.strictEqual(await rec.latestReleaseTag(fake.ctx), null);
    const bad = await startFakeGithub({ failOn: { 'GET /releases/latest': 500 } });
    try {
      assert.strictEqual(await rec.latestReleaseTag(bad.ctx), null);
    } finally { await bad.close(); }
    assert.strictEqual(await rec.latestReleaseTag({ ...fake.ctx, token: 'zly' }), null);
  });
});

describe('CLI: komunikaty argumentów i opis statusu', () => {
  test('flagi bez wartości i nazwy w komunikatach; numer rekordu tylko cyfry; opis statusu końcowego', async () => {
    reset();
    const run = args => runCli(args, { env: { ...process.env, ...fake.env } });
    for (const flag of ['--cwd', '--id', '--state']) {
      assert.match((await run(['finish', flag])).stderr, new RegExp(`FAIL: ${flag} requires a value`));
    }
    assert.match((await run(['finish', '--id', '--state', 'success'])).stderr, /FAIL: --id requires a value/);
    assert.match((await run(['finish', '--state', '--id', '5'])).stderr, /FAIL: --state requires a value/);
    assert.match((await run(['finish', '--cwd', '--id', '5'])).stderr, /FAIL: --cwd requires a value/);
    assert.match((await run(['finish', '--id', 'x5', '--state', 'success'])).stderr, /FAIL: --id musi być numerem rekordu/);
    assert.match((await run(['finish', '--id', '5', '--state', 'error'])).stderr, /FAIL: --state musi być success albo failure/);
    assert.equal(fake.state.requests.length, 0);
    const id = fake.seed({ ref: SHA_A, tag: 'main', statuses: ['in_progress'] }).id;
    assert.equal((await run(['finish', '--id', String(id), '--state', 'failure'])).status, 0);
    assert.equal(fake.state.deployments[0].statuses.pop().description, 'Wdrożenie zakończone: failure');
  });
});
