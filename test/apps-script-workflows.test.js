'use strict';

/**
 * #297: kształt workflow deployu i drift checku (kolejność kroków, uprawnienia, granica
 * zaufania `compare_ref`) oraz zgodność stempla Version.gs z kanonicznym oczekiwanym plikiem.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stripGitEnv } = require('./helpers/git-env');

// Hook pre-commit w drzewie roboczym ustawia GIT_DIR; `git init` w katalogu tymczasowym pisałby wtedy do prawdziwego repozytorium.
stripGitEnv();
const drift = require('../scripts/quality/apps-script-drift');

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
    assert.match(deployText, /^ {4}permissions:\n {6}contents: read\n {6}deployments: write\n/m);
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

  test('narzędzie zapisu rekordu pochodzi z main (sparse checkout), jak narzędzie porównania', () => {
    const s = list[stepNamed(list, 'Checkout deploy tooling from main')];
    assert.match(s.text, /^ {10}ref: main$/m);
    assert.match(s.text, /scripts\/quality\/apps-script-compare\.js\n {12}scripts\/quality\/deployment-record\.js\n/);
  });

  test('żaden krok `run` nie interpoluje wyrażeń ${{ }} (wejścia tylko przez env)', () => {
    for (const s of list) assert.doesNotMatch(runOf(s), /\$\{\{/, `krok "${s.name}"`);
  });
});

describe('apps-script-drift.yml: granica zaufania i źródło rewizji', () => {
  const list = steps(driftText);

  test('uprawnienia: contents: read i deployments: read, nic więcej', () => {
    assert.match(driftText, /^permissions:\n {2}contents: read\n {2}deployments: read\n\n/m);
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
    for (const [ref, actor] of [['v2.43.0', 'octocat'], ['main', 'dependabot[bot]'], ['v1.0.0-rc.1', 'a-b-c']]) {
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
