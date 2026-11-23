'use strict';

/**
 * #296, PR-1 (AC-1, AC-4, AC-5, część AC-6): twarde zasady plików GitHub, które nie mają sekretów
 * Apps Script. Test strukturalny na tekście YAML (repozytorium nie ma parsera YAML, a nie dokładamy
 * zależności dla jednego testu): każda reguła to funkcja `check*(tekst)` zwracająca listę zarzutów,
 * dla prawdziwych plików oczekujemy pustej listy, a syntetyczne fixture'y łamiące każdą regułę muszą
 * dać zarzut (test musi umieć paść).
 *
 * Zakres: wszystkie workflow'y poza `apps-script-drift.yml` i `deploy-apps-script.yml`; te dwa
 * (workflow'y z sekretami Apps Script) obejmuje PR-2 zgłoszenia #296 i do tego czasu są na liście
 * ODROCZONE. Ten test nie dowodzi zachowania w runtime ani izolacji sekretów od gałęzi.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** Workflow'y z sekretami Apps Script: zakres PR-2 zgłoszenia #296 (przypięcia, checkouty, nazwy). */
const ODROCZONE = ['apps-script-drift.yml', 'deploy-apps-script.yml'];
const WORKFLOW_FILES = fs.readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f)).sort();
const OBJETE = WORKFLOW_FILES.filter(f => !ODROCZONE.includes(f));

const isComment = line => /^\s*#/.test(line);
const withoutComments = text => text.split('\n').filter(l => !isComment(l)).join('\n');

/** Blok najwyższego poziomu `klucz:` (linie wcięte pod nim), bez samej linii klucza. */
function topBlock(text, key) {
  const lines = text.split('\n');
  const i = lines.findIndex(l => l === `${key}:` || l.startsWith(`${key}: `));
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length && (lines[j] === '' || /^\s/.test(lines[j]) || isComment(lines[j])); j++) out.push(lines[j]);
  return out;
}

/** Joby: [{ id, text }], klucze w `jobs:` na wcięciu 2. */
function jobs(text) {
  const body = topBlock(text, 'jobs');
  if (!body) return [];
  const result = [];
  for (const line of body) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) result.push({ id: m[1], lines: [line] });
    else if (result.length) result[result.length - 1].lines.push(line);
  }
  return result.map(j => ({ id: j.id, text: j.lines.join('\n') }));
}

/** Kroki joba: tekst od `      - ` do następnego kroku (wcięcie listy kroków: 6 spacji). */
function steps(jobText) {
  return jobText.split(/^ {6}- /m).slice(1).map(s => `      - ${s}`);
}

/** Wszystkie bloki `run:` i `script:` (blokowe i jednoliniowe), jako teksty. */
function scriptBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?(run|script):\s*(.*)$/.exec(lines[i]);
    if (!m || isComment(lines[i])) continue;
    const indent = m[1].length + (lines[i].trim().startsWith('- ') ? 2 : 0);
    const out = [m[3]];
    for (let j = i + 1; j < lines.length; j++) {
      const ind = /^\s*/.exec(lines[j])[0].length;
      if (lines[j].trim() !== '' && ind <= indent) break;
      out.push(lines[j]);
    }
    blocks.push(out.join('\n'));
  }
  return blocks;
}

/** Wejścia w wyrażeniach `${{ }}` nie mogą trafiać do skryptów: wartości idą przez `env`. */
function checkNoExpressionsInScripts(text, name) {
  const bad = [];
  for (const block of scriptBlocks(text)) {
    if (/\$\{\{/.test(block)) bad.push(`${name}: wyrażenie \${{ }} w skrypcie run/script: ${block.trim().split('\n')[0].slice(0, 60)}`);
  }
  return bad;
}

/** Linie uprawnień w blokach `permissions:` (poziom workflow i joba) z flagą komentarza. */
function permissionLines(text) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)permissions:\s*$/.exec(lines[i]);
    if (!m || isComment(lines[i])) continue;
    const level = m[1].length === 0 ? 'workflow' : 'job';
    for (let j = i + 1; j < lines.length; j++) {
      // Pusta linia i komentarz między uprawnieniami nie kończą bloku.
      if (lines[j].trim() === '' || isComment(lines[j])) continue;
      const p = /^(\s+)([a-z-]+):\s*(read|write|none)\s*(#.*)?$/.exec(lines[j]);
      if (!p || p[1].length <= m[1].length) break;
      const commented = Boolean(p[4]) || isComment(lines[j - 1] || '');
      found.push({ level, perm: p[2], value: p[3], commented, line: j + 1 });
    }
  }
  return found;
}

/** Uprawnienia zapisu tylko na poziomie joba, każde (poza `contents: read`) z komentarzem uzasadnienia. */
function checkPermissions(text, name) {
  const bad = [];
  for (const p of permissionLines(text)) {
    if (p.level === 'workflow' && p.value === 'write') bad.push(`${name}:${p.line}: ${p.perm}: write na poziomie workflow`);
    if (!(p.perm === 'contents' && p.value === 'read') && !p.commented) bad.push(`${name}:${p.line}: ${p.perm}: ${p.value} bez komentarza uzasadnienia`);
  }
  return bad;
}

/** Każde `uses:` (poza lokalnym `./`) to pełny SHA z komentarzem wersji `# vN...`. */
function checkPins(text, name) {
  const bad = [];
  text.split('\n').forEach((line, i) => {
    const m = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(.*))?$/.exec(line);
    if (!m || isComment(line) || m[1].startsWith('./')) return;
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(m[1])) bad.push(`${name}:${i + 1}: ${m[1]} nie jest przypięte do pełnego SHA`);
    else if (!/^v\d/.test(m[2] || '')) bad.push(`${name}:${i + 1}: ${m[1]} bez komentarza wersji`);
  });
  return bad;
}

/** Każdy `actions/checkout` ma `persist-credentials: false`. */
function checkCheckoutCredentials(text, name) {
  const bad = [];
  for (const job of jobs(text)) {
    for (const step of steps(job.text)) {
      if (/uses:\s*actions\/checkout@/.test(step) && !/^ {10}persist-credentials: false\s*$/m.test(step)) {
        bad.push(`${name}: job ${job.id}: checkout bez persist-credentials: false`);
      }
    }
  }
  return bad;
}

/** Każdy job ma nazwę (`name:` na wcięciu 4). */
function checkJobNames(text, name) {
  return jobs(text).filter(j => !/^ {4}name:\s*\S/m.test(j.text)).map(j => `${name}: job ${j.id} bez name`);
}

/** Workflow ma `concurrency` na poziomie najwyższym albo w każdym jobie. */
function checkConcurrency(text, name) {
  if (topBlock(text, 'concurrency')) return [];
  const list = jobs(text);
  if (list.length && list.every(j => /^ {4}concurrency:/m.test(j.text))) return [];
  return [`${name}: brak concurrency`];
}

/** Klucze wyzwalaczy workflow (`on:`), wcięcie 2. */
function triggers(text) {
  return (topBlock(text, 'on') || []).map(l => /^ {2}([a-z_]+):/.exec(l)).filter(Boolean).map(m => m[1]);
}

/** Workflow'y z `pull_request_target`/`issue_comment` nie pobierają kodu PR i nie sięgają do `head`. */
function checkNoPrCode(text, name) {
  const code = withoutComments(text);
  const bad = [];
  if (/github\.event\.pull_request\.head\./.test(code)) bad.push(`${name}: odwołanie do github.event.pull_request.head.*`);
  if (/github\.head_ref/.test(code)) bad.push(`${name}: odwołanie do github.head_ref`);
  for (const job of jobs(text)) {
    for (const step of steps(job.text)) {
      if (/uses:\s*actions\/checkout@/.test(step) && /^ {10}(ref|repository):/m.test(step)) bad.push(`${name}: job ${job.id}: checkout z ref/repository`);
    }
  }
  return bad;
}

/** Konfiguracja zizmor: tylko reguła `dangerous-triggers`, dokładnie dwa pliki, każdy z komentarzem nad wpisem. */
function checkZizmorConfig(text) {
  const bad = [];
  const lines = text.split('\n');
  const rules = lines.map(l => /^ {2}([a-z-]+):\s*$/.exec(l)).filter(Boolean).map(m => m[1]);
  if (rules.join() !== 'dangerous-triggers') bad.push(`zizmor.yml: reguły z wyjątkami: [${rules.join(', ')}], oczekiwano [dangerous-triggers]`);
  const entries = [];
  lines.forEach((l, i) => {
    const m = /^ {6}-\s+(\S+)\s*$/.exec(l);
    if (m) {
      entries.push(m[1]);
      if (!isComment(lines[i - 1] || '')) bad.push(`zizmor.yml:${i + 1}: wpis ${m[1]} bez komentarza uzasadnienia nad nim`);
    }
  });
  if ([...entries].sort().join() !== 'issue-audit.yml,review-gate.yml') bad.push(`zizmor.yml: lista wyjątków [${entries.join(', ')}], oczekiwano [issue-audit.yml, review-gate.yml]`);
  if (/^\s*disable:/m.test(withoutComments(text))) bad.push('zizmor.yml: disable zamiast ignore');
  return bad;
}

/** Dependabot: `cooldown` z `default-days` >= 7 i komentarzem uzasadnienia w każdym wpisie. */
function checkDependabot(text) {
  const bad = [];
  const entries = text.split(/^ {2}- (?=package-ecosystem:)/m).slice(1);
  if (!entries.length) bad.push('dependabot.yml: brak wpisów updates');
  for (const e of entries) {
    const eco = (/^package-ecosystem:\s*(\S+)/.exec(e) || [])[1];
    const lines = e.split('\n');
    const at = lines.findIndex(l => /^ {4}cooldown:\s*$/.test(l));
    const days = at >= 0 ? /^ {6}default-days:\s*(\d+)\s*$/.exec(lines[at + 1] || '') : null;
    if (!days) bad.push(`dependabot.yml: ${eco}: brak cooldown.default-days`);
    else if (Number(days[1]) < 7) bad.push(`dependabot.yml: ${eco}: cooldown.default-days=${days[1]} < 7`);
    if (at >= 0 && !isComment(lines[at - 1] || '')) bad.push(`dependabot.yml: ${eco}: cooldown bez komentarza nad wpisem`);
  }
  return bad;
}

describe('workflow\'y bez sekretów Apps Script: stan prawdziwych plików', () => {
  test('lista objętych plików nie jest pusta i nie zawiera workflow\'ów z odroczonego zakresu', () => {
    assert.ok(OBJETE.length >= 8, `objęte: ${OBJETE.join(', ')}`);
    for (const f of ODROCZONE) assert.ok(!OBJETE.includes(f));
    for (const f of ODROCZONE) assert.ok(WORKFLOW_FILES.includes(f), `odroczony plik ${f} nie istnieje: zaktualizuj listę`);
  });

  for (const f of OBJETE) {
    const text = read(`.github/workflows/${f}`);
    test(`${f}: brak wyrażeń \${{ }} w run/script (wartości przez env)`, () => assert.deepEqual(checkNoExpressionsInScripts(text, f), []));
    test(`${f}: zapis uprawnień tylko na poziomie joba, każde uprawnienie z komentarzem`, () => assert.deepEqual(checkPermissions(text, f), []));
    test(`${f}: akcje przypięte do pełnego SHA z komentarzem wersji`, () => assert.deepEqual(checkPins(text, f), []));
    test(`${f}: checkout z persist-credentials: false`, () => assert.deepEqual(checkCheckoutCredentials(text, f), []));
    test(`${f}: każdy job ma nazwę`, () => assert.deepEqual(checkJobNames(text, f), []));
    test(`${f}: concurrency`, () => assert.deepEqual(checkConcurrency(text, f), []));
  }

  test('workflow z odroczonego zakresu też nie ma wyrażeń w run/script (stan z #297 zachowany)', () => {
    for (const f of ODROCZONE) assert.deepEqual(checkNoExpressionsInScripts(read(`.github/workflows/${f}`), f), []);
  });
});

describe('review-gate.yml i issue-audit.yml: wyzwalacze zostają, kod PR nie jest pobierany', () => {
  const gate = read('.github/workflows/review-gate.yml');
  const audit = read('.github/workflows/issue-audit.yml');

  test('review-gate.yml: wyzwalacze to dokładnie pull_request_target, issue_comment, workflow_dispatch', () => {
    assert.deepEqual(triggers(gate), ['pull_request_target', 'issue_comment', 'workflow_dispatch']);
  });
  test('issue-audit.yml: wyzwalacze to dokładnie issues i issue_comment', () => {
    assert.deepEqual(triggers(audit), ['issues', 'issue_comment']);
  });
  test('review-gate.yml: brak odwołań do head PR i checkoutu z ref/repository', () => assert.deepEqual(checkNoPrCode(gate, 'review-gate.yml'), []));
  test('issue-audit.yml: brak odwołań do head PR i checkoutu z ref/repository', () => assert.deepEqual(checkNoPrCode(audit, 'issue-audit.yml'), []));

  test('review-gate.yml: job review-ack pobiera tylko jeden plik skryptu z bazy, bez npm ci ani cache', () => {
    const job = jobs(gate).find(j => j.id === 'review-ack');
    assert.ok(job, 'brak jobu review-ack');
    const checkout = steps(job.text).filter(s => /actions\/checkout@/.test(s));
    assert.equal(checkout.length, 1);
    assert.match(checkout[0], /sparse-checkout: \|\n\s+scripts\/quality\/review-ack\.js\n/);
    const code = withoutComments(job.text);
    assert.doesNotMatch(code, /npm (ci|install)|cache:|actions\/cache/);
    assert.match(code, /if: github\.event_name == 'pull_request_target'/);
  });

  test('issue-audit.yml: guard na pull requesty i filtr autora komentarza zostają', () => {
    const code = withoutComments(audit);
    assert.match(code, /!github\.event\.issue\.pull_request/);
    assert.match(code, /author_association/);
  });
  test('review-gate.yml: filtr autora komentarza w jobie reevaluate zostaje', () => {
    const job = jobs(gate).find(j => j.id === 'reevaluate');
    assert.ok(job);
    assert.match(withoutComments(job.text), /author_association/);
  });
});

describe('.github/zizmor.yml i .github/dependabot.yml', () => {
  test('zizmor.yml: lista wyjątków zamknięta (tylko dangerous-triggers dla dwóch plików, z uzasadnieniem)', () => {
    assert.deepEqual(checkZizmorConfig(read('.github/zizmor.yml')), []);
  });
  test('dependabot.yml: cooldown w obu wpisach (default-days >= 7, z komentarzem)', () => {
    assert.deepEqual(checkDependabot(read('.github/dependabot.yml')), []);
  });
});

describe('kontrole ujemne: fixture łamiący regułę daje zarzut', () => {
  const SHA = 'a'.repeat(40);
  const wf = body => `name: X\n\non:\n  push:\n\npermissions:\n  contents: read\n\n${body}`;

  test('wyrażenie w run (blokowe i jednoliniowe) i w script', () => {
    const block = wf('jobs:\n  a:\n    name: A\n    steps:\n      - name: s\n        run: |\n          echo "${{ github.event.pull_request.title }}"\n');
    const one = wf('jobs:\n  a:\n    name: A\n    steps:\n      - name: s\n        run: echo ${{ github.sha }}\n');
    const script = wf(`jobs:\n  a:\n    name: A\n    steps:\n      - uses: actions/github-script@${SHA} # v9\n        with:\n          script: |\n            core.info(\`\${{ github.actor }}\`)\n`);
    assert.equal(checkNoExpressionsInScripts(block, 'f').length, 1);
    assert.equal(checkNoExpressionsInScripts(one, 'f').length, 1);
    assert.equal(checkNoExpressionsInScripts(script, 'f').length, 1);
    assert.deepEqual(checkNoExpressionsInScripts(wf('jobs:\n  a:\n    name: A\n    steps:\n      - name: s\n        env:\n          T: ${{ github.sha }}\n        run: echo "$T"\n'), 'f'), []);
  });

  test('zapis uprawnień na poziomie workflow i uprawnienie bez komentarza', () => {
    assert.equal(checkPermissions('permissions:\n  contents: read\n  issues: write # powód\n', 'f').filter(x => /poziomie workflow/.test(x)).length, 1);
    assert.equal(checkPermissions('jobs:\n  a:\n    permissions:\n      contents: read\n      issues: write\n', 'f').length, 1);
    assert.deepEqual(checkPermissions('jobs:\n  a:\n    permissions:\n      contents: read\n      # etykiety\n      issues: write\n      pull-requests: read # odczyt PR\n', 'f'), []);
  });

  test('uprawnienia: pierwsza linia bloku, odczyt bez komentarza, komentarz między liniami, rodzeństwo bloku', () => {
    // pierwsza linia bloku jest sprawdzana
    assert.equal(checkPermissions('permissions:\n  issues: write\n', 'f').length, 2);
    // odczyt innego uprawnienia niż contents też wymaga komentarza; contents: read nie
    assert.equal(checkPermissions('permissions:\n  contents: read\n  pull-requests: read\n', 'f').length, 1);
    assert.deepEqual(checkPermissions('permissions:\n  contents: read\n', 'f'), []);
    // komentarz tylko w tej samej linii albo tylko linię wyżej wystarcza (osobno)
    assert.deepEqual(checkPermissions('permissions:\n  contents: read\n  issues: read # powód\n', 'f'), []);
    assert.deepEqual(checkPermissions('permissions:\n  contents: read\n  # powód\n  issues: read\n', 'f'), []);
    // pusta linia i komentarz w środku nie kończą bloku: późniejsza linia bez komentarza jest widziana
    assert.equal(checkPermissions('permissions:\n  contents: read\n\n  # powód\n  issues: read # powód\n\n  actions: write\n', 'f').length, 2);
    // klucz rodzeństwa na tym samym wcięciu co `permissions:` nie jest uprawnieniem
    assert.deepEqual(checkPermissions('jobs:\n  a:\n    permissions:\n      contents: read\n    cache-flag: write\n', 'f'), []);
  });

  test('parsery pomocnicze: kroki, joby i bloki skryptu z pustą linią w środku', () => {
    const jobText = '    steps:\n      - name: a\n        run: x\n      - name: b\n        run: y\n';
    assert.equal(steps(jobText).length, 2);
    assert.deepEqual(steps(jobText).map(s => /name: (\w)/.exec(s)[1]), ['a', 'b']);
    assert.deepEqual(jobs('name: X\n\njobs:\n  a:\n    name: A\n  b:\n    name: B\n\nother: 1\n').map(j => j.id), ['a', 'b']);
    // pusta linia w bloku `run:` nie kończy bloku: wyrażenie po niej też jest wykryte
    assert.equal(checkNoExpressionsInScripts('      - name: s\n        run: |\n          echo a\n\n          echo ${{ github.sha }}\n', 'f').length, 1);
    // następny klucz na wcięciu `run:` kończy blok
    assert.deepEqual(checkNoExpressionsInScripts('      - name: s\n        run: |\n          echo a\n        env:\n          T: ${{ github.sha }}\n', 'f'), []);
  });

  test('akcja przypięta do tagu, gałęzi albo bez komentarza wersji', () => {
    assert.equal(checkPins('      - uses: actions/checkout@v7\n', 'f').length, 1);
    assert.equal(checkPins('      - uses: actions/checkout@main\n', 'f').length, 1);
    assert.equal(checkPins(`      - uses: actions/checkout@${SHA}\n`, 'f').length, 1);
    assert.equal(checkPins(`      - uses: actions/checkout@${SHA.slice(1)} # v7\n`, 'f').length, 1);
    assert.deepEqual(checkPins(`        uses: actions/checkout@${SHA} # v7.0.1\n      - uses: ./.github/actions/x\n`, 'f'), []);
  });

  test('checkout bez persist-credentials: false', () => {
    const job = body => wf(`jobs:\n  a:\n    name: A\n    steps:\n      - name: Checkout\n        uses: actions/checkout@${SHA} # v7\n${body}`);
    assert.equal(checkCheckoutCredentials(job(''), 'f').length, 1);
    assert.equal(checkCheckoutCredentials(job('        with:\n          persist-credentials: true\n'), 'f').length, 1);
    assert.deepEqual(checkCheckoutCredentials(job('        with:\n          fetch-depth: 0\n          persist-credentials: false\n'), 'f'), []);
  });

  test('job bez nazwy i workflow bez concurrency', () => {
    assert.equal(checkJobNames(wf('jobs:\n  a:\n    runs-on: x\n'), 'f').length, 1);
    assert.deepEqual(checkJobNames(wf('jobs:\n  a:\n    name: A\n    runs-on: x\n'), 'f'), []);
    assert.equal(checkConcurrency(wf('jobs:\n  a:\n    name: A\n'), 'f').length, 1);
    assert.deepEqual(checkConcurrency(wf('concurrency:\n  group: g\n  cancel-in-progress: true\n\njobs:\n  a:\n    name: A\n'), 'f'), []);
    assert.deepEqual(checkConcurrency(wf('jobs:\n  a:\n    name: A\n    concurrency:\n      group: g\n'), 'f'), []);
    // job-level: każdy job musi mieć concurrency, jeden nie wystarcza
    assert.equal(checkConcurrency(wf('jobs:\n  a:\n    name: A\n    concurrency:\n      group: g\n  b:\n    name: B\n'), 'f').length, 1);
  });

  test('syntetyczny workflow w stylu review-gate z checkoutem head PR daje zarzut', () => {
    const bad = `name: G\n\non:\n  pull_request_target:\n    types: [opened]\n\npermissions:\n  contents: read\n\njobs:\n  review-ack:\n    name: R\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`;
    const out = checkNoPrCode(bad, 'g.yml');
    assert.ok(out.some(x => /head/.test(x)), out.join('; '));
    assert.ok(out.some(x => /ref\/repository/.test(x)), out.join('; '));
    assert.equal(checkNoPrCode(`name: G\n\non:\n  pull_request_target:\n\njobs:\n  a:\n    name: A\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n        with:\n          repository: \${{ github.repository }}\n`, 'g.yml').length, 1);
    assert.equal(checkNoPrCode('      - run: echo ${{ github.head_ref }}\n', 'g.yml').length, 1);
    assert.deepEqual(checkNoPrCode('# github.event.pull_request.head.sha tylko w komentarzu\n', 'g.yml'), []);
  });

  test('zizmor.yml: dodatkowa reguła, dodatkowy plik, brak uzasadnienia, disable', () => {
    const ok = 'rules:\n  dangerous-triggers:\n    ignore:\n      # powód 1\n      - issue-audit.yml\n      # powód 2\n      - review-gate.yml\n';
    assert.deepEqual(checkZizmorConfig(ok), []);
    const extraRule = checkZizmorConfig(ok.replace('  dangerous-triggers:', '  template-injection:\n    ignore:\n      # x\n      - issue-audit.yml\n      # y\n      - review-gate.yml\n  dangerous-triggers:'));
    assert.equal(extraRule.length, 2, extraRule.join('; '));
    assert.match(extraRule[0], /reguły z wyjątkami: \[template-injection, dangerous-triggers\]/);
    assert.match(extraRule[1], /lista wyjątków \[issue-audit\.yml, review-gate\.yml, issue-audit\.yml, review-gate\.yml\]/);
    const extraFile = checkZizmorConfig(ok + '      # powód 3\n      - ci.yml\n');
    assert.equal(extraFile.length, 1, extraFile.join('; '));
    assert.match(extraFile[0], /lista wyjątków/);
    const noReason = checkZizmorConfig(ok.replace('      # powód 2\n', ''));
    assert.equal(noReason.length, 1, noReason.join('; '));
    assert.match(noReason[0], /zizmor\.yml:\d+: wpis review-gate\.yml bez komentarza/);
    const missing = checkZizmorConfig(ok.replace('      - review-gate.yml\n', ''));
    assert.equal(missing.length, 1, missing.join('; '));
    assert.match(missing[0], /lista wyjątków \[issue-audit\.yml\]/);
    const disabled = checkZizmorConfig(ok + '    disable: true\n');
    assert.equal(disabled.length, 1, disabled.join('; '));
    assert.match(disabled[0], /disable zamiast ignore/);
    assert.deepEqual(checkZizmorConfig(ok.replace('    ignore:', '    # disable: true tylko w komentarzu\n    ignore:')), []);
    assert.ok(checkZizmorConfig('').length > 0);
  });

  test('dependabot: brak cooldown, za mały cooldown, cooldown bez komentarza', () => {
    const entry = (cool) => `version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n${cool}    schedule:\n      interval: weekly\n`;
    assert.match(checkDependabot(entry(''))[0], /dependabot\.yml: npm: brak cooldown\.default-days/);
    const small = checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 3\n'));
    assert.equal(small.length, 1);
    assert.match(small[0], /npm: cooldown\.default-days=3 < 7/);
    const noComment = checkDependabot(entry('    cooldown:\n      default-days: 7\n'));
    assert.equal(noComment.length, 1);
    assert.match(noComment[0], /npm: cooldown bez komentarza/);
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 8\n')), []);
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 7\n')), []);
    assert.equal(checkDependabot('version: 2\n').length, 1);
  });

  test('wyzwalacze: kolejność i lista kluczy z bloku on', () => {
    assert.deepEqual(triggers('name: X\n\non:\n  issues:\n    types: [opened]\n  issue_comment:\n    types: [created]\n\npermissions:\n  contents: read\n'), ['issues', 'issue_comment']);
    assert.deepEqual(triggers('name: X\n'), []);
  });
});
