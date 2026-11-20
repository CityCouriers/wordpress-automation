'use strict';

/**
 * #297: drift check porównuje żywy projekt z rewizją WDROŻONĄ (jawny rekord Deployments),
 * nie z `main`. Dane: prawdziwe repozytorium git, serwer udający API GitHub, pobranie
 * zastąpione zapisem plików. Scenariusze (a)-(m) ze specyfikacji w opisach testów.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const drift = require('../scripts/quality/apps-script-drift');
const { startFakeGithub } = require('./helpers/fake-github');
const { makeRepo, liveFiles, fakePull, REPO } = require('./helpers/drift-fixture');

const roots = [];
let fx;
let shas;
let fake;

before(async () => {
  fx = makeRepo(roots);
  shas = fx.shas;
  fake = await startFakeGithub();
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

async function run({ files, env = {}, refDir, calls = [] }) {
  const cwd = tmp('live-');
  const result = await drift.runDrift(
    { cwd, repoDir: fx.dir, refDir },
    { ...fake.env, GITHUB_REPOSITORY: REPO, ...env },
    fakePull(files || new Map(), calls)
  );
  return { ...result, cwd, calls };
}

describe('runDrift: scenariusze zielone', () => {
  test('(a) main wyprzedza wdrożony tag: zgodny projekt to brak alarmu, rewizja z rekordu', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const r = await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0') });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.equal(r.headline, '');
    assert.deepEqual(r.lines, [
      `✅ Apps Script zgodny z wdrożoną rewizją v1.1.0 (${shas.c2}), źródło: rekord Deployments #${fake.state.deployments[0].id} (apps-script-live).`,
      '', '```', 'Pulled files.', '```'
    ]);
    assert.equal(r.patch, '');
    assert.deepEqual(r.notices, []);
  });

  test('(b) wydanie opublikowane i wdrożone: zielone, bez informacji o wydaniu; inne najnowsze wydanie to tylko notice', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    fake.state.release = { tag_name: 'v1.1.0' };
    const same = await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0') });
    assert.equal(same.ok, true);
    assert.deepEqual(same.notices, []);
    fake.state.release = { tag_name: 'v1.2.0' };
    const newer = await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0') });
    assert.equal(newer.ok, true, 'wydanie nowsze niż wdrożone to informacja, nie awaria');
    assert.deepEqual(newer.notices, [`Najnowsze opublikowane wydanie "v1.2.0" jest inne niż wdrożony ref "v1.1.0" (${shas.c2}); to informacja, nie awaria.`]);
    fake.state.release = null;
    assert.deepEqual((await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0') })).notices, [], 'brak wydań to brak informacji');
  });

  test('(d) ręczny hotfix z main: SHA będący przodkiem main jest wdrożoną rewizją', async () => {
    fake.seed({ ref: shas.c3, tag: 'main' });
    fake.state.release = { tag_name: 'v1.1.0' };
    const r = await run({ files: liveFiles(fx.dir, shas.c3, 'main') });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.match(r.lines[0], new RegExp(`wdrożoną rewizją main \\(${shas.c3}\\)`));
    assert.equal(r.notices.length, 1, 'wydanie v1.1.0 różni się od wdrożonego main');
    // starszy commit main (c2) też jest przodkiem main
    fake.seed({ ref: shas.c2, tag: 'main' });
    assert.equal((await run({ files: liveFiles(fx.dir, shas.c2, 'main') })).ok, true);
  });

  test('(e) rollback do starszego taga, także z układem sprzed #105 (źródła w katalogu głównym)', async () => {
    fake.seed({ ref: shas.c1, tag: 'v1.0.0' });
    assert.equal((await run({ files: liveFiles(fx.dir, shas.c1, 'v1.0.0') })).ok, true);
    fake.seed({ ref: shas.c0, tag: 'v0.9.0' });
    const old = await run({ files: liveFiles(fx.dir, shas.c0, 'v0.9.0') });
    assert.equal(old.ok, true, old.lines.join('\n'));
  });

  test('brak końcowej nowej linii po jednej ze stron nie jest różnicą', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const files = liveFiles(fx.dir, shas.c2, 'v1.1.0');
    files.set('Kod.gs', files.get('Kod.gs').replace(/\n$/, ''));
    files.set('Version.gs', files.get('Version.gs').replace(/\n$/, ''));
    assert.equal((await run({ files })).ok, true);
  });

  test('pobranie trafia do katalogu --cwd, a drzewo rewizji nie wykonuje niczego z rewizji', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const calls = [];
    const r = await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0'), calls });
    assert.equal(calls.length, 1);
    assert.equal(calls[0], r.cwd);
  });
});

describe('runDrift: scenariusze czerwone', () => {
  test('(c)(i) najnowsze wdrożenie niezakończone albo nieudane: czerwone, bez cofania do starszego success i bez pobierania', async () => {
    for (const statuses of [['in_progress'], ['in_progress', 'failure'], ['in_progress', 'success', 'failure'], [], ['queued']]) {
      fake.state.deployments.length = 0;
      fake.seed({ ref: shas.c1, tag: 'v1.0.0' }); // starsze, udane
      fake.seed({ ref: shas.c2, tag: 'v1.1.0', statuses });
      const calls = [];
      const r = await run({ files: liveFiles(fx.dir, shas.c1, 'v1.0.0'), calls });
      assert.equal(r.ok, false, JSON.stringify(statuses));
      assert.match(r.headline, /^OSTATNIE WDROŻENIE NIEZAKOŃCZONE: rekord Deployments #\d+ \(apps-script-live\) ma status /);
      assert.deepEqual(r.lines, [`❌ ${r.headline}`]);
      assert.equal(calls.length, 0, 'nie pobiera, gdy stan jest nieznany');
    }
  });

  test('(k) brak rekordów: "brak dowodu wdrożenia", nie domniemane wdrożenie', async () => {
    const calls = [];
    const r = await run({ files: new Map(), calls });
    assert.equal(r.ok, false);
    assert.match(r.headline, /^BRAK DOWODU WDROŻENIA/);
    assert.equal(calls.length, 0);
    assert.equal(fake.state.requests.length, 1, 'tylko odczyt rekordów, bez zapytań o wydanie');
  });

  test('rekordy innych środowisk (automatyczny production) nie są dowodem', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0', environment: 'production' });
    const r = await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0') });
    assert.equal(r.ok, false);
    assert.match(r.headline, /^BRAK DOWODU WDROŻENIA/);
  });

  test('(f) edycja żywego projektu poza repo: czerwone z plikiem i patchem; nowy, brakujący i zmieniony plik', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const files = liveFiles(fx.dir, shas.c2, 'v1.1.0');
    files.set('Kod.gs', 'function a() { return 99; }\n');
    files.set('Extra.gs', 'function extra() {}\n');
    files.delete('GA4.gs');
    const r = await run({ files });
    assert.equal(r.ok, false);
    assert.equal(r.headline, `Żywy projekt Apps Script różni się od wdrożonej rewizji v1.1.0 (${shas.c2}), źródło: rekord Deployments #${fake.state.deployments[0].id} (apps-script-live).`);
    assert.deepEqual(r.lines, [`❌ ${r.headline}`, '', '```', '?? Extra.gs\n D GA4.gs\n M Kod.gs', '```']);
    assert.match(r.patch, /-function a\(\) \{ return 1; \}/);
    assert.match(r.patch, /\+function a\(\) \{ return 99; \}/);
    assert.match(r.patch, /\+function extra\(\) \{\}/);
    assert.match(r.patch, /-function b\(\) \{\}/);
  });

  test('(g) edycja kodu z przepisaniem Version.gs na starszy SHA: czerwone, bo zapis jest z jawnego rekordu', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    // żywy projekt = kod c1 podpisany jako c1/v1.0.0
    const r = await run({ files: liveFiles(fx.dir, shas.c1, 'v1.0.0') });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), / M Kod\.gs/);
    assert.match(r.lines.join('\n'), / M Version\.gs/);
    assert.match(r.lines.join('\n'), /Version\.gs: tag "v1\.0\.0" różni się od rekordu wdrożenia "v1\.1\.0"\./);
    assert.match(r.lines.join('\n'), /Version\.gs: commit "[0-9a-f]{7}" nie jest początkiem SHA z rekordu wdrożenia\./);
    // sam stempel przepisany (kod bez zmian) też alarmuje
    const onlyStamp = liveFiles(fx.dir, shas.c2, 'v1.1.0');
    onlyStamp.set('Version.gs', liveFiles(fx.dir, shas.c1, 'v1.0.0').get('Version.gs'));
    const r2 = await run({ files: onlyStamp });
    assert.equal(r2.ok, false);
    assert.deepEqual(r2.lines.slice(2, 5), ['```', ' M Version.gs', '```']);
  });

  test('(h) kod wstrzyknięty obok poprawnego DEPLOYED_VERSION: czerwone, patch pokazuje dopisek', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const files = liveFiles(fx.dir, shas.c2, 'v1.1.0');
    files.set('Version.gs', files.get('Version.gs') + "function backdoor() { UrlFetchApp.fetch('x'); }\n");
    const r = await run({ files });
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /Version\.gs różni się od szablonu wdrożenia \(zmieniona struktura albo dopisany kod\)\./);
    assert.match(r.patch, /\+function backdoor/);
    assert.match(r.patch, /Version\.gs/);
  });

  test('brak Version.gs w żywym projekcie to czerwone', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const files = liveFiles(fx.dir, shas.c2, 'v1.1.0');
    files.delete('Version.gs');
    const r = await run({ files });
    assert.equal(r.ok, false);
    assert.deepEqual(r.lines.slice(2, 5), ['```', ' M Version.gs', '```']);
    assert.match(r.lines.join('\n'), /Brak Version\.gs w żywym projekcie\./);
  });

  test('(j) przesunięty tag, nieznany SHA, SHA spoza main, niepoprawne pola rekordu: czerwone bez pobierania', async () => {
    const cases = [
      [{ ref: shas.c3, tag: 'v1.1.0' }, /NIESPÓJNY TAG\/SHA: tag "v1\.1\.0" wskazuje "[0-9a-f]{40}", a rekord wdrożenia "[0-9a-f]{40}" \(przesunięty tag\)\./],
      [{ ref: shas.c2, tag: 'v7.7.7' }, /NIESPÓJNY TAG\/SHA: tag "v7\.7\.7" z rekordu nie istnieje w repozytorium\./],
      [{ ref: 'e'.repeat(40), tag: 'main' }, /NIESPÓJNY TAG\/SHA: SHA "e{40}" z rekordu nie istnieje w repozytorium\./],
      [{ ref: shas.side, tag: 'main' }, /NIESPÓJNY TAG\/SHA: SHA "[0-9a-f]{40}" z rekordu \(main\) nie jest przodkiem obecnego main\./],
      [{ ref: 'main', tag: 'main' }, /NIESPÓJNY TAG\/SHA: rekord Deployments/],
      [{ ref: shas.c2, tag: 'v1.1.0; rm -rf /' }, /NIESPÓJNY TAG\/SHA: rekord Deployments/],
      [{ ref: shas.c2, tag: '$(touch pwned)' }, /NIESPÓJNY TAG\/SHA: rekord Deployments/],
      [{ ref: shas.c2 }, /NIESPÓJNY TAG\/SHA: rekord Deployments/]
    ];
    for (const [rec, pattern] of cases) {
      fake.state.deployments.length = 0;
      fake.seed(rec);
      const calls = [];
      const r = await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0'), calls });
      assert.equal(r.ok, false, JSON.stringify(rec));
      assert.match(r.headline, pattern);
      assert.equal(calls.length, 0);
    }
    assert.ok(!fs.existsSync(path.join(fx.dir, 'pwned')));
  });

  test('rekord z ref niebędącym rozwiązanym sha (np. ręcznie utworzony na gałęzi) jest niespójny', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0', sha: shas.c3 });
    const r = await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0') });
    assert.equal(r.ok, false);
    assert.match(r.headline, /^NIESPÓJNY TAG\/SHA/);
  });

  test('błąd API przy odczycie rekordu to wyjątek, nie zielony wynik', async () => {
    const bad = await startFakeGithub({ failOn: { 'GET /deployments': 500 } });
    try {
      await assert.rejects(() => drift.runDrift({ cwd: tmp('live-'), repoDir: fx.dir }, { ...bad.env }, () => ''), /HTTP 500/);
    } finally { await bad.close(); }
  });

  test('(m) porównywana rewizja z podrzuconym skryptem instalacyjnym i kodem nie jest wykonywana', async () => {
    const marker = path.join(tmp('marker-'), 'wykonano.txt');
    const g = fx.g;
    g(['checkout', '-q', '-b', 'hostile', shas.c2]);
    fx.write('package.json', JSON.stringify({ name: 'x', scripts: { preinstall: `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${JSON.stringify(marker)}`, postinstall: 'echo pwned' } }));
    fx.write('scripts/quality/apps-script-compare.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
    fx.write('src/Kod.gs', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`);
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'hostile']);
    const hostile = g(['rev-parse', 'HEAD']);
    g(['tag', 'v6.6.6']);
    g(['checkout', '-q', 'main']);
    fake.seed({ ref: hostile, tag: 'v6.6.6' });
    const files = liveFiles(fx.dir, hostile, 'v6.6.6');
    const r = await run({ files });
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.ok(!fs.existsSync(marker), 'nic z porównywanej rewizji nie zostało uruchomione');
  });
});

describe('runDrift: compare_ref to tryb diagnostyczny', () => {
  test('(l) porównuje z podaną rewizją jako danymi, oznacza wynik i nie dotyka API', async () => {
    const files = liveFiles(fx.dir, shas.c3, 'main');
    const ok = await run({ files, env: { COMPARE_REF: 'main' } });
    assert.equal(ok.ok, true, ok.lines.join('\n'));
    assert.equal(ok.lines[0], `✅ DIAGNOSTYCZNY, nie zastępuje kontroli regularnej: Apps Script zgodny z wdrożoną rewizją main (${shas.c3}), źródło: compare_ref (tryb diagnostyczny).`);
    assert.equal(fake.state.requests.length, 0, 'tryb diagnostyczny nie czyta rekordów ani wydań');
    assert.deepEqual(ok.notices, []);
    const tag = await run({ files: liveFiles(fx.dir, shas.c1, 'v1.0.0'), env: { COMPARE_REF: 'v1.0.0' } });
    assert.equal(tag.ok, true, tag.lines.join('\n'));
    const bySha = await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0'), env: { COMPARE_REF: shas.c2 } });
    assert.equal(bySha.ok, true, bySha.lines.join('\n'));
  });

  test('różnica w trybie diagnostycznym jest czerwona i oznaczona; Version.gs sprawdzany tylko wzorcami', async () => {
    const stale = await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0'), env: { COMPARE_REF: 'main' } });
    assert.equal(stale.ok, false);
    assert.equal(stale.headline, `DIAGNOSTYCZNY, nie zastępuje kontroli regularnej: Żywy projekt Apps Script różni się od wdrożonej rewizji main (${shas.c3}), źródło: compare_ref (tryb diagnostyczny).`);
    assert.deepEqual(stale.lines.slice(2, 5), ['```', ' M Kod.gs', '```']);
    const files = liveFiles(fx.dir, shas.c3, 'main');
    files.set('Version.gs', files.get('Version.gs') + 'x();\n');
    const injected = await run({ files, env: { COMPARE_REF: 'main' } });
    assert.equal(injected.ok, false, 'szablon Version.gs obowiązuje także w trybie diagnostycznym');
  });

  test('niepoprawny compare_ref (wstrzyknięcie, gałąź, nieistniejący) odrzucony bez pobierania i bez wykonania', async () => {
    for (const ref of ['main; touch pwned', '$(touch pwned)', 'feature/x', '--output=x', 'v9.9.9', 'f'.repeat(40), 'MAIN', 'main\nmain']) {
      const calls = [];
      const r = await run({ files: new Map(), env: { COMPARE_REF: ref }, calls });
      assert.equal(r.ok, false, ref);
      assert.match(r.headline, /^compare_ref /);
      assert.equal(calls.length, 0);
    }
    assert.match((await run({ files: new Map(), env: { COMPARE_REF: 'feature/x' } })).headline, /^compare_ref musi być "main", tagiem v\* albo pełnym SHA: "feature\/x"\.$/);
    assert.match((await run({ files: new Map(), env: { COMPARE_REF: 'v9.9.9' } })).headline, /^compare_ref "v9\.9\.9" nie istnieje w repozytorium\.$/);
    assert.ok(!fs.existsSync(path.join(fx.dir, 'pwned')));
  });

  test('bieg zaplanowany (bez COMPARE_REF) czyta rekord, puste COMPARE_REF też', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const r = await run({ files: liveFiles(fx.dir, shas.c2, 'v1.1.0'), env: { COMPARE_REF: '' } });
    assert.equal(r.ok, true);
    assert.match(r.lines[0], /^✅ Apps Script zgodny z wdrożoną rewizją v1\.1\.0/);
  });
});

describe('katalog pobrania i katalog roboczy', () => {
  test('katalog pobrania ze źródłami jest odrzucany przed pobraniem; brakujący jest tworzony', () => {
    const d = tmp('live-');
    fs.writeFileSync(path.join(d, 'Kod.gs'), 'x');
    fs.writeFileSync(path.join(d, 'appsscript.json'), '{}');
    assert.throws(() => drift.assertEmptyLiveDir(d), /Katalog pobrania .* zawiera już pliki źródłowe \(Kod\.gs, appsscript\.json\)/);
    const clean = tmp('live-');
    fs.writeFileSync(path.join(clean, '.clasp.json'), '{}');
    fs.writeFileSync(path.join(clean, 'notatki.txt'), 'x');
    assert.doesNotThrow(() => drift.assertEmptyLiveDir(clean));
    const missing = path.join(tmp('live-'), 'nowy');
    drift.assertEmptyLiveDir(missing);
    assert.ok(fs.statSync(missing).isDirectory());
  });

  test('--ref-dir: drzewa ref i live do patcha trafiają do wskazanego katalogu, stare pliki są czyszczone', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const refDir = tmp('ref-');
    fs.mkdirSync(path.join(refDir, 'ref'));
    fs.writeFileSync(path.join(refDir, 'ref', 'Stary.gs'), 'x');
    const files = liveFiles(fx.dir, shas.c2, 'v1.1.0');
    files.set('Kod.gs', 'function a() { return 5; }');
    const r = await run({ files, refDir });
    assert.equal(r.ok, false);
    assert.deepEqual(fs.readdirSync(path.join(refDir, 'ref')).sort(), ['GA4.gs', 'Kod.gs', 'appsscript.json']);
    assert.deepEqual(fs.readdirSync(path.join(refDir, 'live')).sort(), ['GA4.gs', 'Kod.gs', 'appsscript.json']);
    assert.equal(fs.readFileSync(path.join(refDir, 'live', 'Kod.gs'), 'utf8'), 'function a() { return 5; }\n', 'strona live z końcową nową linią');
    assert.match(r.patch, /^diff --git a\/ref\/Kod\.gs b\/live\/Kod\.gs/m);
  });
});

describe('readTree', () => {
  test('czyta źródła z src/ albo z katalogu głównego, pomija Version.gs i pliki niebędące źródłami', () => {
    const src = drift.readTree(fx.dir, shas.c2);
    assert.equal(src.dir, 'src');
    assert.deepEqual([...src.files.keys()].sort(), ['GA4.gs', 'Kod.gs', 'appsscript.json']);
    assert.equal(src.files.get('Kod.gs'), 'function a() { return 1; }\n');
    const root = drift.readTree(fx.dir, shas.c0);
    assert.equal(root.dir, '.');
    assert.deepEqual([...root.files.keys()].sort(), ['GA4.gs', 'Kod.gs', 'appsscript.json']);
    const withSide = drift.readTree(fx.dir, shas.side);
    assert.ok(withSide.files.has('Side.gs'));
    assert.ok(!withSide.files.has('package.json'));
  });

  test('układ src bez appsscript.json w katalogu src/ nie jest uznany za układ src', () => {
    const g = fx.g;
    g(['checkout', '-q', '-b', 'odd', shas.c0]);
    fx.write('src/readme.txt', 'x');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'odd']);
    const odd = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    assert.equal(drift.readTree(fx.dir, odd).dir, '.');
  });
});

describe('versionProblems: kanoniczny Version.gs', () => {
  const stamp = { tag: 'v1.1.0', deployedAt: '2026-11-17T08:00:00Z', deployedBy: 'octocat' };
  const sha = 'a1b2c3d4'.repeat(5);
  const ok = (over = {}) => drift.renderVersionFile({ ...stamp, commit: sha.slice(0, 7), ...over }, REPO);
  const expected = { tag: 'v1.1.0', sha };

  test('zgodny plik: brak problemów; w trybie diagnostycznym (expected null) wystarcza szablon i wzorce', () => {
    assert.deepEqual(drift.versionProblems(ok(), REPO, expected), []);
    assert.deepEqual(drift.versionProblems(ok({ tag: 'main', commit: sha }), REPO, { tag: 'main', sha }), [], 'pełny SHA jako commit też jest początkiem SHA');
    assert.deepEqual(drift.versionProblems(ok({ tag: 'v9.9.9', commit: 'deadbee' }), REPO, null), []);
    assert.deepEqual(drift.versionProblems(ok().replace(/\n$/, ''), REPO, expected), [], 'brak końcowej nowej linii');
    assert.deepEqual(drift.versionProblems(ok({ deployedBy: 'dependabot[bot]' }), REPO, expected), []);
    assert.deepEqual(drift.versionProblems(ok({ deployedBy: 'a' }), REPO, expected), []);
  });

  test('brak pliku (null) to osobny problem', () => {
    assert.deepEqual(drift.versionProblems(null, REPO, expected), ['Brak Version.gs w żywym projekcie.']);
  });

  test('struktura inna niż szablon: dopisek, inna kolejność pól, inny nagłówek, inne repozytorium, CRLF, pusty plik', () => {
    const base = ok();
    const variants = [
      base + 'x();\n',
      'x();\n' + base,
      base.replace('tag:', 'tagg:'),
      base.replace('Wygenerowane', 'Zmienione'),
      drift.renderVersionFile({ ...stamp, commit: sha.slice(0, 7) }, 'inny/repo'),
      base.replace(/\n/g, '\r\n'),
      base.replace('const DEPLOYED_VERSION', 'var DEPLOYED_VERSION'),
      base.replace('  tag: "v1.1.0",\n  commit', '  commit'),
      base.replace('};\n', '}\n'),
      '',
      "const DEPLOYED_VERSION = { tag: 'dev' };\n",
      base.replace('"v1.1.0"', '"v1.1.0" + evil()'),
      base.replace('"v1.1.0"', '"v\\x1"'),
      base.replace('"v1.1.0"', '"v1\n.1.0"')
    ];
    for (const v of variants) {
      assert.deepEqual(drift.versionProblems(v, REPO, expected), ['Version.gs różni się od szablonu wdrożenia (zmieniona struktura albo dopisany kod).'], JSON.stringify(v).slice(0, 120));
    }
  });

  test('każde pole ma własny wzorzec', () => {
    const cases = [
      [{ tag: 'feature' }, /^Version\.gs: pole tag "feature" niezgodne ze wzorcem\.$/],
      [{ commit: 'abc' }, /^Version\.gs: pole commit "abc" niezgodne ze wzorcem\.$/],
      [{ commit: 'ABCDEFG' }, /pole commit/],
      [{ commit: 'a'.repeat(41) }, /pole commit/],
      [{ deployedAt: '2026-11-17 08:00:00' }, /^Version\.gs: pole deployedAt "2026-11-17 08:00:00" niezgodne ze wzorcem\.$/],
      [{ deployedAt: '2026-11-17T08:00:00Z\n' }, /pole deployedAt/],
      [{ deployedBy: '' }, /pole deployedBy/],
      [{ deployedBy: '-x' }, /pole deployedBy/],
      [{ deployedBy: 'a b' }, /pole deployedBy/],
      [{ deployedBy: 'a'.repeat(40) }, /pole deployedBy/],
      [{ deployedBy: 'x[bot]y' }, /pole deployedBy/]
    ];
    for (const [over, pattern] of cases) {
      const problems = drift.versionProblems(ok(over), REPO, expected);
      assert.equal(problems.length, 1, JSON.stringify(over));
      assert.match(problems[0], pattern);
    }
    const many = drift.versionProblems(ok({ tag: 'x', commit: 'y', deployedAt: 'z', deployedBy: '' }), REPO, expected);
    assert.equal(many.length, 4, 'każde pole zgłaszane osobno');
  });

  test('zgodność z jawnym rekordem: tag i początek SHA; niekanoniczny zapis znaków', () => {
    assert.deepEqual(drift.versionProblems(ok({ tag: 'main' }), REPO, expected), ['Version.gs: tag "main" różni się od rekordu wdrożenia "v1.1.0".']);
    assert.deepEqual(drift.versionProblems(ok({ commit: 'deadbee' }), REPO, expected), ['Version.gs: commit "deadbee" nie jest początkiem SHA z rekordu wdrożenia.']);
    assert.equal(drift.versionProblems(ok({ tag: 'main', commit: 'deadbee' }), REPO, expected).length, 2);
    const escaped = ok().replace('"v1.1.0"', '"v1\\u002e1.0"');
    assert.deepEqual(drift.versionProblems(escaped, REPO, expected), ['Version.gs: zapis różni się od kanonicznego (inne ucieczki znaków).']);
    assert.deepEqual(drift.versionProblems(escaped, REPO, null), ['Version.gs: zapis różni się od kanonicznego (inne ucieczki znaków).']);
  });

  test('parseVersionFile: odczyt czterech pól albo null; renderVersionFile to ten sam tekst co krok deployu', () => {
    assert.deepEqual(drift.parseVersionFile(ok(), REPO), { tag: 'v1.1.0', commit: sha.slice(0, 7), deployedAt: '2026-11-17T08:00:00Z', deployedBy: 'octocat' });
    assert.equal(drift.parseVersionFile(ok() + 'x', REPO), null);
    assert.equal(drift.parseVersionFile(ok().slice(1), REPO), null);
    assert.equal(drift.renderVersionFile({ tag: 'a"b\\c', commit: 'c', deployedAt: 'd', deployedBy: 'e' }, 'o/r'),
      '/**\n * Wygenerowane przez workflow "Deploy to Apps Script". Nie edytuj ręcznie.\n * Źródło: https://github.com/o/r/releases\n */\nconst DEPLOYED_VERSION = {\n  tag: "a\\"b\\\\c",\n  commit: "c",\n  deployedAt: "d",\n  deployedBy: "e"\n};\n');
  });
});

describe('odczyt żywego projektu i katalog roboczy (zabijanie mutantów)', () => {
  const okFiles = () => liveFiles(fx.dir, shas.c2, 'v1.1.0');

  test('żywy odczyt pomija pliki niebędące źródłami oraz katalogi o nazwie źródła', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const cwd = tmp('live-');
    const refDir = tmp('ref-');
    const pull = dir => {
      for (const [n, t] of okFiles()) fs.writeFileSync(path.join(dir, n), t);
      fs.writeFileSync(path.join(dir, '.clasp.json'), '{}');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'Kod.gs.bak'), 'x');
      fs.mkdirSync(path.join(dir, 'Dir.gs'));
      return 'ok';
    };
    const r = await drift.runDrift({ cwd, repoDir: fx.dir, refDir }, { ...fake.env, GITHUB_REPOSITORY: REPO }, pull);
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.equal(r.patch, '');
    assert.deepEqual(fs.readdirSync(path.join(refDir, 'live')).sort(), ['GA4.gs', 'Kod.gs', 'appsscript.json']);
  });

  test('--ref-dir wskazujący nieistniejący, zagnieżdżony katalog jest tworzony', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const refDir = path.join(tmp('ref-'), 'a', 'b');
    const r = await run({ files: okFiles(), refDir });
    assert.equal(r.ok, true);
    assert.deepEqual(fs.readdirSync(path.join(refDir, 'ref')).sort(), ['GA4.gs', 'Kod.gs', 'appsscript.json']);
  });

  test('patch przy problemie z Version.gs: strona rewizji ma wzorzec z rekordu (tag, początek SHA, puste pola)', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const files = okFiles();
    files.set('Version.gs', drift.renderVersionFile({ tag: 'main', commit: shas.c2.slice(0, 7), deployedAt: '2026-11-17T08:00:00Z', deployedBy: 'octocat' }, REPO));
    const r = await run({ files });
    assert.equal(r.ok, false);
    assert.match(r.patch, /^diff --git a\/ref\/Version\.gs b\/live\/Version\.gs/m);
    const lines = r.patch.split('\n');
    for (const l of ['-  tag: "v1.1.0",', '+  tag: "main",', '-  deployedAt: "",', '+  deployedAt: "2026-11-17T08:00:00Z",', '-  deployedBy: ""', '+  deployedBy: "octocat"', `   commit: "${shas.c2.slice(0, 7)}",`]) {
      assert.ok(lines.includes(l), l + '\n' + r.patch);
    }
  });

  test('patch w trybie diagnostycznym: wzorzec bez rekordu ma tag main i SHA zerowy', async () => {
    const files = okFiles();
    files.set('Version.gs', files.get('Version.gs') + 'x();\n');
    const r = await run({ files, env: { COMPARE_REF: 'v1.1.0' } });
    assert.equal(r.ok, false);
    const lines = r.patch.split('\n');
    for (const l of ['-  tag: "main",', '-  commit: "0000000",', '-  deployedAt: "",', '-  deployedBy: ""']) {
      assert.ok(lines.includes(l), l + '\n' + r.patch);
    }
  });

  test('brak Version.gs w żywym projekcie: zmiana na liście, bez Version.gs w patchu', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const files = okFiles();
    files.delete('Version.gs');
    const r = await run({ files });
    assert.equal(r.ok, false);
    assert.ok(r.lines.includes('Brak Version.gs w żywym projekcie.'), r.lines.join('\n'));
    assert.ok(r.lines.join('\n').includes(' M Version.gs'));
    assert.ok(!r.patch.includes('Version.gs'), 'nie ma żywego pliku, więc nie ma czego porównać');
  });

  test('ciche pobranie (pusty wynik) nie dodaje bloku z wynikiem pobrania', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const cwd = tmp('live-');
    const pull = dir => { for (const [n, t] of okFiles()) fs.writeFileSync(path.join(dir, n), t); return ''; };
    const r = await drift.runDrift({ cwd, repoDir: fx.dir }, { ...fake.env, GITHUB_REPOSITORY: REPO }, pull);
    assert.equal(r.ok, true);
    assert.equal(r.lines.length, 1);
  });

  test('katalog pobrania z plikiem źródłowym: runDrift odrzuca przed pobraniem', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const cwd = tmp('live-');
    fs.writeFileSync(path.join(cwd, 'Kod.gs'), 'stary');
    const calls = [];
    await assert.rejects(
      () => drift.runDrift({ cwd, repoDir: fx.dir }, { ...fake.env, GITHUB_REPOSITORY: REPO }, fakePull(okFiles(), calls)),
      /Katalog pobrania .* zawiera już pliki źródłowe \(Kod\.gs\)/
    );
    assert.equal(calls.length, 0);
  });

  test('własny katalog roboczy powstaje w katalogu tymczasowym z prefiksem i jest sprzątany (wynik zielony, czerwony i błąd)', async () => {
    const original = fs.mkdtempSync;
    const created = [];
    fs.mkdtempSync = (prefix, ...rest) => {
      const dir = original(prefix, ...rest);
      if (path.basename(prefix).startsWith('apps-script-drift')) created.push({ prefix, dir });
      return dir;
    };
    try {
      fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
      const green = await drift.runDrift({ cwd: tmp('live-'), repoDir: fx.dir }, { ...fake.env, GITHUB_REPOSITORY: REPO }, fakePull(okFiles(), []));
      assert.equal(green.ok, true);
      const changed = okFiles();
      changed.set('Kod.gs', 'function a() { return 9; }\n');
      const red = await drift.runDrift({ cwd: tmp('live-'), repoDir: fx.dir }, { ...fake.env, GITHUB_REPOSITORY: REPO }, fakePull(changed, []));
      assert.equal(red.ok, false);
      await assert.rejects(() => drift.runDrift({ cwd: tmp('live-'), repoDir: fx.dir }, { ...fake.env, GITHUB_REPOSITORY: REPO }, dir => { fs.rmSync(dir, { recursive: true }); return ''; }));
    } finally {
      fs.mkdtempSync = original;
    }
    assert.equal(created.length, 3);
    for (const c of created) {
      assert.equal(c.prefix, path.join(os.tmpdir(), 'apps-script-drift-'), 'katalog roboczy w katalogu tymczasowym systemu, nie w jego rodzicu');
      assert.equal(fs.existsSync(c.dir), false, `katalog ${c.dir} powinien zostać usunięty`);
    }
  });

  test('podany --ref-dir nie jest usuwany po przebiegu', async () => {
    fake.seed({ ref: shas.c2, tag: 'v1.1.0' });
    const refDir = tmp('ref-');
    await run({ files: okFiles(), refDir });
    assert.equal(fs.existsSync(path.join(refDir, 'ref')), true);
  });
});

describe('kotwice wzorców', () => {
  test('compare_ref: tylko main, tag v<cyfra>... albo pełny SHA, bez przedrostków i przyrostków', () => {
    const bad = ['xmain', 'maint', 'main\n', 'notmain', 'xv1.0.0', '1v1.0.0', 'v', 'vx', 'v1.0.0\n', `x${shas.c2}`, `${shas.c2}x`, shas.c2.slice(0, 39), shas.c2.slice(0, 7), shas.c2.toUpperCase(), '', 'v1 0'];
    for (const ref of bad) {
      const t = drift.resolveDiagnosticTarget(fx.dir, ref);
      assert.equal(t.ok, false, JSON.stringify(ref));
      assert.match(t.message, /^compare_ref musi być "main", tagiem v\* albo pełnym SHA: /, JSON.stringify(ref));
    }
    assert.equal(drift.resolveDiagnosticTarget(fx.dir, 'v1.1.0').sha, shas.c2);
    assert.equal(drift.resolveDiagnosticTarget(fx.dir, shas.c2).sha, shas.c2);
    assert.equal(drift.resolveDiagnosticTarget(fx.dir, 'main').sha, shas.c3);
    assert.match(drift.resolveDiagnosticTarget(fx.dir, 'v9.9.9').message, /nie istnieje w repozytorium/);
    assert.match(drift.resolveDiagnosticTarget(fx.dir, 'f'.repeat(40)).message, /nie istnieje w repozytorium/);
    assert.equal(drift.resolveDiagnosticTarget(fx.dir, 'v1.1.0').tag, 'v1.1.0');
    assert.equal(drift.resolveDiagnosticTarget(fx.dir, 'v1.1.0').source, 'compare_ref (tryb diagnostyczny)');
    assert.equal(drift.resolveDiagnosticTarget(fx.dir, 'v1.1.0').stamp, null);
    assert.equal(drift.resolveDiagnosticTarget(fx.dir, 'v1.1.0').diagnostic, true);
  });

  test('pola stempla Version.gs: kotwice daty, commita i autora', () => {
    const sha = 'a1b2c3d4'.repeat(5);
    const stamp = { tag: 'v1.1.0', commit: sha.slice(0, 7), deployedAt: '2026-11-17T08:00:00Z', deployedBy: 'octocat' };
    const make = over => drift.renderVersionFile({ ...stamp, ...over }, REPO);
    const bad = [
      { deployedAt: 'x2026-11-17T08:00:00Z' },
      { deployedAt: '2026-11-17T08:00:00Zx' },
      { deployedAt: '26-11-17T08:00:00Z' },
      { deployedAt: '2026-1-17T08:00:00Z' },
      { deployedAt: '2026-11-1T08:00:00Z' },
      { deployedAt: '2026-11-17T8:00:00Z' },
      { deployedAt: '2026-11-17T08:0:00Z' },
      { deployedAt: '2026-11-17T08:00:0Z' },
      { deployedAt: '2026-11-17T08:00:00' },
      { commit: 'xabcdef0' },
      { commit: 'abcdef0x' },
      { commit: 'abcdef' },
      { deployedBy: 'xx yy' },
      { deployedBy: 'octocat\n' },
      { deployedBy: 'octocat[bot]x' },
      { deployedBy: '[bot]' }
    ];
    for (const over of bad) {
      const p = drift.versionProblems(make(over), REPO, { tag: 'v1.1.0', sha });
      assert.equal(p.length, 1, JSON.stringify(over));
      assert.match(p[0], /niezgodne ze wzorcem/, JSON.stringify(over));
    }
    assert.deepEqual(drift.versionProblems(make({ commit: sha.slice(0, 7) }), REPO, { tag: 'v1.1.0', sha }), []);
    assert.deepEqual(drift.versionProblems(make({ commit: sha }), REPO, { tag: 'v1.1.0', sha }), []);
    assert.deepEqual(drift.versionProblems(make({ deployedBy: 'a'.repeat(39) }), REPO, { tag: 'v1.1.0', sha }), []);
    assert.deepEqual(drift.versionProblems(make({ deployedBy: 'a-b[bot]' }), REPO, { tag: 'v1.1.0', sha }), []);
  });
});

describe('drzewo rewizji: wpisy niebędące plikami źródłowymi', () => {
  function commitOn(repo, base, branch, files, dirs) {
    const { g, write } = repo;
    g(['checkout', '-q', '-b', branch, base]);
    for (const [rel, text] of files) write(rel, text);
    for (const rel of dirs) write(`${rel}/inner.txt`, 'x');
    g(['add', '-A']);
    g(['commit', '-q', '-m', branch]);
    const sha = g(['rev-parse', 'HEAD']);
    g(['checkout', '-q', 'main']);
    return sha;
  }

  test('układ w katalogu głównym: pomija pliki o innych nazwach i katalogi o nazwie źródła', () => {
    const sha = commitOn(fx, shas.c0, 'root-extra', [['notes.txt', 'x'], ['Kod.gs.bak', 'x']], ['Dir.gs']);
    const tree = drift.readTree(fx.dir, sha);
    assert.equal(tree.dir, '.');
    assert.deepEqual([...tree.files.keys()].sort(), ['GA4.gs', 'Kod.gs', 'appsscript.json']);
  });

  test('układ src: pomija pliki o innych nazwach i katalogi o nazwie źródła', () => {
    const sha = commitOn(fx, shas.c1, 'src-extra', [['src/notes.txt', 'x'], ['src/Kod.gs.bak', 'x']], ['src/Dir.gs']);
    const tree = drift.readTree(fx.dir, sha);
    assert.equal(tree.dir, 'src');
    assert.deepEqual([...tree.files.keys()].sort(), ['GA4.gs', 'Kod.gs', 'appsscript.json']);
  });
});

describe('compare_ref: tylko prawdziwy tag albo gałąź main, bez zasłaniania nazwą', () => {
  const roots2 = [];
  let repo2;
  before(() => {
    // Klon (jedno wywołanie gita) zamiast budowy drugiego repozytorium: git jest tu wolny, a testy mają mieścić się w limitach.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dfx-clone-'));
    roots2.push(dir);
    const { execFileSync } = require('child_process');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', fx.dir, dir]);
    const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    g(['tag', 'main', shas.c0]); // tag o nazwie main nie może zasłonić gałęzi main
    g(['branch', 'v8.0.0', shas.c2]); // gałąź o nazwie jak tag nie jest tagiem
    repo2 = { dir, shas };
  });
  after(() => { for (const r of roots2) fs.rmSync(r, { recursive: true, force: true }); });

  test('main to gałąź refs/heads/main, nawet gdy istnieje tag main', () => {
    const t = drift.resolveDiagnosticTarget(repo2.dir, 'main');
    assert.equal(t.ok, true);
    assert.equal(t.sha, repo2.shas.c3);
  });

  test('v* to tag: gałąź o takiej nazwie bez taga nie istnieje jako cel', () => {
    const t = drift.resolveDiagnosticTarget(repo2.dir, 'v8.0.0');
    assert.equal(t.ok, false);
    assert.match(t.message, /nie istnieje w repozytorium/);
    assert.equal(drift.resolveDiagnosticTarget(repo2.dir, 'v1.1.0').sha, repo2.shas.c2);
  });
});

describe('brak rekordu: wynik bez patcha', () => {
  test('raport czerwony z brakiem rekordu ma pusty patch i brak informacji', async () => {
    const r = await run({ files: new Map() });
    assert.equal(r.ok, false);
    assert.strictEqual(r.patch, '');
    assert.deepEqual(r.notices, []);
  });
});

describe('polecenia git: błędy z kodem i komunikatem', () => {
  test('nieistniejąca rewizja: wyjątek z kodem wyjścia i treścią błędu gita', () => {
    assert.throws(() => drift.readTree(fx.dir, 'f'.repeat(40)), e => {
      assert.match(e.message, /^git ls-tree zakończone kodem 128: .*(not a tree object|Not a valid object name)/i);
      assert.doesNotMatch(e.message, /\s$/, 'komunikat bez końcowego znaku nowej linii z stderr');
      return true;
    });
  });

  test('brak katalogu repozytorium: wyjątek z komunikatem systemowym zamiast kodu', () => {
    const missing = path.join(tmp('brak-'), 'nie-ma');
    assert.throws(() => drift.readTree(missing, shas.c2), e => {
      assert.match(e.message, /^git ls-tree zakończone kodem null: .*ENOENT/);
      return true;
    });
  });
});
