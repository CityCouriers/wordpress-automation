'use strict';

/**
 * #297: kształt workflow deployu i drift checku (kolejność kroków, uprawnienia, rozdział kodu
 * od danych przy `compare_ref`) oraz zgodność stempla Version.gs z kanonicznym oczekiwanym plikiem.
 * #296 (AC-3, AC-9 a): ścisły `deploy_ref` (krok walidacji uruchamiany w bash z fałszywym `gh`), ref
 * rozwiązany raz do SHA, guard ręcznego uruchomienia, niezmieniona lista kroków deployu.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stripGitEnv } = require('./helpers/git-env');
const { runNodeSync } = require('./helpers/node-child');

// Hook pre-commit w drzewie roboczym ustawia GIT_DIR; `git init` w katalogu tymczasowym pisałby wtedy do prawdziwego repozytorium.
stripGitEnv();
const drift = require('../scripts/quality/apps-script-drift');
const record = require('../scripts/quality/deployment-record');

const WORKFLOWS = path.resolve(__dirname, '..', '.github', 'workflows');
const deployText = fs.readFileSync(path.join(WORKFLOWS, 'deploy-apps-script.yml'), 'utf8').replace(/\r\n/g, '\n');
const driftText = fs.readFileSync(path.join(WORKFLOWS, 'apps-script-drift.yml'), 'utf8').replace(/\r\n/g, '\n');
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** Kroki joba: [{ name, text }] w kolejności z pliku (wcięcie listy kroków: 6 spacji). */
function steps(text) {
  const parts = text.split(/^ {6}- /m).slice(1);
  return parts.map(p => ({ name: (/^name: (.*)$/m.exec(p) || [])[1], text: p }));
}

/** Treść `run:` kroku (blok albo jedna linia); pusty tekst, gdy krok nie ma `run`. */
function runOf(step) {
  const lines = step.text.split('\n');
  const i = lines.findIndex(l => /^ {8}run:/.test(l));
  if (i < 0) return '';
  const out = [lines[i].replace(/^ {8}run: ?\|?/, '')];
  for (let j = i + 1; j < lines.length && (lines[j] === '' || /^ {10}/.test(lines[j])); j++) out.push(lines[j]);
  return out.join('\n');
}

const stepNamed = (list, prefix) => {
  const i = list.findIndex(s => s.name && s.name.startsWith(prefix));
  assert.ok(i >= 0, `brak kroku "${prefix}"`);
  return i;
};

describe('deploy-apps-script.yml: zapis jawnego rekordu wdrożenia', () => {
  const list = steps(deployText);

  test('uprawnienie deployments: write tylko dla joba, na górze pliku wyłącznie contents: read', () => {
    assert.match(deployText, /^permissions:\n {2}contents: read\n\n/m);
    assert.match(deployText, /^ {4}permissions:\n {6}contents: read\n {6}deployments: write # [^\n]+\n/m);
    assert.equal(deployText.split('\n').filter(l => /deployments: write/.test(l) && !/^\s*#/.test(l)).length, 1);
  });

  test('rekord powstaje po checkoucie wdrażanego refa, tuż przed clasp push, a wynik po weryfikacji', () => {
    const checkout = stepNamed(list, 'Checkout ${{ env.DEPLOY_REF }}');
    const record = stepNamed(list, 'Record deployment (in_progress)');
    const push = stepNamed(list, 'Push to Apps Script');
    const verify = stepNamed(list, 'Verify the live project matches');
    const result = stepNamed(list, 'Record deployment result');
    const cleanup = stepNamed(list, 'Remove credentials');
    assert.ok(checkout < record, 'po checkoucie');
    assert.equal(record + 1, push, 'bez kroków między zapisem rekordu a pushem');
    assert.ok(push < verify && verify < result && result < cleanup);
    assert.ok(stepNamed(list, 'Stamp deployed version') < record);
    assert.ok(stepNamed(list, 'Lint') < record, 'lint i testy przed zapisem rekordu: odrzucone wdrożenie nie zostawia rekordu');
  });

  test('krok startowy: id, token z GITHUB_TOKEN, narzędzie z checkoutu main, bez interpolacji w powłoce', () => {
    const s = list[stepNamed(list, 'Record deployment (in_progress)')];
    assert.match(s.text, /^ {8}id: deploy_record$/m);
    assert.match(s.text, /^ {10}GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/m);
    assert.match(s.text, /^ {8}run: node \.deploy-tooling\/scripts\/quality\/deployment-record\.js start$/m);
    assert.doesNotMatch(s.text, /^ {8}if:/m, 'zapis rekordu nie jest warunkowy: brak zapisu zatrzymuje wdrożenie przed pushem');
  });

  test('krok wyniku: always() tylko po udanym zapisie, success tylko po udanej weryfikacji, wartości przez env', () => {
    const s = list[stepNamed(list, 'Record deployment result')];
    assert.match(s.text, /^ {8}if: always\(\) && steps\.deploy_record\.outcome == 'success'$/m);
    assert.match(s.text, /^ {10}DEPLOY_RECORD_ID: \$\{\{ steps\.deploy_record\.outputs\.id \}\}$/m);
    assert.match(s.text, /^ {10}DEPLOY_RESULT: \$\{\{ steps\.verify\.outcome == 'success' && 'success' \|\| 'failure' \}\}$/m);
    assert.match(s.text, /^ {8}run: node \.deploy-tooling\/scripts\/quality\/deployment-record\.js finish --id "\$DEPLOY_RECORD_ID" --state "\$DEPLOY_RESULT"$/m);
    assert.match(list[stepNamed(list, 'Verify the live project matches')].text, /^ {8}id: verify$/m);
  });

  test('narzędzie zapisu rekordu pochodzi z main rozwiązanego raz do SHA (sparse checkout), jak narzędzie porównania', () => {
    const s = list[stepNamed(list, 'Checkout deploy tooling from main')];
    assert.match(s.text, /^ {10}ref: \$\{\{ steps\.ref\.outputs\.tooling_sha \}\}$/m);
    assert.match(s.text, /^ {12}scripts\/quality\/apps-script-compare\.js$/m);
    assert.match(s.text, /^ {12}scripts\/quality\/deployment-record\.js$/m);
  });

  test('sparse checkout narzędzi zawiera każdy moduł lokalny, który narzędzia wymagają (domknięcie require)', () => {
    const s = list[stepNamed(list, 'Checkout deploy tooling from main')];
    const sparse = new Set([...s.text.matchAll(/^ {12}(scripts\/quality\/[\w.-]+\.js)$/gm)].map(m => m[1]));
    const dir = path.resolve(__dirname, '..');
    // Krok deployu uruchamia dwa skrypty; ich lokalne `require('./x')` muszą być pobrane, inaczej MODULE_NOT_FOUND po clasp push.
    const todo = ['scripts/quality/apps-script-compare.js', 'scripts/quality/deployment-record.js'];
    const seen = new Set();
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(/require\('\.\/([\w.-]+)'\)/g)) todo.push(`scripts/quality/${m[1]}${m[1].endsWith('.js') ? '' : '.js'}`);
    }
    assert.ok(seen.has('scripts/quality/apps-script-drift.js'), 'domknięcie widzi moduł drift (kontrola samego testu)');
    for (const f of seen) assert.ok(sparse.has(f), `${f} jest wymagany przez narzędzia deployu, a nie ma go w sparse-checkout`);
  });

  test('odtworzenie: katalog z samymi plikami z listy sparse uruchamia compare bez MODULE_NOT_FOUND', () => {
    const s = list[stepNamed(list, 'Checkout deploy tooling from main')];
    const files = [...s.text.matchAll(/^ {12}(scripts\/quality\/[\w.-]+\.js)$/gm)].map(m => m[1]);
    const tooling = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-'));
    roots.push(tooling);
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(tooling, f)), { recursive: true });
      fs.copyFileSync(path.resolve(__dirname, '..', f), path.join(tooling, f));
    }
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-cwd-'));
    roots.push(empty);
    for (const script of ['apps-script-compare.js', 'deployment-record.js']) {
      const r = runNodeSync(path.join(tooling, 'scripts', 'quality', script), script === 'apps-script-compare.js' ? ['--cwd', empty] : ['finish'], { cwd: empty, env: { ...process.env, APPS_SCRIPT_PULL_CMD: 'node -e 0' } });
      assert.doesNotMatch(`${r.stderr}${r.stdout}`, /MODULE_NOT_FOUND|Cannot find module/, `${script} w katalogu z samą listą sparse`);
    }
  });

  test('żaden krok `run` nie interpoluje wyrażeń ${{ }} (wejścia tylko przez env)', () => {
    for (const s of list) assert.doesNotMatch(runOf(s), /\$\{\{/, `krok "${s.name}"`);
  });
});

describe('apps-script-drift.yml: kod z main, rewizja jako dane i źródło rewizji', () => {
  const list = steps(driftText);

  test('uprawnienia: contents: read i deployments: read, nic więcej', () => {
    assert.match(driftText, /^permissions:\n {2}contents: read\n {2}deployments: read # [^\n]+\n\n/m);
    assert.doesNotMatch(driftText, /: write/);
  });

  test('jedyny checkout to main (narzędzia, package-lock, historia), niezależnie od wejścia', () => {
    const checkouts = list.filter(s => /uses: actions\/checkout@/.test(s.text));
    assert.equal(checkouts.length, 1);
    assert.match(checkouts[0].text, /^ {10}ref: main$/m);
    assert.match(checkouts[0].text, /^ {10}fetch-depth: 0$/m);
    assert.match(checkouts[0].text, /^ {10}persist-credentials: false$/m);
    assert.equal(list.indexOf(checkouts[0]), 0, 'checkout jest pierwszym krokiem, przed npm ci');
    assert.ok(stepNamed(list, 'Install dependencies') > 0);
  });

  test('compare_ref trafia wyłącznie do env kroku porównania, tylko dla workflow_dispatch', () => {
    const uses = [...driftText.matchAll(/^.*inputs\.compare_ref.*$/gm)].map(m => m[0].trim());
    assert.deepEqual(uses, [
      "COMPARE_REF: ${{ github.event_name == 'workflow_dispatch' && inputs.compare_ref || '' }}"
    ]);
    const s = list[stepNamed(list, 'Pull live project and compare')];
    assert.match(s.text, /^ {10}COMPARE_REF: /m);
    assert.match(s.text, /^ {8}run: node scripts\/quality\/apps-script-compare\.js --drift --cwd live --repo-dir \. --patch apps-script-drift\.patch$/m);
  });

  test('żaden krok `run` nie interpoluje wyrażeń ${{ }}; żaden krok nie czyta rekordów production', () => {
    for (const s of list) assert.doesNotMatch(runOf(s), /\$\{\{/, `krok "${s.name}"`);
    assert.doesNotMatch(driftText, /environment=production|environment: production/);
  });

  test('pobranie idzie do czystego katalogu live/, a poświadczenia są usuwane na końcu zawsze', () => {
    const cfg = list[stepNamed(list, 'Configure clasp credentials')];
    assert.match(cfg.text, /mkdir -p live/);
    assert.match(cfg.text, /"rootDir":".","scriptExtensions":\["gs"\]\}\\n' "\$APPS_SCRIPT_ID" > live\/\.clasp\.json/);
    const last = list[list.length - 1];
    assert.equal(last.name, 'Remove credentials');
    assert.match(last.text, /^ {8}if: always\(\)$/m);
    assert.match(last.text, /live\/\.clasp\.json/);
  });

  test('opis wejścia nazywa tryb diagnostyczny, a domyślna wartość jest pusta (kontrola regularna)', () => {
    assert.match(driftText, /compare_ref:\n {8}description: "DIAGNOSTYCZNIE \(nie zastępuje kontroli regularnej\)/);
    assert.match(driftText, /type: string\n {8}default: ""/);
  });
});

describe('zgodność: stempel z kroku deployu mieści się w kanonicznym oczekiwanym Version.gs', () => {
  function stampScript() {
    const stampStep = steps(deployText).find(s => s.name && s.name.startsWith('Stamp deployed version'));
    const m = /node - <<'EOF'\n([\s\S]*?)\n {10}EOF\n/.exec(stampStep.text);
    assert.ok(m, 'heredoc z generatorem stempla');
    return m[1].replace(/^ {10}/gm, '');
  }

  function stampInRepo(deployRef, actor) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
    roots.push(dir);
    const g = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@example.pl']);
    g(['config', 'user.name', 't']);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'appsscript.json'), '{}\n');
    fs.writeFileSync(path.join(dir, 'src', 'Version.gs'), 'const DEPLOYED_VERSION = {};\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'x']);
    execFileSync(process.execPath, ['-e', stampScript()], {
      cwd: dir,
      env: { ...process.env, DEPLOY_REF: deployRef, GITHUB_ACTOR: actor, GITHUB_REPOSITORY: 'acme/repo' }
    });
    return { text: fs.readFileSync(path.join(dir, 'src', 'Version.gs'), 'utf8'), sha: g(['rev-parse', 'HEAD']) };
  }

  test('plik zapisany przez krok deployu przechodzi kanoniczne porównanie z rekordem (tag i commit)', () => {
    for (const [ref, actor] of [['v2.43.0', 'octocat'], ['main', 'dependabot[bot]'], ['v10.20.30', 'a-b-c']]) {
      const { text, sha } = stampInRepo(ref, actor);
      assert.deepEqual(drift.versionProblems(text, 'acme/repo', { tag: ref, sha }), [], text);
      assert.equal(text, drift.renderVersionFile(drift.parseVersionFile(text, 'acme/repo'), 'acme/repo'));
    }
  });

  test('stempel z innym tagiem niż rekord jest wykrywany', () => {
    const { text, sha } = stampInRepo('v2.43.0', 'octocat');
    assert.equal(drift.versionProblems(text, 'acme/repo', { tag: 'v2.42.4', sha }).length, 1);
    assert.equal(drift.versionProblems(text, 'acme/repo', { tag: 'v2.43.0', sha: 'f'.repeat(40) }).length, 1);
  });
});

describe('pomocnicy testu: steps, runOf, stepNamed (dokładne wyniki, pomiar Stryker #296)', () => {
  test('steps: podział tylko na początku linii z wcięciem 6, nazwa tylko z pierwszej linii kroku', () => {
    const text = 'jobs:\n  a:\n    steps:\n      - name: a\n        run: echo "      - b"\n      - uses: o/a@v1\n        with:\n          name: art\n';
    const list = steps(text);
    assert.deepEqual(list.map(s => s.name), ['a', undefined]);
    assert.equal(list[0].text, 'name: a\n        run: echo "      - b"\n');
  });

  test('runOf: blok, jedna linia, bez spacji po dwukropku, krok bez run, run w pierwszej linii', () => {
    const block = { text: 'name: a\n        env:\n          run: 1\n        run: |\n          echo 1\n\n          echo 2\n        shell: bash          x\n' };
    assert.equal(runOf(block), '\n          echo 1\n\n          echo 2');
    assert.equal(runOf({ text: 'name: a\n        run: echo x' }), 'echo x');
    assert.equal(runOf({ text: 'name: a\n        run:echo x' }), 'echo x');
    assert.equal(runOf({ text: '        run: a\n          b' }), 'a\n          b');
    assert.equal(runOf({ text: 'name: a\n        uses: o/a@v1' }), '');
  });

  test('stepNamed: indeks także 0, brak kroku to błąd z nazwą', () => {
    const list = [{ name: 'Pierwszy krok' }, { name: undefined }, { name: 'Drugi' }];
    assert.equal(stepNamed(list, 'Pierwszy'), 0);
    assert.equal(stepNamed(list, 'Drugi'), 2);
    assert.throws(() => stepNamed(list, 'Brak'), { message: 'brak kroku "Brak"' });
  });
});

/** Fałszywe `gh` dla kroku walidacji refa: zapisuje wywołania, zwraca SHA z env albo błąd jak API dla nieznanego refa. */
const FAKE_GH = `gh() {
  printf '%s\\n' "$*" >> "$GH_LOG"
  case "$2" in
    repos/acme/repo/commits/refs/heads/main) if [ -n "$FAKE_MAIN" ]; then printf '%s\\n' "$FAKE_MAIN"; else return 1; fi ;;
    repos/acme/repo/commits/refs/tags/v2.43.0) printf '%s\\n' "$FAKE_TAG" ;;
    *) echo 'gh: No commit found (HTTP 422)' >&2; return 1 ;;
  esac
}
`;

/**
 * Uruchamia skrypt kroku w bash z fałszywym gh; zwraca kod wyjścia, wyjście, zapis GITHUB_OUTPUT, wywołania gh
 * i ścieżkę katalogu roboczego, który usuwa przed powrotem (prefiks `ref-` w katalogu tymczasowym do kontroli wycieków).
 */
function runRefStep(bash, script, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-'));
  try {
    const out = path.join(dir, 'out').replace(/\\/g, '/');
    const log = path.join(dir, 'gh.log').replace(/\\/g, '/');
    fs.writeFileSync(out, '');
    fs.writeFileSync(log, '');
    const r = spawnSync(bash, ['-c', FAKE_GH + script], {
      encoding: 'utf8',
      // GITHUB_EVENT_NAME i GITHUB_REF nadpisane: w CI proces testów ma własne wartości zdarzenia pull_request.
      env: {
        ...process.env, GITHUB_OUTPUT: out, GH_LOG: log, GITHUB_REPOSITORY: 'acme/repo', GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main', FAKE_MAIN: 'a'.repeat(40), FAKE_TAG: 'b'.repeat(40), ...env
      }
    });
    return { dir, status: r.status, stdout: r.stdout, output: fs.readFileSync(out, 'utf8'), calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

describe('deploy-apps-script.yml: ścisły deploy_ref, ref rozwiązany raz do SHA, guard main (#296, AC-3, AC-9 a)', () => {
  const list = steps(deployText);
  const validate = list[stepNamed(list, 'Validate deploy ref')];
  const script = runOf(validate);
  const STRICT = '^(main|v[0-9]+\\.[0-9]+\\.[0-9]+)$';
  const RE_IN_YAML = (/^ {10}ref_re='([^']*)'$/m.exec(validate.text) || [])[1];
  // Bash z Git for Windows leży obok git; na Linuksie (CI) bash jest w PATH.
  const BASH = process.platform === 'win32'
    ? path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..', 'bin', 'bash.exe')
    : 'bash';
  const OK = ['main', 'v2.43.0', 'v0.0.0', 'v10.20.300'];
  const BAD = ['main2', 'xmain', 'v1/../x', 'v1 x', 'v1.2', 'v1.2.3.4', 'v1.2.3-rc.1', 'refs/heads/main', '', 'V1.2.3', 'v1.2.x',
    'v1.2.3;id', '$(id)', 'v1.2.3\nmain', 'main\n', "v1.2.3'", 'v1.2.3\n::warning::x'];

  test('wzorzec w powłoce jest dokładnie wzorcem ścisłym i TAG_PATTERN rekordu wdrożenia', () => {
    assert.equal(RE_IN_YAML, STRICT);
    assert.equal(record.TAG_PATTERN.source, STRICT);
    assert.equal(record.TAG_PATTERN.flags, '');
  });

  test('test na regexie: przyjmuje main i vX.Y.Z, odrzuca resztę', () => {
    const re = new RegExp(RE_IN_YAML);
    for (const v of OK) assert.ok(re.test(v), v);
    for (const v of BAD) assert.ok(!re.test(v), JSON.stringify(v));
  });

  test('krok w bash: niepoprawny ref odrzucony przed jakimkolwiek wywołaniem gh, jedna linia polecenia ::', () => {
    for (const v of BAD) {
      const r = runRefStep(BASH, script, { DEPLOY_REF: v });
      assert.equal(r.status, 1, JSON.stringify(v));
      assert.deepEqual(r.calls, [], JSON.stringify(v));
      assert.equal(r.output, '');
      assert.equal(r.stdout.split('\n').filter(l => l.startsWith('::')).length, 1, r.stdout);
      assert.match(r.stdout, /^::error::deploy_ref must be 'main' or a release tag vX\.Y\.Z, got /);
    }
  });

  test('krok w bash: main i tag rozwiązane raz do pełnych SHA, narzędzia z SHA main', () => {
    const m = runRefStep(BASH, script, { DEPLOY_REF: 'main' });
    assert.equal(m.status, 0, m.stdout);
    assert.equal(m.output, `deploy_sha=${'a'.repeat(40)}\ntooling_sha=${'a'.repeat(40)}\n`);
    assert.deepEqual(m.calls, ['api repos/acme/repo/commits/refs/heads/main --jq .sha']);
    const t = runRefStep(BASH, script, { DEPLOY_REF: 'v2.43.0' });
    assert.equal(t.status, 0, t.stdout);
    assert.equal(t.output, `deploy_sha=${'b'.repeat(40)}\ntooling_sha=${'a'.repeat(40)}\n`);
    assert.deepEqual(t.calls, ['api repos/acme/repo/commits/refs/tags/v2.43.0 --jq .sha', 'api repos/acme/repo/commits/refs/heads/main --jq .sha']);
    assert.equal(path.dirname(t.dir), path.resolve(os.tmpdir()));
    assert.match(path.basename(t.dir), /^ref-/);
    assert.equal(fs.existsSync(t.dir), false, 'katalog roboczy usunięty po biegu');
  });

  test('krok w bash: ręczne uruchomienie spoza refs/heads/main (także Main) odrzucone przed gh; release z refem taga przechodzi', () => {
    for (const ref of ['refs/heads/Main', 'refs/heads/MAIN', 'refs/heads/feature', 'refs/tags/v2.43.0', '']) {
      const r = runRefStep(BASH, script, { DEPLOY_REF: 'main', GITHUB_REF: ref });
      assert.equal(r.status, 1, ref);
      assert.deepEqual(r.calls, [], ref);
      assert.equal(r.output, '', ref);
      assert.equal(r.stdout.trim(), `::error::manual deploy must be started from refs/heads/main, got ${ref || "''"}`, ref);
    }
    const rel = runRefStep(BASH, script, { DEPLOY_REF: 'v2.43.0', GITHUB_EVENT_NAME: 'release', GITHUB_REF: 'refs/tags/v2.43.0' });
    assert.equal(rel.status, 0, rel.stdout);
    assert.equal(rel.output, `deploy_sha=${'b'.repeat(40)}\ntooling_sha=${'a'.repeat(40)}\n`);
  });

  test('krok w bash: nieistniejący ref, nierozwiązany main i odpowiedź bez pełnego SHA kończą się błędem bez zapisu wyjść', () => {
    const cases = [
      [{ DEPLOY_REF: 'v9.9.9' }, "::error::ref 'v9.9.9' does not exist in acme/repo"],
      [{ DEPLOY_REF: 'main', FAKE_MAIN: '' }, "::error::ref 'main' does not exist in acme/repo"],
      [{ DEPLOY_REF: 'v2.43.0', FAKE_MAIN: '' }, '::error::cannot resolve main in acme/repo'],
      [{ DEPLOY_REF: 'v2.43.0', FAKE_TAG: 'b'.repeat(39) }, '::error::ref resolution did not return full commit SHAs'],
      [{ DEPLOY_REF: 'v2.43.0', FAKE_MAIN: 'A'.repeat(40) }, '::error::ref resolution did not return full commit SHAs'],
      [{ DEPLOY_REF: 'main', FAKE_MAIN: `${'a'.repeat(40)}0` }, '::error::ref resolution did not return full commit SHAs']
    ];
    for (const [env, msg] of cases) {
      const r = runRefStep(BASH, script, env);
      assert.equal(r.status, 1, JSON.stringify(env));
      assert.equal(r.stdout.trim(), msg, JSON.stringify(env));
      assert.equal(r.output, '');
    }
  });

  test('oba checkouty biorą SHA z wyjść kroku walidacji; krok ma id ref', () => {
    assert.match(validate.text, /^ {8}id: ref$/m);
    assert.match(list[stepNamed(list, 'Checkout ${{ env.DEPLOY_REF }}')].text, /^ {10}ref: \$\{\{ steps\.ref\.outputs\.deploy_sha \}\}$/m);
    assert.match(list[stepNamed(list, 'Checkout deploy tooling from main')].text, /^ {10}ref: \$\{\{ steps\.ref\.outputs\.tooling_sha \}\}$/m);
  });

  test('guard: ręczne uruchomienie tylko z refs/heads/main, release bez pre-release (zdarzenie nazwane jawnie, bo null == false)', () => {
    assert.match(deployText, /^ {4}if: >-\n {6}\(github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\) \|\|\n {6}\(github\.event_name == 'release' && github\.event\.release\.prerelease == false\)\n/m);
  });

  test('AC-9 a: te same kroki w tej samej kolejności co przed #296 (guard w if joba, cache usunięty w kroku Setup Node.js)', () => {
    assert.deepEqual(list.map(s => s.name), [
      'Validate deploy ref', 'Checkout ${{ env.DEPLOY_REF }}', 'Checkout deploy tooling from main', 'Setup Node.js',
      'Install dependencies', 'Lint', 'Unit tests + coverage thresholds', 'clasp version', 'Configure clasp credentials',
      'Stamp deployed version into Version.gs', 'Files that will be pushed', 'Record deployment (in_progress)', 'Push to Apps Script',
      'Create immutable version', 'Verify the live project matches ${{ env.DEPLOY_REF }}', 'Record deployment result', 'Remove credentials'
    ]);
  });
});
