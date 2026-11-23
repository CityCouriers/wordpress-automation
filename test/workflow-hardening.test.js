'use strict';

/**
 * #296, PR-1 (AC-1, AC-4, AC-5, część AC-6): twarde zasady plików GitHub, które nie mają sekretów
 * Apps Script. Test strukturalny na tekście YAML (repozytorium nie ma parsera YAML, a nie dokładamy
 * zależności dla jednego testu): każda reguła to funkcja `check*(tekst)` zwracająca listę zarzutów,
 * dla prawdziwych plików oczekujemy pustej listy, a syntetyczne fixture'y łamiące każdą regułę muszą
 * dać zarzut (test musi umieć paść).
 *
 * Zakres deklaracji: test chroni przed POMYŁKĄ i regresją w zatwierdzonym kodzie. Nie chroni przed osobą,
 * która na gałęzi zmienia sam YAML i sam test (zaakceptowane ryzyko, decyzja właściciela w #296, wariant A).
 * Parser jest tekstowy, więc zamiast zgadywać nieobsługiwany zapis YAML, test go ODRZUCA (`checkFormats`):
 * zapis przepuszczony po cichu byłby obejściem reguł.
 *
 * Zakres plików: wszystkie workflow'y poza `apps-script-drift.yml` i `deploy-apps-script.yml`; te dwa
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
/** Nazwy checków wymaganych przez ochronę gałęzi i przez agregat jakości; zmiana nazwy joba je zrywa. */
const WYMAGANE_NAZWY = ['validate', 'secret-scan', 'quality-gate', 'pr-title', 'review-ack'];

const isComment = line => /^\s*#/.test(line);
const withoutComments = text => text.split('\n').filter(l => !isComment(l)).join('\n');
const indentOf = line => /^\s*/.exec(line)[0].length;

/** Blok najwyższego poziomu `klucz:` (linie wcięte pod nim), bez samej linii klucza. */
function topBlock(text, key) {
  const lines = text.split('\n');
  const i = lines.findIndex(l => l === `${key}:` || l.startsWith(`${key}: `));
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length && (lines[j] === '' || /^\s/.test(lines[j]) || isComment(lines[j])); j++) out.push(lines[j]);
  return out;
}

/** Joby: [{ id, indent, text }]; wcięcie kluczy w `jobs:` wynika z pierwszej linii bloku. */
function jobs(text) {
  const body = topBlock(text, 'jobs');
  const first = (body || []).find(l => l.trim() !== '' && !isComment(l));
  if (!first) return [];
  const indent = indentOf(first);
  const re = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):\\s*(?:#.*)?$`);
  const result = [];
  for (const line of body) {
    const m = re.exec(line);
    if (m) result.push({ id: m[1], indent, lines: [line] });
    else if (result.length) result[result.length - 1].lines.push(line);
  }
  return result.map(j => ({ id: j.id, indent: j.indent, text: j.lines.join('\n') }));
}

/** Kroki joba: teksty od linii `- ` do następnego kroku; wcięcie listy wynika z pierwszego elementu. */
function steps(jobText) {
  const lines = jobText.split('\n');
  const at = lines.findIndex(l => /^\s*steps:\s*(?:#.*)?$/.test(l));
  if (at < 0) return [];
  const first = lines.slice(at + 1).find(l => l.trim() !== '' && !isComment(l));
  if (!first) return [];
  const itemIndent = indentOf(first);
  const stepsIndent = indentOf(lines[at]);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' || isComment(line)) { if (out.length) out[out.length - 1].push(line); continue; }
    const ind = indentOf(line);
    if (ind <= stepsIndent && !(ind === itemIndent && line.trim().startsWith('- '))) break;
    if (ind === itemIndent && line.trim().startsWith('- ')) out.push([line]);
    else if (out.length) out[out.length - 1].push(line);
  }
  return out.map(s => s.join('\n'));
}

/** Linie wcięte pod kluczem `key:` w kroku (np. `with:`, `env:`); pusta lista, gdy klucza brak. */
function blockOf(stepText, key) {
  const lines = stepText.split('\n');
  const at = lines.findIndex(l => new RegExp(`^\\s*(?:- )?${key}:\\s*(?:#.*)?$`).test(l));
  if (at < 0) return [];
  const keyIndent = indentOf(lines[at]) + (lines[at].trim().startsWith('- ') ? 2 : 0);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && indentOf(line) <= keyIndent) break;
    out.push(line);
  }
  return out;
}

/** Zakresy linii bloków `run:` i `script:` (zawartość, bez linii klucza) jako [od, do). */
function scriptRanges(lines) {
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?(run|script):\s*(.*)$/.exec(lines[i]);
    if (!m || isComment(lines[i])) continue;
    const indent = m[1].length + (lines[i].trim().startsWith('- ') ? 2 : 0);
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim() !== '' && indentOf(lines[j]) <= indent) break;
    }
    ranges.push({ from: i, to: j, inline: m[3] });
  }
  return ranges;
}

/** Wszystkie bloki `run:` i `script:` (blokowe i jednoliniowe), jako teksty. */
function scriptBlocks(text) {
  const lines = text.split('\n');
  return scriptRanges(lines).map(r => [r.inline, ...lines.slice(r.from + 1, r.to)].join('\n'));
}

/** Tekst bez komentarzy i bez treści skryptów: to, co ma strukturę YAML. */
function yamlOnly(text) {
  const lines = text.split('\n');
  for (const r of scriptRanges(lines)) for (let i = r.from + 1; i < r.to; i++) lines[i] = '';
  return lines.filter(l => !isComment(l)).join('\n');
}

/** Zapisy YAML, których parser tekstowy nie obsługuje: odrzucamy je zamiast przepuszczać. */
function checkFormats(text, name) {
  const bad = [];
  const code = yamlOnly(text);
  if (/\t/.test(code)) bad.push(`${name}: tabulator w YAML`);
  if (/(?:^\s*-\s+|:\s+)\{(?!\{|\})/m.test(code)) bad.push(`${name}: mapa w stylu flow ({ ... }) nieobsługiwana przez test`);
  if (/^\s*(?:-\s+)?["'][\w.-]+["']\s*:/m.test(code)) bad.push(`${name}: klucz w cudzysłowie nieobsługiwany przez test`);
  if (/(?:^\s*|:\s+|-\s+)(?:&|\*)[A-Za-z_]/m.test(code) || /^\s*<<\s*:/m.test(code)) bad.push(`${name}: kotwica, alias albo merge key nieobsługiwane przez test`);
  if (/\\(?:u0024|x24|U00000024)/i.test(code)) bad.push(`${name}: znak $ zapisany sekwencją ucieczki YAML (ukryte wyrażenie)`);
  if (/^on:[ \t]+\S/m.test(code)) bad.push(`${name}: wyzwalacze w formie skróconej (on: ...) nieobsługiwane przez test`);
  return bad;
}

/** Wejścia w wyrażeniach `${{ }}` nie mogą trafiać do skryptów (`run`, `script`, `shell`): wartości idą przez `env`. */
function checkNoExpressionsInScripts(text, name) {
  const bad = [];
  for (const block of scriptBlocks(text)) {
    if (/\$\{\{/.test(block)) bad.push(`${name}: wyrażenie \${{ }} w skrypcie run/script: ${block.trim().split('\n')[0].slice(0, 60)}`);
  }
  for (const line of withoutComments(text).split('\n')) {
    if (/^\s*(?:- )?shell:.*\$\{\{/.test(line)) bad.push(`${name}: wyrażenie \${{ }} w shell: ${line.trim().slice(0, 60)}`);
  }
  return bad;
}

/** Linie uprawnień w blokach `permissions:` (poziom workflow i joba); linie spoza formatu to osobny zarzut. */
function permissionLines(text) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)permissions:\s*(.*)$/.exec(lines[i]);
    if (!m || isComment(lines[i])) continue;
    const level = m[1].length === 0 ? 'workflow' : 'job';
    const rest = m[2].replace(/\s+#.*$/, '').trim();
    if (rest) { found.push({ level, scalar: rest, line: i + 1 }); continue; }
    for (let j = i + 1; j < lines.length; j++) {
      // Pusta linia i komentarz między uprawnieniami nie kończą bloku.
      if (lines[j].trim() === '' || isComment(lines[j])) continue;
      if (indentOf(lines[j]) <= m[1].length) break;
      const p = /^(\s+)([a-z-]+):\s*["']?(read|write|none)["']?\s*(#.*)?$/.exec(lines[j]);
      if (!p) { found.push({ level, unsupported: lines[j].trim(), line: j + 1 }); continue; }
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
    if (p.unsupported) bad.push(`${name}:${p.line}: nieobsługiwana linia uprawnień: ${p.unsupported}`);
    else if (p.scalar !== undefined) { if (p.scalar !== '{}') bad.push(`${name}:${p.line}: permissions: ${p.scalar} (dozwolone tylko blok albo {})`); }
    else {
      if (p.level === 'workflow' && p.value === 'write') bad.push(`${name}:${p.line}: ${p.perm}: write na poziomie workflow`);
      if (!(p.perm === 'contents' && p.value === 'read') && !p.commented) bad.push(`${name}:${p.line}: ${p.perm}: ${p.value} bez komentarza uzasadnienia`);
    }
  }
  return bad;
}

/** Workflow deklaruje `permissions` na poziomie najwyższym (bez tego token dostaje uprawnienia domyślne repozytorium). */
function checkTopPermissions(text, name) {
  return topBlock(text, 'permissions') !== null ? [] : [`${name}: brak permissions na poziomie workflow`];
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

/** Każdy `actions/checkout` ma `persist-credentials: false` w bloku `with:` (nie w `env:` ani gdzie indziej). */
function checkCheckoutCredentials(text, name) {
  const bad = [];
  for (const job of jobs(text)) {
    for (const step of steps(job.text)) {
      if (!/^\s*(?:- )?uses:\s*actions\/checkout@/m.test(step)) continue;
      if (!blockOf(step, 'with').some(l => /^\s*persist-credentials:\s*false\s*(?:#.*)?$/.test(l))) {
        bad.push(`${name}: job ${job.id}: checkout bez persist-credentials: false w with`);
      }
    }
  }
  if (jobs(text).length === 0 && /actions\/checkout@/.test(text)) bad.push(`${name}: checkout w pliku bez rozpoznanych jobów`);
  return bad;
}

/** Każdy job ma `name` równe jego id: nazwa checku zostaje taka, jaką miał job bez `name`. */
function checkJobNames(text, name) {
  const bad = [];
  for (const j of jobs(text)) {
    const m = new RegExp(`^ {${j.indent + 2}}name:\\s*(\\S.*?)\\s*$`, 'm').exec(j.text);
    if (!m) bad.push(`${name}: job ${j.id} bez name`);
    else if (m[1] !== j.id) bad.push(`${name}: job ${j.id} ma name "${m[1]}" różne od id (zmienia nazwę checku)`);
  }
  return bad;
}

/** Workflow ma `concurrency` na poziomie najwyższym albo w każdym jobie. */
function checkConcurrency(text, name) {
  if (topBlock(text, 'concurrency')) return [];
  const list = jobs(text);
  if (list.length && list.every(j => new RegExp(`^ {${j.indent + 2}}concurrency:`, 'm').test(j.text))) return [];
  return [`${name}: brak concurrency`];
}

/** Klucze wyzwalaczy workflow (`on:`). */
function triggers(text) {
  const body = (topBlock(text, 'on') || []).filter(l => l.trim() !== '' && !isComment(l));
  if (!body.length) return [];
  const indent = indentOf(body[0]);
  return body.filter(l => indentOf(l) === indent).map(l => /^\s*([a-z_]+):/.exec(l)).filter(Boolean).map(m => m[1]);
}

/** Workflow'y z `pull_request_target`/`issue_comment` nie pobierają kodu PR i nie sięgają do `head`. */
function checkNoPrCode(text, name) {
  const code = withoutComments(text);
  const bad = [];
  const patterns = [
    [/github\.event\.pull_request(?:\.|\[)\s*['"]?head/, 'odwołanie do github.event.pull_request.head'],
    [/github\.head_ref/, 'odwołanie do github.head_ref'],
    [/merge_commit_sha/, 'odwołanie do merge_commit_sha'],
    [/\bgh\s+pr\s+checkout\b/, 'gh pr checkout'],
    [/\bgit\s+(?:fetch|pull|checkout|switch|clone|worktree|merge|cherry-pick)\b/, 'polecenie git pobierające albo przełączające kod'],
    [/actions\/download-artifact@/, 'download-artifact (artefakty PR są niezaufane)'],
  ];
  for (const [re, label] of patterns) if (re.test(code)) bad.push(`${name}: ${label}`);
  for (const job of jobs(text)) {
    for (const step of steps(job.text)) {
      if (/^\s*(?:- )?uses:\s*actions\/checkout@/m.test(step) && blockOf(step, 'with').some(l => /^\s*(ref|repository):/.test(l))) {
        bad.push(`${name}: job ${job.id}: checkout z ref/repository`);
      }
    }
  }
  return bad;
}

/** Wyjątki skanera tylko w `.github/zizmor.yml`: komentarz `zizmor: ignore` w pliku workflow jest zarzutem. */
function checkNoInlineZizmorIgnore(text, name) {
  return /zizmor:\s*ignore/.test(text) ? [`${name}: komentarz zizmor: ignore poza .github/zizmor.yml`] : [];
}

/** Konfiguracja zizmor: tylko reguła `dangerous-triggers`, dokładnie dwa pliki, każdy z komentarzem nad wpisem. */
function checkZizmorConfig(text) {
  const bad = checkFormats(text, 'zizmor.yml');
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

/** Dependabot: `cooldown` tylko z `default-days` >= 7 i komentarzem uzasadnienia w każdym wpisie. */
function checkDependabot(text) {
  const bad = checkFormats(text, 'dependabot.yml');
  const entries = text.split(/^ {2}- /m).slice(1);
  if (!entries.length) bad.push('dependabot.yml: brak wpisów updates');
  for (const e of entries) {
    const eco = (/^\s*(?:package-ecosystem:\s*|[\s\S]*?\n\s+package-ecosystem:\s*)(\S+)/.exec(e) || [])[1];
    const lines = e.split('\n');
    const at = lines.findIndex(l => /^ {4}cooldown:\s*$/.test(l));
    const block = at >= 0 ? lines.slice(at + 1).filter(l => l.trim() !== '').filter((l, i, all) => all.slice(0, i + 1).every(x => indentOf(x) > 4)) : [];
    const days = /^ {6}default-days:\s*(\d+)\s*$/.exec(block[0] || '');
    if (!days) bad.push(`dependabot.yml: ${eco}: brak cooldown.default-days`);
    else if (Number(days[1]) < 7) bad.push(`dependabot.yml: ${eco}: cooldown.default-days=${days[1]} < 7`);
    if (days && block.length > 1) bad.push(`dependabot.yml: ${eco}: cooldown z dodatkowymi kluczami (${block.slice(1).map(l => l.trim()).join('; ')})`);
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
    test(`${f}: brak wyrażeń \${{ }} w run/script/shell (wartości przez env)`, () => assert.deepEqual(checkNoExpressionsInScripts(text, f), []));
    test(`${f}: zapis uprawnień tylko na poziomie joba, każde uprawnienie z komentarzem`, () => assert.deepEqual(checkPermissions(text, f), []));
    test(`${f}: akcje przypięte do pełnego SHA z komentarzem wersji`, () => assert.deepEqual(checkPins(text, f), []));
    test(`${f}: checkout z persist-credentials: false w with`, () => assert.deepEqual(checkCheckoutCredentials(text, f), []));
    test(`${f}: każdy job ma nazwę równą id`, () => assert.deepEqual(checkJobNames(text, f), []));
    test(`${f}: concurrency`, () => assert.deepEqual(checkConcurrency(text, f), []));
  }

  for (const f of WORKFLOW_FILES) {
    const text = read(`.github/workflows/${f}`);
    test(`${f}: tylko zapisy YAML obsługiwane przez test, uprawnienia na górze, bez komentarza zizmor: ignore`, () => {
      assert.deepEqual([...checkFormats(text, f), ...checkTopPermissions(text, f), ...checkNoInlineZizmorIgnore(text, f)], []);
    });
  }

  test('workflow z odroczonego zakresu też nie ma wyrażeń w run/script/shell (stan z #297 zachowany)', () => {
    for (const f of ODROCZONE) assert.deepEqual(checkNoExpressionsInScripts(read(`.github/workflows/${f}`), f), []);
  });

  test('nazwy checków wymaganych przez ochronę gałęzi i agregat jakości istnieją jako nazwy jobów', () => {
    const names = new Set();
    for (const f of WORKFLOW_FILES) for (const j of jobs(read(`.github/workflows/${f}`))) {
      const m = new RegExp(`^ {${j.indent + 2}}name:\\s*(\\S.*?)\\s*$`, 'm').exec(j.text);
      names.add(m ? m[1] : j.id);
    }
    for (const n of WYMAGANE_NAZWY) assert.ok(names.has(n), `brak joba o nazwie ${n}`);
  });

  test('concurrency: ci.yml nie anuluje przebiegów push na main ani przebiegu ready_for_review; checki wymagane nie są anulowane', () => {
    const ci = read('.github/workflows/ci.yml');
    const block = (topBlock(ci, 'concurrency') || []).join('\n');
    assert.match(block, /group: ci-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}/);
    assert.match(block, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' && github\.event\.action != 'ready_for_review' \}\}/);
    for (const f of ['pr-title.yml', 'pr-template.yml', 'review-gate.yml']) {
      const b = (topBlock(read(`.github/workflows/${f}`), 'concurrency') || []).join('\n');
      assert.match(b, /cancel-in-progress: false/, `${f}: anulowanie przebiegu tego samego SHA zostawia check cancelled`);
    }
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
  test('review-gate.yml: brak odwołań do head PR, pobierania kodu i checkoutu z ref/repository', () => assert.deepEqual(checkNoPrCode(gate, 'review-gate.yml'), []));
  test('issue-audit.yml: brak odwołań do head PR, pobierania kodu i checkoutu z ref/repository', () => assert.deepEqual(checkNoPrCode(audit, 'issue-audit.yml'), []));

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
  test('dependabot.yml: cooldown w obu wpisach (default-days >= 7, bez dodatkowych kluczy, z komentarzem)', () => {
    assert.deepEqual(checkDependabot(read('.github/dependabot.yml')), []);
  });
});

describe('kontrole ujemne: fixture łamiący regułę daje zarzut', () => {
  const SHA = 'a'.repeat(40);
  const wf = body => `name: X\n\non:\n  push:\n\npermissions:\n  contents: read\n\n${body}`;
  const job = (steps4 = '') => wf(`jobs:\n  a:\n    name: a\n    steps:\n${steps4}`);

  test('wyrażenie w run (blokowe i jednoliniowe), w script i w shell', () => {
    const block = wf('jobs:\n  a:\n    name: a\n    steps:\n      - name: s\n        run: |\n          echo "${{ github.event.pull_request.title }}"\n');
    const one = wf('jobs:\n  a:\n    name: a\n    steps:\n      - name: s\n        run: echo ${{ github.sha }}\n');
    const script = wf(`jobs:\n  a:\n    name: a\n    steps:\n      - uses: actions/github-script@${SHA} # v9\n        with:\n          script: |\n            core.info(\`\${{ github.actor }}\`)\n`);
    const shell = wf('jobs:\n  a:\n    name: a\n    steps:\n      - name: s\n        shell: bash -c "${{ github.event.issue.title }}" {0}\n        run: echo x\n');
    assert.equal(checkNoExpressionsInScripts(block, 'f').length, 1);
    assert.equal(checkNoExpressionsInScripts(one, 'f').length, 1);
    assert.equal(checkNoExpressionsInScripts(script, 'f').length, 1);
    assert.equal(checkNoExpressionsInScripts(shell, 'f').length, 1);
    assert.deepEqual(checkNoExpressionsInScripts(wf('jobs:\n  a:\n    name: a\n    steps:\n      - name: s\n        env:\n          T: ${{ github.sha }}\n        run: echo "$T"\n'), 'f'), []);
  });

  test('zapisy YAML nieobsługiwane przez test są odrzucane (flow, cudzysłów w kluczu, kotwice, on: skrócone, tabulator)', () => {
    assert.equal(checkFormats(job('      - { name: s, run: "echo ${{ github.event.issue.title }}" }\n'), 'f').length, 1);
    assert.equal(checkFormats(job('      - "uses": actions/checkout@v7\n'), 'f').length, 1);
    assert.equal(checkFormats(wf('jobs:\n  a:\n    name: a\n    permissions: { contents: read, issues: write }\n'), 'f').length, 1);
    assert.equal(checkFormats(wf('jobs:\n  a:\n    name: a\n    env: &e\n      A: 1\n'), 'f').length, 1);
    assert.equal(checkFormats(wf('jobs:\n  a:\n    name: a\n    env:\n      <<: *e\n'), 'f').length >= 1, true);
    assert.equal(checkFormats('on: [push]\njobs: {}\n', 'f').length, 1);
    assert.equal(checkFormats('on: push\n', 'f').length, 1);
    assert.equal(checkFormats('jobs:\n\ta: 1\n', 'f').length, 1);
    assert.equal(checkFormats('jobs:\n  a:\n    steps:\n      - run: "echo \\u0024{{ github.event.issue.title }}"\n', 'f').length, 1);
    assert.equal(checkFormats('jobs:\n  a:\n    steps:\n      - run: "echo \\x24{{ github.sha }}"\n', 'f').length, 1);
    // dozwolone: sekwencje skalarów, `{}` i wyrażenia ${{ }}, nawiasy klamrowe w skryptach i komentarzach
    assert.deepEqual(checkFormats(wf('jobs:\n  a:\n    name: a\n    permissions: {}\n    if: ${{ github.event_name == \'push\' }}\n    steps:\n      - name: s\n        run: |\n          { echo a; } | cat\n          # { komentarz }\n      - name: t\n        with:\n          types: [opened, edited]\n'), 'f'), []);
  });

  test('uprawnienia: zapis na poziomie workflow, brak komentarza, write-all, wartość w cudzysłowie, brak bloku na górze', () => {
    assert.equal(checkPermissions('permissions:\n  contents: read\n  issues: write # powód\n', 'f').filter(x => /poziomie workflow/.test(x)).length, 1);
    assert.equal(checkPermissions('jobs:\n  a:\n    permissions:\n      contents: read\n      issues: write\n', 'f').length, 1);
    assert.deepEqual(checkPermissions('jobs:\n  a:\n    permissions:\n      contents: read\n      # etykiety\n      issues: write\n      pull-requests: read # odczyt PR\n', 'f'), []);
    assert.equal(checkPermissions('permissions: write-all\n', 'f').length, 1);
    assert.equal(checkPermissions('permissions: read-all\n', 'f').length, 1);
    assert.deepEqual(checkPermissions('permissions: {}\n', 'f'), []);
    assert.equal(checkPermissions('permissions:\n  contents: "read"\n  issues: write\n', 'f').filter(x => /poziomie workflow/.test(x)).length, 1);
    assert.equal(checkPermissions('permissions:\n  contents: read\n  id-token: nieznane\n', 'f').length, 1);
    assert.equal(checkTopPermissions('name: X\n\non:\n  push:\n\njobs:\n  a:\n    name: a\n', 'f').length, 1);
    assert.deepEqual(checkTopPermissions('name: X\n\npermissions:\n  contents: read\n\njobs:\n', 'f'), []);
    assert.deepEqual(checkTopPermissions('name: X\n\npermissions: {}\n\njobs:\n', 'f'), []);
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

  test('parsery pomocnicze: kroki w obu stylach wcięć, joby z komentarzem, bloki z pustą linią', () => {
    const jobText = '    steps:\n      - name: a\n        run: x\n      - name: b\n        run: y\n';
    assert.equal(steps(jobText).length, 2);
    assert.deepEqual(steps(jobText).map(s => /name: (\w)/.exec(s)[1]), ['a', 'b']);
    // lista na tym samym wcięciu co `steps:` (częsty, poprawny styl)
    const flat = steps('    steps:\n    - name: a\n      run: x\n    - name: b\n      run: y\n    other: 1\n');
    assert.deepEqual(flat.map(s => /name: (\w)/.exec(s)[1]), ['a', 'b']);
    assert.doesNotMatch(flat[1], /other: 1/);
    assert.deepEqual(steps('    steps:\n      # komentarz\n      - name: a\n\n      - name: b\n    other: 1\n').map(s => /name: (\w)/.exec(s)[1]), ['a', 'b']);
    assert.deepEqual(steps('    name: x\n'), []);
    assert.deepEqual(steps('    steps:\n'), []);
    // pusta linia i komentarz przed pierwszym elementem listy
    assert.deepEqual(steps('    steps:\n\n      # komentarz\n      - name: a\n').map(s => /name: (\w)/.exec(s)[1]), ['a']);
    // zagnieżdżona lista w kroku nie rozbija kroku
    const nested = steps('    steps:\n      - uses: actions/checkout@x\n        with:\n          sparse-checkout: |\n            a\n          types:\n            - x\n            - y\n          persist-credentials: false\n      - name: b\n');
    assert.equal(nested.length, 2);
    assert.match(nested[0], /persist-credentials: false/);
    assert.deepEqual(jobs('jobs:\n\n  # komentarz\n  a:\n    name: a\n').map(j => j.id), ['a']);
    assert.deepEqual(triggers('on:\n\n  # komentarz\n  push:\n    branches: [main]\n  issues:\n'), ['push', 'issues']);
    // inline `run:` i zaraz po nim `env:` na tym samym wcięciu: wyrażenie w env nie należy do skryptu
    assert.deepEqual(checkNoExpressionsInScripts('      - name: s\n        run: echo x\n        env:\n          T: ${{ github.sha }}\n', 'f'), []);
    // pierwsza linia skryptu wygląda jak mapa flow, ale to skrypt, nie YAML
    assert.deepEqual(checkFormats('jobs:\n  a:\n    name: a\n    steps:\n      - run: |\n          echo msg: {x}\n          echo b\n', 'f'), []);
    assert.deepEqual(jobs('name: X\n\njobs:\n  a:\n    name: A\n  b: # komentarz\n    name: B\n\nother: 1\n').map(j => j.id), ['a', 'b']);
    assert.deepEqual(jobs('jobs:\n    a:\n        name: A\n').map(j => [j.id, j.indent]), [['a', 4]]);
    assert.deepEqual(jobs('name: X\n'), []);
    assert.deepEqual(blockOf('      - uses: x\n        with:\n          a: 1\n\n          b: 2\n        env:\n          c: 3\n', 'with').map(l => l.trim()).filter(Boolean), ['a: 1', 'b: 2']);
    assert.deepEqual(blockOf('      - uses: x\n', 'with'), []);
    // pusta linia w bloku `run:` nie kończy bloku: wyrażenie po niej też jest wykryte
    assert.equal(checkNoExpressionsInScripts('      - name: s\n        run: |\n          echo a\n\n          echo ${{ github.sha }}\n', 'f').length, 1);
    // następny klucz na wcięciu `run:` kończy blok
    assert.deepEqual(checkNoExpressionsInScripts('      - name: s\n        run: |\n          echo a\n        env:\n          T: ${{ github.sha }}\n', 'f'), []);
  });

  test('akcja przypięta do tagu, gałęzi albo bez komentarza wersji; docker://', () => {
    assert.equal(checkPins('      - uses: actions/checkout@v7\n', 'f').length, 1);
    assert.equal(checkPins('      - uses: actions/checkout@main\n', 'f').length, 1);
    assert.equal(checkPins(`      - uses: actions/checkout@${SHA}\n`, 'f').length, 1);
    assert.equal(checkPins(`      - uses: actions/checkout@${SHA.slice(1)} # v7\n`, 'f').length, 1);
    assert.equal(checkPins('      - uses: docker://alpine:3\n', 'f').length, 1);
    assert.deepEqual(checkPins(`        uses: actions/checkout@${SHA} # v7.0.1\n      - uses: ./.github/actions/x\n`, 'f'), []);
  });

  test('checkout bez persist-credentials: false; wpis w env zamiast w with; styl wcięć 4; job z komentarzem', () => {
    const co = body => job(`      - name: Checkout\n        uses: actions/checkout@${SHA} # v7\n${body}`);
    assert.equal(checkCheckoutCredentials(co(''), 'f').length, 1);
    assert.equal(checkCheckoutCredentials(co('        with:\n          persist-credentials: true\n'), 'f').length, 1);
    assert.equal(checkCheckoutCredentials(co('        env:\n          persist-credentials: false\n'), 'f').length, 1);
    assert.deepEqual(checkCheckoutCredentials(co('        with:\n          fetch-depth: 0\n          persist-credentials: false\n'), 'f'), []);
    // lista kroków na wcięciu `steps:` (styl poprawny)
    const flat = (body) => wf(`jobs:\n  a:\n    name: a\n    steps:\n    - uses: actions/checkout@${SHA} # v7\n${body}`);
    assert.equal(checkCheckoutCredentials(flat(''), 'f').length, 1);
    assert.deepEqual(checkCheckoutCredentials(flat('      with:\n        persist-credentials: false\n'), 'f'), []);
    // klucz joba z komentarzem nie ukrywa joba
    assert.equal(checkCheckoutCredentials(wf(`jobs:\n  a: # komentarz\n    name: a\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n`), 'f').length, 1);
    assert.equal(checkCheckoutCredentials(wf(`uses: actions/checkout@${SHA} # v7\n`), 'f').length, 1);
  });

  test('job bez nazwy, z inną nazwą niż id; workflow bez concurrency', () => {
    assert.equal(checkJobNames(wf('jobs:\n  a:\n    runs-on: x\n'), 'f').length, 1);
    assert.deepEqual(checkJobNames(wf('jobs:\n  a:\n    name: a\n    runs-on: x\n'), 'f'), []);
    assert.match(checkJobNames(wf('jobs:\n  validate:\n    name: Validate\n    runs-on: x\n'), 'f')[0], /job validate ma name "Validate" różne od id/);
    assert.equal(checkConcurrency(wf('jobs:\n  a:\n    name: a\n'), 'f').length, 1);
    assert.deepEqual(checkConcurrency(wf('concurrency:\n  group: g\n  cancel-in-progress: true\n\njobs:\n  a:\n    name: a\n'), 'f'), []);
    assert.deepEqual(checkConcurrency(wf('jobs:\n  a:\n    name: a\n    concurrency:\n      group: g\n'), 'f'), []);
    // job-level: każdy job musi mieć concurrency, jeden nie wystarcza
    assert.equal(checkConcurrency(wf('jobs:\n  a:\n    name: a\n    concurrency:\n      group: g\n  b:\n    name: b\n'), 'f').length, 1);
  });

  test('syntetyczny workflow w stylu review-gate z checkoutem head PR daje zarzut; pobranie kodu PR innymi drogami też', () => {
    const bad = `name: G\n\non:\n  pull_request_target:\n    types: [opened]\n\npermissions:\n  contents: read\n\njobs:\n  review-ack:\n    name: review-ack\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`;
    const out = checkNoPrCode(bad, 'g.yml');
    assert.ok(out.some(x => /pull_request\.head/.test(x)), out.join('; '));
    assert.ok(out.some(x => /ref\/repository/.test(x)), out.join('; '));
    assert.equal(checkNoPrCode(`name: G\n\non:\n  pull_request_target:\n\njobs:\n  a:\n    name: a\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n        with:\n          repository: \${{ github.repository }}\n`, 'g.yml').length, 1);
    for (const run of ['echo ${{ github.head_ref }}', 'gh pr checkout "$PR"', 'git fetch origin pull/$PR/head', 'git checkout FETCH_HEAD', 'echo ${{ github.event.pull_request.merge_commit_sha }}', "echo ${{ github.event.pull_request['head'].sha }}", 'git clone https://example.invalid/x']) {
      assert.equal(checkNoPrCode(`      - run: ${run}\n`, 'g.yml').length, 1, run);
    }
    assert.equal(checkNoPrCode(`      - uses: actions/download-artifact@${SHA} # v5\n`, 'g.yml').length, 1);
    assert.deepEqual(checkNoPrCode('# github.event.pull_request.head.sha i gh pr checkout tylko w komentarzu\n      - run: gh pr comment 1\n', 'g.yml'), []);
  });

  test('zizmor.yml: dodatkowa reguła, dodatkowy plik, brak uzasadnienia, disable, flow', () => {
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
    const flow = checkZizmorConfig(ok.replace('  dangerous-triggers:', '  template-injection: { disable: true }\n  dangerous-triggers:'));
    assert.ok(flow.some(x => /flow/.test(x)), flow.join('; '));
    assert.ok(checkZizmorConfig('').length > 0);
  });

  test('komentarz zizmor: ignore w pliku workflow jest zarzutem', () => {
    assert.equal(checkNoInlineZizmorIgnore('      - uses: x # zizmor: ignore[unpinned-uses]\n', 'f').length, 1);
    assert.deepEqual(checkNoInlineZizmorIgnore('      - uses: x # zwykły komentarz\n', 'f'), []);
  });

  test('dependabot: brak cooldown, za mały, bez komentarza, dodatkowe klucze, wpis bez package-ecosystem na początku', () => {
    const entry = (cool) => `version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n${cool}    schedule:\n      interval: weekly\n`;
    assert.match(checkDependabot(entry(''))[0], /dependabot\.yml: npm: brak cooldown\.default-days/);
    const small = checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 3\n'));
    assert.equal(small.length, 1);
    assert.match(small[0], /npm: cooldown\.default-days=3 < 7/);
    const noComment = checkDependabot(entry('    cooldown:\n      default-days: 7\n'));
    assert.equal(noComment.length, 1);
    assert.match(noComment[0], /npm: cooldown bez komentarza/);
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 8\n')), []);
    const extra = checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 7\n      semver-patch-days: 0\n'));
    assert.equal(extra.length, 1);
    assert.match(extra[0], /cooldown z dodatkowymi kluczami \(semver-patch-days: 0\)/);
    assert.equal(checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 7\n      exclude: ["*"]\n')).length, 1);
    const reordered = checkDependabot('version: 2\nupdates:\n  - directory: /\n    package-ecosystem: npm\n    schedule:\n      interval: weekly\n');
    assert.equal(reordered.length, 1);
    assert.match(reordered[0], /npm: brak cooldown/);
    assert.equal(checkDependabot('version: 2\n').length, 1);
  });

  test('wyzwalacze: lista kluczy z bloku on, także z kluczem w cudzysłowie poza obsługą (odrzucany przez checkFormats)', () => {
    assert.deepEqual(triggers('name: X\n\non:\n  issues:\n    types: [opened]\n  issue_comment:\n    types: [created]\n\npermissions:\n  contents: read\n'), ['issues', 'issue_comment']);
    assert.deepEqual(triggers('name: X\n'), []);
    assert.equal(checkFormats('on:\n  "workflow_run":\n    types: [completed]\n', 'f').length, 1);
  });
});
