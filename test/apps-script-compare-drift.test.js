'use strict';

/**
 * #297: tryb `--drift` skryptu apps-script-compare.js przez CLI, od rekordu zapisanego
 * przez deployment-record.js do wyniku drift checku (serwer udający API GitHub, prawdziwe
 * repozytorium git, pobranie zastąpione kopią plików).
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stripGitEnv } = require('./helpers/git-env');

// Hook pre-commit w drzewie roboczym ustawia GIT_DIR; `git init` w katalogu tymczasowym pisałby wtedy do prawdziwego repozytorium.
stripGitEnv();
const { startFakeGithub } = require('./helpers/fake-github');
const { makeRepo, liveFiles } = require('./helpers/drift-fixture');

const COMPARE = path.resolve(__dirname, '..', 'scripts', 'quality', 'apps-script-compare.js');
const RECORD = path.resolve(__dirname, '..', 'scripts', 'quality', 'deployment-record.js');
const roots = [];
let fx;
let fake;
let copyScript;

before(async () => {
  fx = makeRepo(roots);
  fake = await startFakeGithub();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  roots.push(dir);
  copyScript = path.join(dir, 'copy-live.js');
  fs.writeFileSync(copyScript, "const fs=require('fs');const p=require('path');for(const f of fs.readdirSync(process.env.FAKE_LIVE))fs.copyFileSync(p.join(process.env.FAKE_LIVE,f),f);console.log('Pulled by copy.');\n");
});
after(async () => {
  await fake.close();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
beforeEach(() => {
  fake.state.deployments.length = 0;
  fake.state.requests.length = 0;
  fake.state.release = null;
});

const tmp = prefix => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
};

function exec(script, args, { env, cwd }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

/** Żywy projekt = pliki z `files` w katalogu, który podstawione pobranie kopiuje do --cwd. */
function liveDirOf(files) {
  const d = tmp('src-live-');
  for (const [name, text] of files) fs.writeFileSync(path.join(d, name), text);
  return d;
}

async function drift({ files, env = {}, args = [], invoker = tmp('invoker-') }) {
  const cwd = tmp('pull-');
  const summary = path.join(invoker, 'summary.md');
  const full = {
    ...process.env,
    ...fake.env,
    APPS_SCRIPT_PULL_CMD: `"${process.execPath}" "${copyScript}"`,
    FAKE_LIVE: liveDirOf(files || new Map()),
    GITHUB_STEP_SUMMARY: summary,
    ...env
  };
  delete full.COMPARE_REF;
  if (env.COMPARE_REF !== undefined) full.COMPARE_REF = env.COMPARE_REF;
  const r = await exec(COMPARE, ['--drift', '--cwd', cwd, '--repo-dir', fx.dir, ...args], { env: full, cwd: invoker });
  return { ...r, invoker, cwd, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : null };
}

describe('apps-script-compare --drift (CLI)', () => {
  test('zgodny projekt: kod 0, raport z rewizją i źródłem w stdout i w podsumowaniu joba', async () => {
    const rec = fake.seed({ ref: fx.shas.c2, tag: 'v1.1.0' });
    const r = await drift({ files: liveFiles(fx.dir, fx.shas.c2, 'v1.1.0') });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const expected = `✅ Apps Script zgodny z wdrożoną rewizją v1.1.0 (${fx.shas.c2}), źródło: rekord Deployments #${rec.id} (apps-script-live).\n\n\`\`\`\nPulled by copy.\n\`\`\`\n`;
    assert.equal(r.stdout, expected);
    assert.equal(r.summary, expected);
  });

  test('informacja o nowszym wydaniu to ::notice::, nie błąd', async () => {
    fake.seed({ ref: fx.shas.c2, tag: 'v1.1.0' });
    fake.state.release = { tag_name: 'v1.2.0' };
    const r = await drift({ files: liveFiles(fx.dir, fx.shas.c2, 'v1.1.0') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^::notice::Najnowsze opublikowane wydanie "v1\.2\.0" jest inne niż wdrożony ref "v1\.1\.0" /m);
    assert.equal(r.stderr, '');
  });

  test('różnica: kod 1, ::error:: z nagłówkiem, patch zapisany względem katalogu bieżącego wywołującego', async () => {
    fake.seed({ ref: fx.shas.c2, tag: 'v1.1.0' });
    const files = liveFiles(fx.dir, fx.shas.c2, 'v1.1.0');
    files.set('Kod.gs', 'function a() { return 42; }\n');
    const r = await drift({ files, args: ['--patch', 'drift.patch'] });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^❌ Żywy projekt Apps Script różni się od wdrożonej rewizji v1\.1\.0 /);
    assert.match(r.stdout, / M Kod\.gs\n```\nPatch saved to drift\.patch\.\n$/);
    assert.match(r.stderr, /^::error::Żywy projekt Apps Script różni się od wdrożonej rewizji v1\.1\.0 \(.*\)\. Patch w artefakcie\.\n$/);
    assert.match(fs.readFileSync(path.join(r.invoker, 'drift.patch'), 'utf8'), /\+function a\(\) \{ return 42; \}/);
    assert.deepEqual(fs.readdirSync(r.cwd).filter(f => /patch/.test(f)), [], 'patch nie trafia do katalogu pobrania');
  });

  test('różnica bez --patch: bez zapisu patcha i bez wzmianki o artefakcie', async () => {
    fake.seed({ ref: fx.shas.c2, tag: 'v1.1.0' });
    const files = liveFiles(fx.dir, fx.shas.c2, 'v1.1.0');
    files.set('Kod.gs', 'function a() { return 42; }\n');
    const r = await drift({ files });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /Patch saved/);
    assert.match(r.stderr, /\(apps-script-live\)\.\n$/);
    assert.doesNotMatch(r.stderr, /Patch w artefakcie/);
    assert.deepEqual(fs.readdirSync(r.invoker).filter(f => /\.patch$/.test(f)), []);
  });

  test('--ref-dir: katalog roboczy na drzewa porównania', async () => {
    fake.seed({ ref: fx.shas.c2, tag: 'v1.1.0' });
    const files = liveFiles(fx.dir, fx.shas.c2, 'v1.1.0');
    files.set('Kod.gs', 'function a() { return 42; }\n');
    const refDir = tmp('work-');
    const r = await drift({ files, args: ['--ref-dir', refDir] });
    assert.equal(r.status, 1);
    assert.ok(fs.existsSync(path.join(refDir, 'ref', 'Kod.gs')));
    assert.ok(fs.existsSync(path.join(refDir, 'live', 'Kod.gs')));
  });

  test('brak rekordu i niezakończone wdrożenie: kod 1 z komunikatem, bez pobrania', async () => {
    const none = await drift({ files: new Map() });
    assert.equal(none.status, 1);
    assert.match(none.stdout, /^❌ BRAK DOWODU WDROŻENIA/);
    assert.match(none.stderr, /^::error::BRAK DOWODU WDROŻENIA/);
    assert.deepEqual(fs.readdirSync(none.cwd), [], 'nic nie pobrano');
    fake.seed({ ref: fx.shas.c2, tag: 'v1.1.0', statuses: ['in_progress'] });
    const open = await drift({ files: new Map() });
    assert.equal(open.status, 1);
    assert.match(open.stderr, /^::error::OSTATNIE WDROŻENIE NIEZAKOŃCZONE/);
  });

  test('COMPARE_REF: tryb diagnostyczny oznaczony w raporcie, API nietknięte', async () => {
    const r = await drift({ files: liveFiles(fx.dir, fx.shas.c3, 'main'), env: { COMPARE_REF: 'main' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^✅ DIAGNOSTYCZNY, nie zastępuje kontroli regularnej: /);
    assert.equal(fake.state.requests.length, 0);
    const bad = await drift({ files: new Map(), env: { COMPARE_REF: 'main; id' } });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /^::error::compare_ref musi być /);
  });

  test('błąd (np. API) kończy się kodem 1 i komunikatem FAIL; flagi bez wartości odrzucone', async () => {
    const bad = await startFakeGithub({ failOn: { 'GET /deployments': 500 } });
    try {
      const r = await drift({ files: new Map(), env: { ...bad.env } });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /\[apps-script-compare\] FAIL: GitHub API GET .*HTTP 500/);
    } finally { await bad.close(); }
    for (const flag of ['--repo-dir', '--ref-dir']) {
      const r = await exec(COMPARE, ['--drift', flag], { env: process.env, cwd: tmp('inv-') });
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`FAIL: ${flag} requires a value`));
    }
  });

  test('domyślny katalog repozytorium to katalog bieżący', async () => {
    fake.seed({ ref: fx.shas.c2, tag: 'v1.1.0' });
    const cwd = tmp('pull-');
    const r = await exec(COMPARE, ['--drift', '--cwd', cwd], {
      env: { ...process.env, ...fake.env, APPS_SCRIPT_PULL_CMD: `"${process.execPath}" "${copyScript}"`, FAKE_LIVE: liveDirOf(liveFiles(fx.dir, fx.shas.c2, 'v1.1.0')) },
      cwd: fx.dir
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});

describe('od zapisu rekordu przez deployment-record.js do wyniku drift checku', () => {
  async function deployFrom(checkoutRef, deployRef, eventSha) {
    fx.g(['checkout', '-q', '--detach', checkoutRef]);
    const r = await exec(RECORD, ['start', '--cwd', fx.dir], { env: { ...process.env, ...fake.env, DEPLOY_REF: deployRef, GITHUB_SHA: eventSha }, cwd: fx.dir });
    fx.g(['checkout', '-q', 'main']);
    assert.equal(r.status, 0, r.stderr);
    return fake.state.deployments[fake.state.deployments.length - 1];
  }

  async function finish(d, state) {
    const r = await exec(RECORD, ['finish', '--id', String(d.id), '--state', state], { env: { ...process.env, ...fake.env }, cwd: fx.dir });
    assert.equal(r.status, 0, r.stderr);
  }

  test('rollback uruchomiony z main (zdarzenie = SHA main): drift porównuje z rewizją taga i jest zielony po success', async () => {
    const d = await deployFrom('v1.0.0', 'v1.0.0', fx.shas.c3);
    assert.equal(d.ref, fx.shas.c1);
    const files = liveFiles(fx.dir, fx.shas.c1, 'v1.0.0');
    const during = await drift({ files });
    assert.equal(during.status, 1, 'w trakcie wdrożenia (in_progress) czerwone');
    assert.match(during.stderr, /OSTATNIE WDROŻENIE NIEZAKOŃCZONE/);
    await finish(d, 'success');
    const after = await drift({ files });
    assert.equal(after.status, 0, after.stdout + after.stderr);
    assert.match(after.stdout, new RegExp(`wdrożoną rewizją v1\\.0\\.0 \\(${fx.shas.c1}\\)`));
  });

  test('wdrożenie przerwane po clasp push (status failure albo brak statusu końcowego): czerwone, bez cofania do starszego', async () => {
    const older = await deployFrom('v1.0.0', 'v1.0.0', fx.shas.c3);
    await finish(older, 'success');
    const newer = await deployFrom('v1.1.0', 'v1.1.0', fx.shas.c3);
    const files = liveFiles(fx.dir, fx.shas.c2, 'v1.1.0');
    const interrupted = await drift({ files });
    assert.equal(interrupted.status, 1);
    assert.match(interrupted.stderr, /OSTATNIE WDROŻENIE NIEZAKOŃCZONE/);
    await finish(newer, 'failure');
    const failed = await drift({ files: liveFiles(fx.dir, fx.shas.c1, 'v1.0.0') });
    assert.equal(failed.status, 1, 'żywy projekt zgodny ze starszym wdrożeniem nie ratuje wyniku');
    assert.match(failed.stderr, /OSTATNIE WDROŻENIE NIEZAKOŃCZONE/);
    await finish(newer, 'success');
    assert.equal((await drift({ files })).status, 0);
  });

  test('ręczny deploy_ref=main po zmianie HEAD main między dispatch a checkoutem: drift porównuje z SHA checkoutu', async () => {
    const d = await deployFrom('main', 'main', fx.shas.c2);
    assert.equal(d.ref, fx.shas.c3);
    await finish(d, 'success');
    const r = await drift({ files: liveFiles(fx.dir, fx.shas.c3, 'main') });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const stale = await drift({ files: liveFiles(fx.dir, fx.shas.c2, 'main') });
    assert.equal(stale.status, 1, 'żywy projekt z c2, a wdrożony c3');
  });
});

describe('drift bez --ref-dir', () => {
  test('wywołujący nie dostaje żadnych plików ani katalogów poza podsumowaniem joba', async () => {
    fake.seed({ ref: fx.shas.c2, tag: 'v1.1.0' });
    const files = liveFiles(fx.dir, fx.shas.c2, 'v1.1.0');
    files.set('Kod.gs', 'function a() { return 77; }\n');
    const invoker = tmp('invoker-');
    const r = await drift({ files, invoker });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(fs.readdirSync(invoker).filter(n => n !== 'summary.md'), []);
  });
});
