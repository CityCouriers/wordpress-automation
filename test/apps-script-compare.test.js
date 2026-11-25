'use strict';

/**
 * #44: wspólny skrypt porównania projektu Apps Script z checkoutem, użyty przez
 * deploy (weryfikacja po pushu) i drift check. Testowany na tymczasowym repo z
 * podstawionym poleceniem pobrania (APPS_SCRIPT_PULL_CMD).
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { stripGitEnv } = require('./helpers/git-env');
const { runNodeSync } = require('./helpers/node-child');

// Hook pre-commit w drzewie roboczym ustawia GIT_DIR; `git init` w katalogu tymczasowym pisałby wtedy do prawdziwego repozytorium.
stripGitEnv();
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'quality', 'apps-script-compare.js');
const roots = [];

after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/**
 * Repo z trzema źródłami; `fake` to skrypt symulujący clasp pull (mutacje w cwd).
 * `dir` wybiera układ: '.' to tagi sprzed #105, 'src' to układ bieżący.
 */
function repo(fakePullBody, dir) {
  const sub = dir || '.';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-'));
  roots.push(root);
  const g = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.pl']);
  g(['config', 'user.name', 'test']);
  // Byte-exact comparisons regardless of the developer's global autocrlf.
  g(['config', 'core.autocrlf', 'false']);
  const srcDir = path.join(root, sub);
  if (sub !== '.') fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'Kod.gs'), 'function a() {}\n');
  fs.writeFileSync(path.join(srcDir, 'GA4.gs'), 'function b() {}\n');
  fs.writeFileSync(path.join(srcDir, 'Version.gs'), "const DEPLOYED_VERSION = { tag: 'dev' };\n");
  fs.writeFileSync(path.join(srcDir, 'appsscript.json'), '{"timeZone":"Europe/Warsaw"}\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.clasp.json\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'base']);
  const fake = path.join(root, 'fake-clasp.js');
  fs.writeFileSync(fake, `'use strict';\nconst fs=require('fs');\n${fakePullBody}\nconsole.log('Pulled files.');\n`);
  return { root, fake };
}

function run(root, fake, extraArgs = [], env = {}) {
  const summary = path.join(root, 'summary.md');
  const r = runNodeSync(SCRIPT, ['--cwd', root, '--label', 'v9.9.9', ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, APPS_SCRIPT_PULL_CMD: `"${process.execPath}" "${fake}"`, GITHUB_STEP_SUMMARY: summary, ...env }
  });
  const summaryText = fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '';
  return { status: r.status, out: r.stdout + r.stderr, summary: summaryText };
}

describe('apps-script-compare', () => {
  test('identical project → OK, exit 0, summary mentions the label and the pull output', () => {
    const { root, fake } = repo('');
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /✅ Apps Script matches v9\.9\.9\./);
    assert.match(r.summary, /Pulled files\./);
  });

  test('missing trailing newlines and a stamped Version.gs are not drift', () => {
    const { root, fake } = repo(`
      fs.writeFileSync('Kod.gs', 'function a() {}');
      fs.writeFileSync('appsscript.json', '{"timeZone":"Europe/Warsaw"}');
      fs.writeFileSync('Version.gs', "const DEPLOYED_VERSION = { tag: 'v9.9.9', commit: 'abc' };\\n");
    `);
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.readFileSync(path.join(root, 'Version.gs'), 'utf8'), "const DEPLOYED_VERSION = { tag: 'dev' };\n", 'Version.gs restored from git');
  });

  test('a committed source without a final newline that Apps Script returns with one is not drift (v2.15.0 deploy failure)', () => {
    const { root, fake } = repo(`fs.writeFileSync('Kod.gs', 'function a() {}\\n');`);
    const g = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(path.join(root, 'Kod.gs'), 'function a() {}');
    g(['commit', '-q', '-am', 'drop final newline']);
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /✅ Apps Script matches v9\.9\.9\./);
  });

  test('the same file with a real change on top of the newline difference is still drift', () => {
    const { root, fake } = repo(`fs.writeFileSync('Kod.gs', 'function a() { return 2; }\\n');`);
    const g = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    fs.writeFileSync(path.join(root, 'Kod.gs'), 'function a() {}');
    g(['commit', '-q', '-am', 'drop final newline']);
    const r = run(root, fake, ['--patch', 'drift.patch']);
    assert.equal(r.status, 1);
    assert.match(r.out, / M Kod\.gs/);
    assert.match(fs.readFileSync(path.join(root, 'drift.patch'), 'utf8'), /return 2/);
  });

  test('a changed source is drift: exit 1, file listed, patch written', () => {
    const { root, fake } = repo(`fs.writeFileSync('GA4.gs', 'function b() { return 1; }\\n');`);
    const r = run(root, fake, ['--patch', 'drift.patch']);
    assert.equal(r.status, 1);
    assert.match(r.out, /❌ Apps Script differs from v9\.9\.9/);
    assert.match(r.out, / M GA4\.gs/);
    assert.match(r.out, /::error::Apps Script project differs from v9\.9\.9\. See the job summary and the patch artifact\./);
    const patch = fs.readFileSync(path.join(root, 'drift.patch'), 'utf8');
    assert.match(patch, /\+function b\(\) \{ return 1; \}/);
  });

  test('a new file in the live project is drift and appears in the patch', () => {
    const { root, fake } = repo(`fs.writeFileSync('Extra.gs', 'function extra() {}\\n');`);
    const r = run(root, fake, ['--patch', 'drift.patch']);
    assert.equal(r.status, 1);
    assert.match(r.out, /\?\? Extra\.gs/);
    assert.match(fs.readFileSync(path.join(root, 'drift.patch'), 'utf8'), /\+function extra\(\) \{\}/);
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    assert.match(status, /\?\? Extra\.gs/, 'intent-to-add was reset, file stays untracked');
  });

  test('files outside the sources (e.g. .clasp.json) never count as drift', () => {
    const { root, fake } = repo(`fs.writeFileSync('.clasp.json', '{"scriptId":"x"}'); fs.writeFileSync('notes.txt', 'x');`);
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
  });

  test('a ref without Version.gs (older tag) is compared without trying to restore it', () => {
    const { root, fake } = repo('');
    execFileSync('git', ['rm', '-q', 'Version.gs'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@e.pl', '-c', 'user.name=t', 'commit', '-q', '-m', 'no version file'], { cwd: root });
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
  });

  test('#105: układ src — zgodny projekt to brak driftu', () => {
    const { root, fake } = repo('', 'src');
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /✅ Apps Script matches v9\.9\.9\./);
  });

  test('#105: układ src — zmiana źródła jest driftem i trafia do patcha', () => {
    const { root, fake } = repo(`fs.writeFileSync('src/GA4.gs', 'function b() { return 1; }\\n');`, 'src');
    const r = run(root, fake, ['--patch', 'drift.patch']);
    assert.equal(r.status, 1);
    assert.match(r.out, / M src\/GA4\.gs/);
    assert.match(fs.readFileSync(path.join(root, 'drift.patch'), 'utf8'), /\+function b\(\) \{ return 1; \}/);
  });

  test('#105: układ src — stemplowany Version.gs i brak końcowej nowej linii nie są driftem', () => {
    const { root, fake } = repo(`
      fs.writeFileSync('src/Kod.gs', 'function a() {}');
      fs.writeFileSync('src/appsscript.json', '{"timeZone":"Europe/Warsaw"}');
      fs.writeFileSync('src/Version.gs', "const DEPLOYED_VERSION = { tag: 'v9.9.9', commit: 'abc' };\\n");
    `, 'src');
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
  });

  test('#105: układ src — plik w katalogu głównym nie jest źródłem i nie liczy się jako drift', () => {
    const { root, fake } = repo(`fs.writeFileSync('Extra.gs', 'function extra() {}\\n');`, 'src');
    const r = run(root, fake);
    assert.equal(r.status, 0, 'poza src/ nic nie jest wdrażane, więc nie jest driftem');
  });

  test('a flag without a value fails fast with a clear message', () => {
    const { root, fake } = repo('');
    const r = runNodeSync(SCRIPT, ['--cwd', root, '--label'], { encoding: 'utf8', env: { ...process.env, APPS_SCRIPT_PULL_CMD: `"${process.execPath}" "${fake}"` } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--label requires a value/);
  });

  test('a failing pull is reported as a clear failure, not a diff', () => {
    const { root, fake } = repo(`process.exit(3);`);
    const r = run(root, fake);
    assert.equal(r.status, 1);
    assert.match(r.out, /\[apps-script-compare\] FAIL: Pull failed/);
  });
});

/**
 * Kontrola zerowa mutacyjna (#297): testy dopisane przed zmianą skryptu, żeby zabić
 * mutanty ocalałe w kodzie sprzed zmiany (Stryker, 274 mutanty, 78 ocalałych).
 */
describe('apps-script-compare: kontrola zerowa', () => {
  const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  /** Uruchomienie z rozdzielonym stdout/stderr, dowolnymi argumentami i opcjami procesu. */
  function raw(root, fake, args, { env = {}, spawn = {}, pull = `"${process.execPath}" "${fake}"`, summary = true } = {}) {
    const summaryFile = path.join(root, 'summary.md');
    const full = { ...process.env, APPS_SCRIPT_PULL_CMD: pull, GITHUB_STEP_SUMMARY: summaryFile, ...env };
    if (!summary) delete full.GITHUB_STEP_SUMMARY;
    if (pull === null) delete full.APPS_SCRIPT_PULL_CMD;
    const r = runNodeSync(SCRIPT, [...args], { encoding: 'utf8', env: full, ...spawn });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : null };
  }

  test('domyślne wartości: etykieta, brak patcha i katalog bieżący', () => {
    const { root, fake } = repo('');
    const r = raw(root, fake, [], { spawn: { cwd: root } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '✅ Apps Script matches the checked-out ref.\n\n```\nPulled files.\n```\n');
    const d = repo("fs.writeFileSync('GA4.gs', 'x\\n');");
    const r2 = raw(d.root, d.fake, [], { spawn: { cwd: d.root } });
    assert.equal(r2.status, 1);
    assert.match(r2.stdout, /❌ Apps Script differs from the checked-out ref:/);
    assert.doesNotMatch(r2.stdout, /Patch saved/, 'bez --patch nic nie jest zapisywane');
    assert.deepEqual(fs.readdirSync(d.root).filter(f => /\.patch$/.test(f)), []);
    assert.match(r2.stderr, /::error::Apps Script project differs from the checked-out ref\. See the job summary\.\n/);
  });

  test('dokładne podsumowanie: zgodny projekt, różnica z patchem, brak zmiennej GITHUB_STEP_SUMMARY', () => {
    const ok = repo('');
    assert.equal(raw(ok.root, ok.fake, ['--cwd', ok.root, '--label', 'v1']).summary, '✅ Apps Script matches v1.\n\n```\nPulled files.\n```\n');
    const d = repo("fs.writeFileSync('GA4.gs', 'x\\n');");
    const r = raw(d.root, d.fake, ['--cwd', d.root, '--label', 'v1', '--patch', 'p.patch']);
    assert.equal(r.summary, '❌ Apps Script differs from v1:\n\n```\n M GA4.gs\n```\nPatch saved to p.patch.\n');
    assert.equal(r.stdout, '❌ Apps Script differs from v1:\n\n```\n M GA4.gs\n```\nPatch saved to p.patch.\n');
    const none = raw(ok.root, ok.fake, ['--cwd', ok.root], { summary: false });
    assert.equal(none.status, 0, none.stderr);
  });

  test('milczące pobranie nie dokleja bloku z wynikiem pobrania', () => {
    const { root, fake } = repo('');
    const r = raw(root, fake, ['--cwd', root, '--label', 'v1'], { pull: `"${process.execPath}" -e ""` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '✅ Apps Script matches v1.\n');
  });

  test('flagi: brak wartości (także gdy kolejny argument jest flagą) i nieznany argument', () => {
    const { root, fake } = repo('');
    for (const flag of ['--label', '--patch', '--cwd']) {
      assert.match(raw(root, fake, [flag]).stderr, new RegExp(`FAIL: ${flag} requires a value`));
      assert.match(raw(root, fake, [flag, '--label', 'x']).stderr, new RegExp(`FAIL: ${flag} requires a value`));
    }
    assert.match(raw(root, fake, ['--bogus']).stderr, /FAIL: Unknown argument: --bogus/);
    assert.match(raw(root, fake, ['--cwd', root, '--bogus', 'x']).stderr, /FAIL: Unknown argument: --bogus/);
  });

  test('--cwd i --patch trafiają do właściwych pól (patch względem --cwd)', () => {
    const { root, fake } = repo("fs.writeFileSync('GA4.gs', 'x\\n');");
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-other-'));
    roots.push(other);
    const r = raw(root, fake, ['--patch', 'out.patch', '--cwd', root], { spawn: { cwd: other } });
    assert.equal(r.status, 1);
    assert.ok(fs.existsSync(path.join(root, 'out.patch')));
    assert.deepEqual(fs.readdirSync(other), []);
  });

  test('porażka pobrania: komunikat z poleceniem i stderr (przed stdout), bez dodatkowych białych znaków', () => {
    const cmdOf = fake => `"${process.execPath}" "${fake}"`;
    const a = repo("console.error('BLAD'); console.log('WYJSCIE'); process.exit(3);");
    const r = raw(a.root, a.fake, ['--cwd', a.root]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr, `\n[apps-script-compare] FAIL: Pull failed (${cmdOf(a.fake)}): BLAD\n`);
    const b = repo("console.log('WYJSCIE'); process.exit(3);");
    assert.equal(raw(b.root, b.fake, ['--cwd', b.root]).stderr, `\n[apps-script-compare] FAIL: Pull failed (${cmdOf(b.fake)}): WYJSCIE\n`);
    const c = repo('process.exit(3);');
    assert.equal(raw(c.root, c.fake, ['--cwd', c.root]).stderr, `\n[apps-script-compare] FAIL: Pull failed (${cmdOf(c.fake)}): \n`);
  });

  test('błąd uruchomienia pobrania (np. brak katalogu) jest zgłoszony z przyczyną systemową', () => {
    const { root, fake } = repo('');
    const r = raw(root, fake, ['--cwd', path.join(root, 'nie-ma-takiego')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FAIL: Pull failed \(.+\): spawnSync .*ENOENT/);
  });

  test('bez APPS_SCRIPT_PULL_CMD uruchamia `npx clasp pull` w katalogu --cwd', () => {
    const { root, fake } = repo('');
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-bin-'));
    roots.push(bin);
    const fakeNpx = (okBody, winBody) => {
      if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'npx.cmd'), winBody);
      else fs.writeFileSync(path.join(bin, 'npx'), okBody, { mode: 0o755 });
    };
    fakeNpx('#!/bin/sh\necho FAKE-NPX "$@"\n', '@echo off\r\necho FAKE-NPX %*\r\n');
    const env = { PATH: bin + path.delimiter + process.env.PATH };
    const r = raw(root, fake, ['--cwd', root, '--label', 'v1'], { pull: null, env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '✅ Apps Script matches v1.\n\n```\nFAKE-NPX clasp pull\n```\n');
    fakeNpx('#!/bin/sh\necho BLAD >&2\nexit 4\n', '@echo off\r\necho BLAD 1>&2\r\nexit /b 4\r\n');
    const bad = raw(root, fake, ['--cwd', root], { pull: null, env });
    // Node 24 dopisuje do stderr ostrzeżenie DEP0190 (shell + argumenty), więc sprawdzamy końcówkę.
    assert.ok(bad.stderr.endsWith('\n[apps-script-compare] FAIL: Pull failed (npx clasp pull): BLAD\n'), bad.stderr);
  });

  test('układ: katalog src bez appsscript.json nie jest układem src', () => {
    const { root, fake } = repo("fs.writeFileSync('GA4.gs', 'function b() { return 1; }\\n');");
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'notatki.txt'), 'x');
    const r = raw(root, fake, ['--cwd', root]);
    assert.equal(r.status, 1, 'źródła w katalogu głównym są porównywane mimo obcego katalogu src/');
    assert.match(r.stdout, / M GA4\.gs/);
  });

  test('pliki o rozszerzeniu zawierającym .gs nie są źródłami i nie dostają końcowej nowej linii', () => {
    const { root, fake } = repo("fs.writeFileSync('Kod.gs.bak', 'bez nowej linii');");
    const r = raw(root, fake, ['--cwd', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'Kod.gs.bak'), 'utf8'), 'bez nowej linii');
  });

  test('pusty zacommitowany plik, który żywy projekt zwraca z nową linią, jest driftem', () => {
    const { root, fake } = repo("fs.writeFileSync('Pusty.gs', '\\n');");
    fs.writeFileSync(path.join(root, 'Pusty.gs'), '');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'pusty']);
    const r = raw(root, fake, ['--cwd', root]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, / M Pusty\.gs/);
  });

  test('dodatkowa pusta linia na końcu pliku z końcową nową linią jest driftem', () => {
    const { root, fake } = repo("fs.writeFileSync('Kod.gs', 'function a() {}\\n\\n');");
    const r = raw(root, fake, ['--cwd', root]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, / M Kod\.gs/);
  });

  test('plik z wiodącą spacją w nazwie, różniący się samą końcową nową linią, nie jest driftem (nazwa nie jest przycinana)', { skip: process.platform === 'win32' }, () => {
    const { root, fake } = repo("fs.writeFileSync(' Spacja.gs', 'x\\n');");
    fs.writeFileSync(path.join(root, ' Spacja.gs'), 'x');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'spacja']);
    const r = raw(root, fake, ['--cwd', root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test('eksporty modułu: compare i normalizacje, a samo wczytanie modułu niczego nie uruchamia', () => {
    const m = require(SCRIPT);
    assert.equal(typeof m.compare, 'function');
    assert.equal(typeof m.normalizeTrailingNewline, 'function');
    assert.equal(typeof m.normalizeIndexTrailingNewline, 'function');
    const { root } = repo('');
    assert.deepEqual(m.compare(root), { changes: '', patch: '' });
  });

  test('nieśledzony plik obok zmienionego: patch zawiera oba, a indeks zostaje czysty', () => {
    const { root, fake } = repo("fs.writeFileSync('GA4.gs', 'function b() { return 1; }\\n'); fs.writeFileSync('Extra.gs', 'function e() {}\\n');");
    const r = raw(root, fake, ['--cwd', root, '--patch', 'd.patch']);
    assert.equal(r.status, 1);
    const patch = fs.readFileSync(path.join(root, 'd.patch'), 'utf8');
    assert.match(patch, /\+function b\(\) \{ return 1; \}/);
    assert.match(patch, /\+function e\(\) \{\}/);
    assert.equal(git(root, ['diff', '--cached', '--name-only']), '', 'indeks bez zmian po przebiegu');
  });
});


describe('apps-script-compare: układ src ogranicza porównanie do plików źródłowych', () => {
  test('zmieniony śledzony plik niebędący źródłem w src/ nie jest driftem', () => {
    const { root, fake } = repo("fs.writeFileSync('src/notes.txt', 'zmienione\\n');", 'src');
    fs.writeFileSync(path.join(root, 'src', 'notes.txt'), 'oryginal\n');
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'notes'], { cwd: root });
    const r = run(root, fake);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /notes\.txt/);
  });
});

/**
 * #312: spłata 22 ocalałych mutantów w funkcjach nietkniętych przez #297 (Stryker, kontrola zerowa na `main` = `b4abce3`).
 * Każdy test opisuje zachowanie, którego zmutowany kod nie zachowuje; mutanty bez takiego zachowania (równoważne)
 * są rozliczone w opisie PR razem z niezależnym audytem.
 */
describe('apps-script-compare: spłata ocalałych mutantów (#312)', () => {
  const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  function cli(root, fake, args, { env = {}, noPullCmd = false } = {}) {
    const full = { ...process.env, APPS_SCRIPT_PULL_CMD: `"${process.execPath}" "${fake}"`, ...env };
    if (noPullCmd) delete full.APPS_SCRIPT_PULL_CMD;
    const r = runNodeSync(SCRIPT, [...args], { encoding: 'utf8', env: full });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  test('git poza repozytorium: błąd niesie stderr gita (strumienie git() są przechwytywane, nie przekazywane dalej)', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-nogit-'));
    roots.push(plain);
    const { fake } = repo('');
    const r = cli(plain, fake, ['--cwd', plain], { env: { LC_ALL: 'C', LANGUAGE: 'C', GIT_CEILING_DIRECTORIES: path.dirname(plain) } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\[apps-script-compare\] FAIL: Command failed: git ls-files[^\n]*\nfatal: not a git repository/);
    assert.equal(r.stdout, '');
  });

  test('pull(): opcja shell zależy od platformy (tylko win32 używa powłoki dla npx), sprawdzone dla obu gałęzi', () => {
    const { root, fake } = repo('');
    const pre = path.join(root, 'preload-platform.js');
    // Atrapa: podmienia platformę i spawnSync; wywołanie `npx` zapisuje (polecenie, argumenty, shell) zamiast je uruchamiać.
    fs.writeFileSync(pre, [
      "const cp = require('child_process'); const fs = require('fs');",
      "Object.defineProperty(process, 'platform', { value: process.env.FAKE_PLATFORM });",
      'const real = cp.spawnSync;',
      'cp.spawnSync = function (cmd, args, opts) {',
      "  if (cmd === 'npx') { fs.writeFileSync(process.env.REC_FILE, JSON.stringify({ cmd, args, shell: opts.shell })); return { status: 0, stdout: 'ATRAPA', stderr: '' }; }",
      '  return real.apply(this, arguments);',
      '};'
    ].join('\n'));
    const seen = {};
    for (const platform of ['win32', 'linux', 'darwin']) {
      const rec = path.join(root, `rec-${platform}.json`);
      const r = cli(root, fake, ['--cwd', root, '--label', 'v1'], {
        noPullCmd: true,
        env: { NODE_OPTIONS: `--require "${pre.split(path.sep).join('/')}"`, FAKE_PLATFORM: platform, REC_FILE: rec }
      });
      assert.equal(r.status, 0, platform + ': ' + r.stderr);
      assert.match(r.stdout, /ATRAPA/, platform + ': wynik pobrania trafia do raportu');
      seen[platform] = JSON.parse(fs.readFileSync(rec, 'utf8'));
    }
    assert.deepEqual(seen.win32, { cmd: 'npx', args: ['clasp', 'pull'], shell: true });
    assert.deepEqual(seen.linux, { cmd: 'npx', args: ['clasp', 'pull'], shell: false });
    assert.deepEqual(seen.darwin, { cmd: 'npx', args: ['clasp', 'pull'], shell: false });
  });

  test('plik usunięty w żywym projekcie jest driftem, a jego usunięcie trafia do patcha bez ruszania indeksu', () => {
    const { root, fake } = repo("fs.unlinkSync('GA4.gs');");
    const r = cli(root, fake, ['--cwd', root, '--patch', 'del.patch']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, / D GA4\.gs/);
    const patch = fs.readFileSync(path.join(root, 'del.patch'), 'utf8');
    assert.match(patch, /deleted file mode/);
    assert.match(patch, /-function b\(\) \{\}/);
    assert.equal(git(root, ['diff', '--cached', '--name-only']), '', 'usunięcie nie zostaje w indeksie');
  });

  test('normalizacja indeksu zostaje po przebiegu z driftem w innym pliku (reset dotyczy tylko plików intent-to-add)', () => {
    const { root, fake } = repo("fs.writeFileSync('Kod.gs', 'function a() {}\\n'); fs.writeFileSync('GA4.gs', 'function b() { return 1; }\\n');");
    fs.writeFileSync(path.join(root, 'Kod.gs'), 'function a() {}');
    git(root, ['commit', '-q', '-am', 'bez końcowej nowej linii']);
    const r = cli(root, fake, ['--cwd', root]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, / M GA4\.gs/);
    assert.doesNotMatch(r.stdout, /Kod\.gs/, 'sama końcowa nowa linia nie jest driftem');
    assert.equal(git(root, ['diff', '--cached', '--name-only']).trim(), 'Kod.gs', 'znormalizowana wersja pliku zostaje w indeksie');
  });

  /**
   * Testy poniżej wynikają z niezależnego audytu mutantów uznanych wstępnie za równoważne: audyt wykazał, że da się je zabić.
   * Używają `compare()` bezpośrednio na repozytorium bez Version.gs i appsscript.json (część z nich wymaga braku pliku o tej nazwie).
   */
  const { compare } = require(SCRIPT);
  const NBSP = ' ';

  function mini(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-mini-'));
    roots.push(root);
    const g = (...args) => git(root, args);
    g('init', '-q');
    g('config', 'user.email', 'test@example.pl');
    g('config', 'user.name', 'test');
    g('config', 'core.autocrlf', 'false');
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    return { root, g };
  }

  const BASE = { 'Kod.gs': 'function a() {}\n', 'GA4.gs': 'function b() {}\n' };

  // Wpis tylko w indeksie pod „katalogiem” appsscript.json (pathspec dosłowny obejmuje wszystko pod nim); plik na dysku nie powstaje.
  function indexOnly(g, root, name, { commit = false } = {}) {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'hello\n', encoding: 'utf8' }).trim();
    g('-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},${name}`);
    if (commit) g('-c', 'core.protectNTFS=false', 'commit', '-q', '-m', 'wpis');
    else g('-c', 'core.protectNTFS=false', 'update-index', '--skip-worktree', name);
  }

  test('stdin gita to urządzenie znakowe (null), nie potok: sterownik diff.external widzi rodzaj deskryptora', () => {
    const { root, g } = mini(BASE);
    const ext = path.join(root, 'ext-diff.js');
    fs.writeFileSync(ext, [
      "const fs = require('fs');",
      'const st = fs.fstatSync(0);',
      "fs.writeFileSync(process.env.STDIN_OUT, st.isCharacterDevice() ? 'char' : st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : 'other');"
    ].join('\n'));
    const fwd = p => p.split(path.sep).join('/');
    g('config', 'diff.external', `"${fwd(process.execPath)}" "${fwd(ext)}"`);
    fs.writeFileSync(path.join(root, 'GA4.gs'), 'function b() { return 1; }\n');
    const out = path.join(root, 'stdin-type.txt');
    process.env.STDIN_OUT = out;
    try { compare(root); } finally { delete process.env.STDIN_OUT; }
    assert.equal(fs.readFileSync(out, 'utf8'), 'char');
  });

  // #317: nazwy plików czytamy z wyjścia gita rozdzielanego NUL-em (`ls-files -z`) i nie przycinamy ich, więc plik z wiodącym białym znakiem
  // w nazwie jest normalizowany jak każdy inny, a różnica samej końcowej nowej linii nie jest driftem. Domyślna konfiguracja gita
  // (core.quotePath = true), czyli bez obejścia cytowania, które ukrywało błąd dla NBSP.
  for (const [opis, name] of [['wiodącą spacją', ' Sp.gs'], ['wiodącym NBSP', `${NBSP}Nb.gs`], ['spacją w środku', 'a b.gs']]) {
    test(`śledzony plik z ${opis} w nazwie: sama końcowa nowa linia nie jest driftem, a indeks dostaje znormalizowaną wersję`, () => {
      const { root, g } = mini({ [name]: 'x', 'Kod.gs': 'function a() {}\n' });
      fs.writeFileSync(path.join(root, name), 'x\n');
      assert.deepEqual(compare(root), { changes: '', patch: '' });
      assert.equal(g('show', ':' + name), 'x\n', 'indeks ma wersję z końcową nową linią');
    });
  }

  test('śledzony plik z wiodącą spacją w nazwie i prawdziwą zmianą treści jest driftem zgłoszonym pod pełną nazwą', () => {
    const { root } = mini({ ' Sp.gs': 'x', 'Kod.gs': 'function a() {}\n' });
    fs.writeFileSync(path.join(root, ' Sp.gs'), 'y\n');
    const r = compare(root);
    assert.equal(r.changes, ' M  Sp.gs');
    assert.match(r.patch, /^\+y$/m);
  });

  // #318: wyniki gita większe niż domyślny limit 1 MiB (maxBuffer Node) nie mogą kończyć kontroli wyjątkiem ENOBUFS ani fałszywym driftem.
  // Wejście ma 3 MiB, czyli wyraźnie więcej niż limit: tuż nad granicą wynik zależał od wyścigu (status `null` albo 0, gdy git zdążył wyjść),
  // a dla wejścia o kilka MiB większego niż limit stdout jest obcięty, a status zawsze `null` (bez atrapy, deterministycznie).
  const MIB3 = 3 * 1024 * 1024;
  const wiersze = liczba => 'function f() { return 1234567890; }\n'.repeat(liczba);
  const LINII = Math.ceil(MIB3 / wiersze(1).length);

  test('diff większy niż 1 MiB: compare() zwraca zmiany i pełny patch, bez wyjątku (ENOBUFS)', () => {
    const { root } = mini({ 'Kod.gs': wiersze(LINII) });
    fs.writeFileSync(path.join(root, 'Kod.gs'), wiersze(LINII).replace(/1234567890/g, '0987654321'));
    const r = compare(root);
    assert.equal(r.changes, ' M Kod.gs');
    assert.ok(Buffer.byteLength(r.patch) > 2 * MIB3, `patch ma ${Buffer.byteLength(r.patch)} B, oczekiwano pełnego diffu (usunięte + dodane wiersze)`);
    assert.equal(r.patch.split('\n').filter(l => l === '+function f() { return 0987654321; }').length, LINII, 'wszystkie dodane wiersze są w patchu');
    assert.ok(r.patch.endsWith('\n'), 'patch nie jest obcięty w środku wiersza');
  });

  test('nieśledzony plik większy niż 1 MiB jest driftem: patch zawiera go w całości', () => {
    const { root } = mini(BASE);
    fs.writeFileSync(path.join(root, 'Nowy.gs'), wiersze(LINII));
    const r = compare(root);
    assert.equal(r.changes, '?? Nowy.gs');
    assert.equal(r.patch.split('\n').filter(l => l === '+function f() { return 1234567890; }').length, LINII);
  });

  test('śledzony plik większy niż 1 MiB bez końcowej nowej linii: sama różnica końcowej nowej linii nie jest driftem, a indeks dostaje znormalizowaną wersję', () => {
    const bezNowejLinii = wiersze(LINII).slice(0, -1);
    const { root } = mini({ 'Big.gs': bezNowejLinii, 'Kod.gs': 'function a() {}\n' });
    fs.writeFileSync(path.join(root, 'Big.gs'), bezNowejLinii + '\n');
    assert.deepEqual(compare(root), { changes: '', patch: '' });
    // Własny maxBuffer: domyślny 1 MiB uciąłby odczyt pliku w samym teście.
    const wIndeksie = execFileSync('git', ['show', ':Big.gs'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(wIndeksie.length, bezNowejLinii.length + 1, 'indeks ma cały plik z końcową nową linią (stdout git show nie jest obcięty)');
    assert.ok(wIndeksie.endsWith('\n'));
  });

  // Ta sama atrapa dla innej awarii `git show` (np. uszkodzony obiekt, kod wyjścia gita różny od 0): plik jest pomijany, więc różnica zostaje widoczna jako
  // drift (kierunek bezpieczny: lepiej zgłosić, niż po cichu uznać za zgodny). Dawny test „znane ograniczenie” (#312) utrwalał tu ENOBUFS, który po #318 nie występuje.
  test('gdy git show kończy się niepowodzeniem (kod wyjścia różny od 0), plik bez końcowej nowej linii nie jest normalizowany i zostaje widoczną różnicą', () => {
    const { root } = mini({ 'Big.gs': 'x', 'Kod.gs': 'function a() {}\n' });
    fs.writeFileSync(path.join(root, 'Big.gs'), 'x\n');
    const cp = require('child_process');
    const real = cp.spawnSync;
    cp.spawnSync = function (cmd, args) {
      const r = real.apply(this, arguments);
      if (cmd === 'git' && args[0] === 'show') return { ...r, status: 128, stderr: 'fatal: atrapa' };
      return r;
    };
    let patched;
    try {
      delete require.cache[SCRIPT];
      patched = require(SCRIPT);
    } finally {
      cp.spawnSync = real;
      delete require.cache[SCRIPT];
    }
    assert.equal(patched.compare(root).changes, ' M Big.gs');
    assert.equal(compare(root).changes, '', 'bez atrapy ten sam plik jest normalizowany (sama końcowa nowa linia nie jest driftem)');
  });

  // Przegląd „spróbuj to obejść” (#318): na Linuksie spawnSync, który przekroczył maxBuffer, bywa kończony ze statusem 0, błędem ENOBUFS i OBCIĘTYM stdout.
  // Obcięty prefiks + „\n” wyglądał wtedy jak sama różnica końcowej nowej linii, więc `git add` kasował brakujący ogon pliku (prawdziwy drift uchodził).
  // Atrapa odtwarza ten wynik deterministycznie (status 0, error ENOBUFS, stdout = początek bloba); sam `error` ma więc wystarczyć do pominięcia pliku.
  test('git show ze statusem 0, ale z błędem ENOBUFS i obciętym stdout: plik nie jest normalizowany, obcięty ogon pozostaje driftem', () => {
    const { root, g } = mini({ 'Big.gs': 'abcdef', 'Kod.gs': 'function a() {}\n' });
    fs.writeFileSync(path.join(root, 'Big.gs'), 'abc\n');
    const cp = require('child_process');
    const real = cp.spawnSync;
    cp.spawnSync = function (cmd, args) {
      const r = real.apply(this, arguments);
      if (cmd === 'git' && args[0] === 'show') return { ...r, status: 0, stdout: 'abc', error: Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' }) };
      return r;
    };
    let patched;
    try {
      delete require.cache[SCRIPT];
      patched = require(SCRIPT);
    } finally {
      cp.spawnSync = real;
      delete require.cache[SCRIPT];
    }
    const r = patched.compare(root);
    assert.equal(r.changes, ' M Big.gs');
    assert.match(r.patch, /^-abcdef$/m, 'patch pokazuje utracony ogon pliku');
    assert.equal(g('show', ':Big.gs'), 'abcdef', 'indeks nie dostał obciętej wersji');
  });

  test('zmiana tylko w indeksie, której ścieżka kończy się na ?? (pod appsscript.json/), nie jest driftem', () => {
    const { root, g } = mini(BASE);
    indexOnly(g, root, 'appsscript.json/a??');
    assert.deepEqual(compare(root), { changes: '', patch: '' });
  });

  // #317: nazwy w raporcie są dosłowne, w tym końcowe białe znaki (wcześniej końcówka raportu była przycinana razem z nazwą).
  test('końcowe białe znaki w nazwie pliku w ostatnim wierszu raportu zostają w całości (dwa NBSP)', () => {
    const { root, g } = mini(BASE);
    indexOnly(g, root, `appsscript.json/n${NBSP}${NBSP}`, { commit: true });
    assert.equal(compare(root).changes, ` D appsscript.json/n${NBSP}${NBSP}`);
  });

  test('jeden końcowy NBSP w nazwie pliku w ostatnim wierszu raportu zostaje', () => {
    const { root, g } = mini(BASE);
    indexOnly(g, root, `appsscript.json/n${NBSP}`, { commit: true });
    assert.equal(compare(root).changes, ` D appsscript.json/n${NBSP}`);
  });

  test('nieśledzony plik ze spacją w nazwie jest driftem: raport i patch go zawierają, a po przebiegu nic nie zostaje w indeksie', () => {
    const { root, g } = mini(BASE);
    fs.writeFileSync(path.join(root, 'a b.gs'), 'function c() {}\n');
    const r = compare(root);
    assert.equal(r.changes, '?? a b.gs');
    assert.match(r.patch, /^diff --git a\/a b\.gs b\/a b\.gs$/m);
    assert.match(r.patch, /^\+function c\(\) \{\}$/m);
    assert.equal(g('diff', '--cached', '--name-only', '-z'), '', 'intent-to-add został cofnięty');
    assert.equal(g('status', '--porcelain', '-z'), '?? a b.gs\0', 'plik wraca do stanu nieśledzonego');
  });

  test('nieśledzony plik z wiodącym NBSP w nazwie jest driftem: raport i patch go zawierają (domyślne cytowanie ścieżek w gicie)', () => {
    const { root } = mini(BASE);
    fs.writeFileSync(path.join(root, `${NBSP}Nb.gs`), 'function d() {}\n');
    const r = compare(root);
    assert.equal(r.changes, `?? ${NBSP}Nb.gs`);
    assert.match(r.patch, /^\+function d\(\) \{\}$/m);
  });

  test('nieśledzony plik z nazwą spoza ASCII jest driftem pod pełną nazwą (bez cytowania ósemkowego)', () => {
    const { root } = mini(BASE);
    fs.writeFileSync(path.join(root, 'zażółć.gs'), 'function e() {}\n');
    const r = compare(root);
    assert.equal(r.changes, '?? zażółć.gs');
    assert.match(r.patch, /^\+function e\(\) \{\}$/m);
  });

  test('nieśledzone pliki z nazwami ze spacją obok zmiany w śledzonym pliku: wszystkie w jednym raporcie, wiersze rozdzielone nową linią', () => {
    const { root } = mini(BASE);
    fs.writeFileSync(path.join(root, 'GA4.gs'), 'function b() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'a b.gs'), 'A\n');
    fs.writeFileSync(path.join(root, 'c d e.gs'), 'B\n');
    const r = compare(root);
    assert.equal(r.changes, ' M GA4.gs\n?? a b.gs\n?? c d e.gs');
    assert.match(r.patch, /^\+A$/m);
    assert.match(r.patch, /^\+B$/m);
  });

  test('przemianowanie zatwierdzone w indeksie (git mv) nie jest driftem: wpis o poprzedniej nazwie nie jest czytany jako osobna zmiana', () => {
    const { root, g } = mini(BASE);
    g('mv', 'Kod.gs', 'Kod2.gs');
    assert.deepEqual(compare(root), { changes: '', patch: '' });
  });

  test('przemianowanie w katalogu roboczym z intent-to-add jest driftem zgłoszonym jako usunięcie i dodanie, bez wpisu o poprzedniej nazwie', () => {
    const { root, g } = mini(BASE);
    fs.renameSync(path.join(root, 'Kod.gs'), path.join(root, 'Kod2.gs'));
    g('add', '-N', '--', 'Kod2.gs');
    assert.equal(compare(root).changes, ' D Kod.gs\n A Kod2.gs');
  });

  test('drift tylko w śledzonym pliku przy zajętym indeksie: bez nieśledzonych plików nic nie sięga po blokadę indeksu', () => {
    const { root } = mini(BASE);
    fs.writeFileSync(path.join(root, 'GA4.gs'), 'function b() { return 1; }\n');
    fs.writeFileSync(path.join(root, '.git', 'index.lock'), '');
    const r = compare(root);
    assert.equal(r.changes, ' M GA4.gs');
    assert.match(r.patch, /\+function b\(\) \{ return 1; \}/);
  });

  // Mutanty ocalałe po zmianie z #317: 99:10 i 99:18 (pathspec w układzie z katalogu głównego), 136:7
  // (`.trim()` przy ls-files Version.gs) i 148:7 (wczesne wyjście bez driftu). Różnica jest obserwowalna
  // tylko przez argumenty wywołań gita (ślad trace2) albo przez atrapę wyniku gita.
  function gitCalls(root, fn) {
    const file = path.join(root, 'trace2.json');
    process.env.GIT_TRACE2_EVENT = file;
    try { fn(); } finally { delete process.env.GIT_TRACE2_EVENT; }
    const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const calls = [];
    for (const e of events) {
      if (e.event === 'start') calls.push({ argv: e.argv.slice(1), name: null });
      else if (e.event === 'cmd_name' && calls.length) calls[calls.length - 1].name = e.name;
    }
    fs.rmSync(file);
    return calls.filter(c => c.name);
  }

  test('układ w katalogu głównym: git dostaje pathspec `*.gs` i `appsscript.json`, bez przedrostka `./`', () => {
    const { root } = mini(BASE);
    const calls = gitCalls(root, () => compare(root));
    const withSpec = calls.filter(c => (c.name === 'ls-files' && c.argv.includes('-z')) || c.name === 'status');
    assert.equal(withSpec.length, 2, JSON.stringify(calls));
    for (const c of withSpec) assert.deepEqual(c.argv.slice(c.argv.indexOf('--') + 1), ['*.gs', 'appsscript.json'], c.argv.join(' '));
  });

  test('układ w katalogu głównym: komunikat błędu gita poza repozytorium niesie dokładne polecenie z pathspec', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-nogit-'));
    roots.push(plain);
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
    try {
      assert.throws(() => compare(plain), e => e.message.startsWith('Command failed: git ls-files -z -- *.gs appsscript.json\n'), 'polecenie w komunikacie');
    } finally { delete process.env.GIT_CEILING_DIRECTORIES; }
  });

  test('brak driftu: compare() nie uruchamia git diff (wczesne wyjście), a przy driftcie diff jest uruchamiany', () => {
    const { root } = mini(BASE);
    const clean = gitCalls(root, () => assert.deepEqual(compare(root), { changes: '', patch: '' }));
    assert.deepEqual(clean.filter(c => c.name === 'diff'), [], 'bez zmian żaden diff: ' + JSON.stringify(clean.map(c => c.name)));
    assert.ok(clean.some(c => c.name === 'status'), 'sonda działa: status widoczny w śladzie');
    fs.writeFileSync(path.join(root, 'GA4.gs'), 'function b() { return 1; }\n');
    const dirty = gitCalls(root, () => compare(root));
    assert.equal(dirty.filter(c => c.name === 'diff').length, 1, 'z driftem dokładnie jeden diff');
  });

  test('brak driftu przy samej zmianie w indeksie (wpis `M `): też bez git diff', () => {
    const { root, g } = mini(BASE);
    fs.writeFileSync(path.join(root, 'GA4.gs'), 'function b() { return 1; }\n');
    g('add', '--', 'GA4.gs');
    const calls = gitCalls(root, () => assert.deepEqual(compare(root), { changes: '', patch: '' }));
    assert.deepEqual(calls.filter(c => c.name === 'diff'), []);
  });

  test('białe znaki zamiast ścieżki z `git ls-files -- Version.gs` oznaczają „plik nieśledzony”: brak git checkout', () => {
    const { root } = mini(BASE);
    const cp = require('child_process');
    const real = cp.execFileSync;
    const seen = [];
    cp.execFileSync = function (cmd, args) {
      seen.push(args.join(' '));
      if (cmd === 'git' && args[0] === 'ls-files' && args[args.length - 1] === 'Version.gs') return '\n';
      return real.apply(this, arguments);
    };
    let patched;
    try { delete require.cache[SCRIPT]; patched = require(SCRIPT); }
    finally { cp.execFileSync = real; delete require.cache[SCRIPT]; }
    assert.deepEqual(patched.compare(root), { changes: '', patch: '' });
    assert.ok(seen.some(s => s === 'ls-files -- Version.gs'), 'atrapa została użyta: ' + seen.join(' | '));
    assert.ok(!seen.some(s => s.startsWith('checkout')), 'żadnego checkout: ' + seen.join(' | '));
  });

  // Uwaga z przeglądu „spróbuj to obejść”: nazwa pliku z globem w nazwie była wzorcem w `git add`/`reset`.
  test('nazwa śledzonego pliku bez końcowej nowej linii z globem (a[1].gs) nie wciąga do indeksu innego pliku (a1.gs)', () => {
    const { root } = mini({ ...BASE, 'a[1].gs': 'x', 'a1.gs': 'good\n' });
    fs.writeFileSync(path.join(root, 'a[1].gs'), 'x\n');
    fs.writeFileSync(path.join(root, 'a1.gs'), 'EVIL();\n');
    const r = compare(root);
    assert.equal(r.changes, ' M a1.gs');
    assert.match(r.patch, /^\+EVIL\(\);$/m);
  });

  test('polecenia add i reset dostają nazwy plików jako ścieżki dosłowne (--literal-pathspecs): normalizacja indeksu i intent-to-add', () => {
    const { root } = mini({ ...BASE, 'N.gs': 'x' });
    fs.writeFileSync(path.join(root, 'N.gs'), 'x\n');
    fs.writeFileSync(path.join(root, 'U.gs'), 'u\n');
    const calls = gitCalls(root, () => compare(root)).filter(c => c.name === 'add' || c.name === 'reset');
    assert.deepEqual(calls.map(c => c.name), ['add', 'add', 'reset'], JSON.stringify(calls));
    for (const c of calls) assert.equal(c.argv[0], '--literal-pathspecs', c.argv.join(' '));
  });
});
