'use strict';

/**
 * #296: twarde zasady plików GitHub. PR-1 (AC-1, AC-4, AC-5, część AC-6): wszystkie workflow'y; PR-2 (AC-2, AC-3):
 * dodatkowe reguły dla workflow'ów z sekretami Apps Script (`apps-script-drift.yml`, `deploy-apps-script.yml`). Test strukturalny na tekście YAML (repozytorium nie ma parsera YAML, a nie dokładamy
 * zależności dla jednego testu): każda reguła to funkcja `check*(tekst)` zwracająca listę zarzutów,
 * dla prawdziwych plików oczekujemy pustej listy, a syntetyczne fixture'y łamiące każdą regułę muszą
 * dać zarzut (test musi umieć paść).
 *
 * Zakres deklaracji: test chroni przed POMYŁKĄ i regresją w zatwierdzonym kodzie. Nie chroni przed osobą,
 * która na gałęzi zmienia sam YAML i sam test (zaakceptowane ryzyko, decyzja właściciela w #296, wariant A).
 * Parser jest tekstowy, więc zamiast zgadywać nieobsługiwany zapis YAML, test go ODRZUCA (`checkFormats`):
 * zapis przepuszczony po cichu byłby obejściem reguł. Wzorce wierszy `uses:`, `permissions:`, `run:`/`script:` i wpisów
 * `zizmor.yml` są celowo bez `$` na końcu: dopisek za wartością ma dawać zarzut, a nie sprawiać, że wiersz jest pomijany.
 *
 * Granica testu: parser jest tekstowy i nie rozpozna każdej pisowni YAML (spacja przed dwukropkiem, tagi, flow w `[...]`,
 * wieloliniowe skalary w cudzysłowie, aliasy o nietypowych nazwach i inne klasy opisane w #332). To świadome: AC-1 zgłoszenia
 * #296 wymaga wąskiego testu zachowania (job `review-ack` bez `ref:` i bez `head` PR, zamknięta lista wyjątków zizmor, kontrola
 * ujemna), AC-2 ogranicza testy do pomyłki i regresji w zatwierdzonym kodzie, a celowy zapis w nietypowej pisowni leży
 * w zakresie decyzji właściciela (wariant A). Bramką rozumiejącą YAML w każdej pisowni są narzędzia z PR-3 (zizmor, pinact,
 * yamllint); po PR-3 #332 sprawdza wykonaniem, które klasy pokrywają.
 *
 * Reguły AC-2 dla workflow'ów z sekretami (SEKRETNE): (1) tylko te dwa pliki sięgają do sekretów Apps Script, a każdy plik
 * sięga do sekretów wyłącznie zapisem `secrets.NAZWA` z zamkniętej listy, (2) wyłącznie dozwolone wyzwalacze, (3) w jobie
 * z sekretami akcje, polecenia npm, npx, git i gh z zamkniętych list, bez cache i `continue-on-error`, `shell:` tylko bash
 * i `set` tylko `set -euo pipefail`, bez pliku zdarzenia, (4) checkout tylko z refem z listy pliku (`main` albo SHA z kroku walidacji), a wejścia (`inputs`, `github.event.*`)
 * wyłącznie w `env:` i `if:`, (5) `persist-credentials: false`, (6) sekret tylko w krokach i kolejność kroków wokół
 * poświadczeń (kroki z listy bez komentarzy i bez `if:`). Każda z tych kontroli jest zamknięta: nieznany zapis daje zarzut. W tych dwóch plikach test odrzuca też zapisy
 * YAML w nietypowej pisowni, bo chowają cały job albo wartość przed regułami AC-2 (`checkSecretFormats`: skalar blokowy poza
 * `run`/`if`/`sparse-checkout`, ucieczki, tagi, kotwice, spacja przed dwukropkiem; świadome rozszerzenie ponad precedens z PR-1,
 * decyzja koordynatora w #296). W pozostałych plikach te klasy zostają w granicy testu opisanej w #332.
 * Te reguły chronią przed pomyłką w zatwierdzonym kodzie, nie przed zmianą
 * workflow'u na gałęzi roboczej, która dostaje te same sekrety repozytorium (ryzyko zaakceptowane, wariant A). Test nie
 * dowodzi zachowania w runtime.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const readIn = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const read = rel => readIn(ROOT, rel);
/** Pliki YAML z listy nazw katalogu, posortowane (kolejność zwracana przez system plików nie jest gwarantowana). */
const workflowFiles = names => names.filter(f => /\.ya?ml$/.test(f)).sort();

const WORKFLOW_FILES = workflowFiles(fs.readdirSync(WORKFLOWS));
/**
 * Workflow'y z sekretami Apps Script (AC-2 #296): dozwolone wyzwalacze i kroki, które muszą poprzedzać zapis poświadczeń.
 * Krok z listy `before` rozpoznaje dokładna treść `run:` (cały blok po zdjęciu wcięcia), nie wzorzec: każda zmiana tej
 * treści w bash (warunek, `|| true`, podpowłoka, `trap`) daje zarzut.
 */
const NPM_CI = ['npm ci', 'npm ci --ignore-scripts'];
const TESTY_RUN = [
  'set -euo pipefail',
  'if [ -f scripts/quality/coverage-gate.js ]; then',
  '  npm run quality:gate -- --changed=none',
  'elif [ -d test ]; then',
  '  npm test',
  'else',
  '  echo "::warning::${DEPLOY_REF} has no tests or coverage gate; only lint ran."',
  'fi'
].join('\n');
const SEKRETNE = {
  'apps-script-drift.yml': { triggers: ['schedule', 'workflow_dispatch'], before: [NPM_CI], refs: ['main'] },
  'deploy-apps-script.yml': {
    triggers: ['release', 'workflow_dispatch'],
    before: [NPM_CI, ['lint', 'npm run lint'], ['testy', TESTY_RUN]],
    refs: ['${{ steps.ref.outputs.deploy_sha }}', '${{ steps.ref.outputs.tooling_sha }}']
  }
};
/** Nazwy checków wymaganych przez ochronę gałęzi i przez agregat jakości; zmiana nazwy joba je zrywa. */
const WYMAGANE_NAZWY = ['validate', 'secret-scan', 'quality-gate', 'pr-title', 'review-ack'];

/** Linia komentarza; `undefined` (brak linii nad pierwszą) nie jest komentarzem (RegExp.test rzutuje na tekst „undefined”). */
const isComment = line => /^\s*#/.test(line);
const withoutComments = text => text.split('\n').filter(l => !isComment(l)).join('\n');
const indentOf = line => line.length - line.trimStart().length;

/** Blok najwyższego poziomu `klucz:` (linie wcięte pod nim), bez samej linii klucza. */
function topBlock(text, key) {
  const lines = text.split('\n');
  const i = lines.findIndex(l => l === `${key}:` || l.startsWith(`${key}: `));
  if (i < 0) return null;
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (!(l === '' || /^\s/.test(l) || isComment(l))) break;
    out.push(l);
  }
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
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?(run|script):\s*(.*)/.exec(line);
    if (!m || isComment(line)) return;
    const indent = m[1].length + (line.trim().startsWith('- ') ? 2 : 0);
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim() !== '' && indentOf(lines[j]) <= indent) break;
    }
    ranges.push({ from: i, to: j, inline: m[3] });
  });
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
  for (const r of scriptRanges(lines)) lines.fill('', r.from + 1, r.to);
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
  // Test dzieli tekst po LF; parser YAML kończy linię też na samotnym CR, NEL, LS i PS (komentarz kończy się tam, gdzie test widzi jego dalszy ciąg).
  if (/\r(?!\n)|[\u0085\u2028\u2029]/.test(text)) bad.push(`${name}: znak końca linii inny niż LF (CR, NEL, LS, PS) nieobsługiwany przez test`);
  if (/^\s*(?:-\s+)?\?(?:\s|$)/m.test(code)) bad.push(`${name}: klucz jawny (? ...) nieobsługiwany przez test`);
  // Kontrole `uses` i `shell` czytają wartość z tej samej linii: wartość w następnej linii albo blok `|`/`>` omijałaby je.
  if (/^\s*(?:-\s+)?(?:uses|shell):\s*(?:[|>][+\-\d]*)?\s*(?:#.*)?$/m.test(code)) bad.push(`${name}: uses albo shell bez wartości w tej samej linii nieobsługiwane przez test`);
  // Ukośnik na końcu linii w cudzysłowie skleja linie YAML i mógłby rozciąć `${{` na dwie linie.
  if (/\\$/m.test(code)) bad.push(`${name}: ukośnik na końcu linii (ucieczka końca linii w cudzysłowie) nieobsługiwany przez test`);
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
  lines.forEach((line, i) => {
    const m = /^(\s*)permissions:\s*(.*)/.exec(line);
    if (!m || isComment(line)) return;
    const top = m[1].length === 0;
    // komentarz po wartości albo sam komentarz po `permissions:` (np. `permissions: # powód`) nie jest wartością
    const rest = m[2].replace(/(?:^|\s)#.*/, '').trim();
    if (rest) { found.push({ top, scalar: rest, line: i + 1 }); return; }
    const before = found.length;
    for (let j = i + 1; j < lines.length; j++) {
      // Pusta linia i komentarz między uprawnieniami nie kończą bloku.
      if (lines[j].trim() === '' || isComment(lines[j])) continue;
      if (indentOf(lines[j]) <= m[1].length) break;
      const p = /^(\s+)([a-z-]+):\s*["']?(read|write|none)["']?\s*(#.*)?$/.exec(lines[j]);
      if (!p) { found.push({ top, unsupported: lines[j].trim(), line: j + 1 }); continue; }
      // lines[j - 1] istnieje zawsze (j > i >= 0)
      const commented = Boolean(p[4]) || isComment(lines[j - 1]);
      found.push({ top, perm: p[2], value: p[3], commented, line: j + 1 });
    }
    // `permissions:` bez wartości i bez bloku (null) nie jest zapisem, który test umie ocenić
    if (found.length === before) found.push({ top, empty: true, line: i + 1 });
  });
  return found;
}

/** Uprawnienia zapisu tylko na poziomie joba, każde (poza `contents: read`) z komentarzem uzasadnienia. */
function checkPermissions(text, name) {
  const bad = [];
  for (const p of permissionLines(text)) {
    if (p.empty) bad.push(`${name}:${p.line}: permissions bez wartości i bez bloku`);
    else if (p.unsupported) bad.push(`${name}:${p.line}: nieobsługiwana linia uprawnień: ${p.unsupported}`);
    else if (p.scalar !== undefined) { if (p.scalar !== '{}') bad.push(`${name}:${p.line}: permissions: ${p.scalar} (dozwolone tylko blok albo {})`); }
    else {
      if (p.top && p.value === 'write') bad.push(`${name}:${p.line}: ${p.perm}: write na poziomie workflow`);
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
    const m = /^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(.*))?/.exec(line);
    if (!m || isComment(line) || m[1].startsWith('./')) return;
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(m[1])) bad.push(`${name}:${i + 1}: ${m[1]} nie jest przypięte do pełnego SHA`);
    else if (!/^v\d/.test(m[2])) bad.push(`${name}:${i + 1}: ${m[1]} bez komentarza wersji`);
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
  const block = topBlock(text, 'on');
  if (!block) return [];
  const body = block.filter(l => l.trim() !== '' && !isComment(l));
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
  const rules = lines.map(l => /^ {2}([a-z-]+):/.exec(l)).filter(Boolean).map(m => m[1]);
  if (rules.join() !== 'dangerous-triggers') bad.push(`zizmor.yml: reguły z wyjątkami: [${rules.join(', ')}], oczekiwano [dangerous-triggers]`);
  const entries = [];
  lines.forEach((l, i) => {
    const m = /^ {6}-\s+(\S+)/.exec(l);
    if (m) {
      entries.push(m[1]);
      if (!isComment(lines[i - 1])) bad.push(`zizmor.yml:${i + 1}: wpis ${m[1]} bez komentarza uzasadnienia nad nim`);
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
    const em = /^\s*(?:package-ecosystem:\s*|[\s\S]*?\n\s+package-ecosystem:\s*)(\S+)/.exec(e);
    const eco = em ? em[1] : undefined;
    const lines = e.split('\n');
    const at = lines.findIndex(l => /^ {4}cooldown:\s*$/.test(l));
    if (at < 0) { bad.push(`dependabot.yml: ${eco}: brak cooldown.default-days`); continue; }
    const block = lines.slice(at + 1).filter(l => l.trim() !== '').filter((l, i, all) => all.slice(0, i + 1).every(x => indentOf(x) > 4));
    // block[0] bywa undefined (cooldown bez treści): exec rzutuje to na tekst „undefined”, który nie pasuje do wzorca
    const days = /^ {6}default-days:\s*(\d+)\s*$/.exec(block[0]);
    if (!days) bad.push(`dependabot.yml: ${eco}: brak cooldown.default-days`);
    else if (Number(days[1]) < 7) bad.push(`dependabot.yml: ${eco}: cooldown.default-days=${days[1]} < 7`);
    if (days && block.length > 1) bad.push(`dependabot.yml: ${eco}: cooldown z dodatkowymi kluczami (${block.slice(1).map(l => l.trim()).join('; ')})`);
    if (!isComment(lines[at - 1])) bad.push(`dependabot.yml: ${eco}: cooldown bez komentarza nad wpisem`);
  }
  return bad;
}

/**
 * AC-2 pkt 1: sekrety Apps Script w zapisie z kropką. Nazwy sekretów i kontekstów GitHub nie rozróżniają wielkości liter.
 * Każdy inny zapis dostępu do sekretów (`secrets[...]`, `toJSON(secrets)`, `secrets.*`, `secrets: inherit`, ucieczka YAML
 * w nazwie, sekret spoza listy) jest odrzucany we wszystkich plikach (zamknięta lista, przegląd obejść #296).
 */
const SEKRET_APPS_SCRIPT = /\bsecrets\s*\.\s*(?:CLASPRC_JSON|APPS_SCRIPT_ID)\b/i;
const SEKRET_INNY_ZAPIS = /\bsecrets\b(?!\s*\.\s*(?:GITHUB_TOKEN|CLASPRC_JSON|APPS_SCRIPT_ID)\b)/i;

/** AC-2 pkt 1: do sekretów Apps Script sięgają wyłącznie workflow'y z listy SEKRETNE; sekrety tylko z zamkniętej listy nazw. */
function checkSecretUse(text, name) {
  const code = withoutComments(text);
  const bad = [];
  if (SEKRET_INNY_ZAPIS.test(code)) bad.push(`${name}: dostęp do sekretów inny niż secrets.GITHUB_TOKEN, secrets.CLASPRC_JSON i secrets.APPS_SCRIPT_ID`);
  if (!Object.keys(SEKRETNE).includes(name) && SEKRET_APPS_SCRIPT.test(code)) {
    bad.push(`${name}: odwołanie do sekretów Apps Script poza ${Object.keys(SEKRETNE).join(' i ')}`);
  }
  return bad;
}

/** Klucze, przy których workflow'y z sekretami mogą mieć skalar blokowy (treść bloku innego klucza podrabiałaby linie); `run` tylko `|`. */
const KLUCZE_BLOKOWE = ['run', 'if', 'sparse-checkout'];

/**
 * Zapisy YAML, które w workflow'ach z sekretami chowałyby job, krok albo wartość przed regułami AC-2 (przegląd obejść #296):
 * skalar blokowy poza KLUCZE_BLOKOWE, ucieczka `\x`/`\u`/`\U` w cudzysłowie, tag `!`, kotwica albo alias, klucz ze spacją
 * przed dwukropkiem, a także `run:` inny niż jedna linia albo blok `|` (`>` i zwykły skalar w kilku liniach sklejają linie
 * skryptu, więc polecenie po `set` nie wykona się). W tych dwóch plikach nie ma żadnego z tych zapisów, więc test je odrzuca
 * zamiast zgadywać.
 */
function checkSecretFormats(text, name) {
  const bad = [];
  const lines = text.split('\n');
  for (const r of scriptRanges(lines)) {
    const inline = r.inline.replace(/\s+#.*$/, '').trim();
    const more = lines.slice(r.from + 1, r.to).some(l => l.trim() !== '' && !isComment(l));
    if (/^[|>]/.test(inline) ? inline !== '|' : more) {
      bad.push(`${name}: run: tylko w jednej linii albo jako |: ${lines[r.from].trim().slice(0, 60)}`);
    }
  }
  for (const line of yamlOnly(text).split('\n')) {
    const block = /^\s*(?:-\s+)?([^\s:#][^:#]*?)\s*:\s*[|>][+\-\d]*\s*(?:#.*)?$/.exec(line);
    if (block && !KLUCZE_BLOKOWE.includes(block[1])) bad.push(`${name}: skalar blokowy przy kluczu ${block[1]} nieobsługiwany przez test`);
    if (/\\[xuU]/.test(line)) bad.push(`${name}: sekwencja ucieczki YAML (\\x, \\u, \\U) nieobsługiwana przez test: ${line.trim().slice(0, 60)}`);
    if (/(?:^\s*(?:-\s+)?|:\s+)[!&*]/.test(line)) bad.push(`${name}: tag, kotwica albo alias nieobsługiwane przez test: ${line.trim().slice(0, 60)}`);
    if (/^\s*(?:-\s+)?[\w.-]+\s+:(?:\s|$)/.test(line)) bad.push(`${name}: klucz ze spacją przed dwukropkiem nieobsługiwany przez test: ${line.trim().slice(0, 60)}`);
  }
  return bad;
}

/** AC-2 pkt 2: wyzwalacze workflow'u z sekretami wyłącznie z listy dozwolonych; każda linia bloku `on:` rozpoznana. */
function checkSecretTriggers(text, name, allowed) {
  const found = triggers(text);
  if (!found.length) return [`${name}: brak rozpoznanych wyzwalaczy`];
  // Rozpoznany wyzwalacz oznacza, że blok `on:` istnieje.
  const body = topBlock(text, 'on').filter(l => l.trim() !== '' && !isComment(l));
  const bad = found.filter(t => !allowed.includes(t)).map(t => `${name}: wyzwalacz ${t} poza dozwolonymi (${allowed.join(', ')})`);
  if (body.filter(l => indentOf(l) === indentOf(body[0])).length !== found.length) bad.push(`${name}: wyzwalacz w zapisie nieobsługiwanym przez test`);
  return bad;
}

/** Akcje dozwolone w jobach z sekretami (zamknięta lista). */
const AKCJE_W_JOBIE_Z_SEKRETAMI = ['actions/checkout', 'actions/setup-node', 'actions/upload-artifact'];
/** Jedyne wywołania npm w jobach z sekretami (dokładne linie poleceń, bez dopisków po nich). */
const NPM_W_JOBIE_Z_SEKRETAMI = ['npm ci --ignore-scripts', 'npm run lint', 'npm run quality:gate -- --changed=none', 'npm test'];
/** Jedyne wywołanie git w jobach z sekretami: tekst po nazwie polecenia (opcje globalne przed podpoleceniem też odrzucone). */
const GIT_W_JOBIE_Z_SEKRETAMI = /^\s+rev-parse\s/;
/** Jedyna linia z gh w jobach z sekretami: rozwiązanie refa do SHA w kroku walidacji (inny punkt API pobrałby kod). */
const GH_W_JOBIE_Z_SEKRETAMI = `resolve() { gh api "repos/$GITHUB_REPOSITORY/commits/refs/$1" --jq '.sha'; }`;

/**
 * AC-2 pkt 3 i AC-3: w jobie z sekretami tylko akcje z zamkniętej listy (bez cache i artefaktów do pobrania), setup-node
 * z `package-manager-cache: false`, npm wyłącznie w dokładnych poleceniach z listy (instalacja z `--ignore-scripts`),
 * npx tylko dla clasp i eslint, bez `continue-on-error`; git tylko jako `git rev-parse`, gh tylko w dokładnej linii z kroku walidacji,
 * `shell:` tylko `bash`, a `set` tylko `set -euo pipefail`, żeby porażka polecenia zatrzymywała krok; bez pliku zdarzenia
 * (`GITHUB_EVENT_PATH`, `github.event_path`), także przez `env:`.
 */
function checkSecretJobDeps(text, name) {
  const bad = [];
  const list = jobs(text);
  if (!list.length) bad.push(`${name}: brak rozpoznanych jobów`);
  for (const job of list) {
    const where = `${name}: job ${job.id}:`;
    for (const step of steps(job.text)) {
      const uses = /^\s*(?:-\s+)?uses:\s*([^@\s]+)/m.exec(step);
      if (!uses) continue;
      if (!AKCJE_W_JOBIE_Z_SEKRETAMI.includes(uses[1])) bad.push(`${where} akcja ${uses[1]} poza listą dozwolonych w jobie z sekretami`);
      if (uses[1] !== 'actions/setup-node') continue;
      const w = blockOf(step, 'with');
      if (w.some(l => /^\s*cache:/.test(l))) bad.push(`${where} setup-node z cache`);
      if (!w.some(l => /^\s*package-manager-cache:\s*false\s*(?:#.*)?$/.test(l))) bad.push(`${where} setup-node bez package-manager-cache: false`);
    }
    for (const line of withoutComments(job.text).split('\n')) {
      const cmd = line.replace(/^\s*(?:-\s+)?(?:run:\s*)?/, '').trimEnd();
      if (/\bnpm\b/.test(line) && !NPM_W_JOBIE_Z_SEKRETAMI.includes(cmd)) bad.push(`${where} npm poza listą dozwolonych poleceń: ${line.trim()}`);
      if (/\bnpx\s+(?!(?:clasp|eslint)\s)/.test(line)) bad.push(`${where} npx poza clasp i eslint: ${line.trim()}`);
      if (/^\s*(?:-\s+)?continue-on-error:/.test(line)) bad.push(`${where} continue-on-error w jobie z sekretami`);
      for (const m of line.matchAll(/(?:^|[\s(`'";&|])(git|gh)(?=\s|$)/g)) {
        if (m[1] === 'git' ? !GIT_W_JOBIE_Z_SEKRETAMI.test(line.slice(m.index + m[0].length)) : cmd !== GH_W_JOBIE_Z_SEKRETAMI) {
          bad.push(`${where} polecenie git/gh spoza listy (git rev-parse, gh api z kroku walidacji): ${line.trim()}`);
        }
      }
      if (/\bgithub\s*\.\s*event_path\b|\bGITHUB_EVENT_PATH\b/i.test(line)) bad.push(`${where} plik zdarzenia w jobie z sekretami: ${line.trim()}`);
      if (/^\s*(?:-\s+)?shell:/.test(line) && !/^\s*(?:-\s+)?shell:\s*bash\s*(?:#.*)?$/.test(line)) bad.push(`${where} shell inny niż bash: ${line.trim()}`);
      if (/(?:^|[\s;&|(])set\s+[-+]/.test(line) && cmd !== 'set -euo pipefail') bad.push(`${where} set inny niż set -euo pipefail: ${line.trim()}`);
    }
  }
  return bad;
}

/** Najbliższa wcześniejsza linia o mniejszym wcięciu (rodzic w YAML), z pominięciem pustych i komentarzy. */
function parentLine(lines, i) {
  return lines.slice(0, i).reverse().find(l => l.trim() !== '' && !isComment(l) && indentOf(l) < indentOf(lines[i]));
}

/**
 * Linia z wejściem: `inputs` w dowolnym zapisie, `github.event*`, `github.head_ref`, `github[...]`, plik zdarzenia, a w wyrażeniu
 * `${{ }}` także cały kontekst `github` (np. `toJSON(github)`).
 */
const WEJSCIE = /\binputs\b|\bgithub\s*(?:\.\s*(?:event|head_ref)\b|\[)|GITHUB_EVENT_PATH|\$\{\{[^}]*\bgithub\b(?!\s*\.\s*\w)/i;

/**
 * AC-2 pkt 4: checkout w jobie z sekretami tylko z refem z listy pliku (`refs` w SEKRETNE), bez `repository`; wejścia
 * tylko jako dane w `env:` i w warunkach `if:`. `persist-credentials: false` sprawdza reguła wspólna (checkCheckoutCredentials).
 */
function checkSecretJobRefs(text, name, refs) {
  const bad = [];
  for (const job of jobs(text)) {
    for (const step of steps(job.text)) {
      if (!/^\s*(?:-\s+)?uses:\s*actions\/checkout@/m.test(step)) continue;
      const w = blockOf(step, 'with');
      if (w.some(l => /^\s*repository:/.test(l))) bad.push(`${name}: job ${job.id}: checkout z repository`);
      if (!w.some(l => refs.includes((/^\s*ref:\s*(.*?)\s*$/.exec(l) || [])[1]))) bad.push(`${name}: job ${job.id}: checkout bez ref z listy (${refs.join(', ')})`);
    }
    const lines = job.text.split('\n');
    lines.forEach((line, i) => {
      if (isComment(line) || !WEJSCIE.test(line)) return;
      if (/^\s*(?:-\s+)?if:/.test(line) || /^\s*(?:-\s+)?(?:env|if):/.test(parentLine(lines, i))) return;
      bad.push(`${name}: job ${job.id}: wejście poza env i if: ${line.trim().slice(0, 60)}`);
    });
  }
  return bad;
}

/**
 * Treść `run:` kroku: wartość jednej linii albo blok `|` bez wspólnego wcięcia i bez końcowych pustych linii; linie komentarza
 * pominięte. `null`, gdy krok nie ma `run:`. Inne zapisy `run:` odrzuca checkSecretFormats.
 */
function runText(step) {
  const lines = withoutComments(step).split('\n');
  const i = lines.findIndex(l => /^\s*(?:-\s+)?run:/.test(l));
  if (i < 0) return null;
  const value = lines[i].replace(/^\s*(?:-\s+)?run:/, '').trim();
  if (!/^\|\s*(?:#.*)?$/.test(value)) return value;
  const keyIndent = lines[i].indexOf('run:');
  const body = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() !== '' && indentOf(l) <= keyIndent) break;
    body.push(l);
  }
  const first = body.find(l => l.trim() !== '');
  if (!first) return '';
  const cut = indentOf(first);
  return body.map(l => l.slice(cut).trimEnd()).join('\n').replace(/\n+$/, '');
}

/**
 * AC-2 pkt 6: sekret Apps Script wyłącznie w krokach (nie w `env:` workflow'u ani joba); kroki z listy poprzedzają pierwszy
 * krok z sekretem, rozpoznane po dokładnej treści `run:` i bez warunku `if:` (krok musi się wykonać); ostatni krok z `if: always()` usuwa
 * poświadczenia.
 */
function checkSecretStepOrder(text, name, before) {
  const bad = [];
  const inSteps = jobs(text).flatMap(job => steps(job.text)).join('\n');
  const count = t => withoutComments(t).split('\n').filter(l => SEKRET_APPS_SCRIPT.test(l)).length;
  if (count(text) !== count(inSteps)) bad.push(`${name}: sekret Apps Script poza krokami (env albo if workflow'u lub joba)`);
  for (const job of jobs(text)) {
    const list = steps(job.text);
    const cred = list.findIndex(s => SEKRET_APPS_SCRIPT.test(withoutComments(s)));
    if (cred < 0) { bad.push(`${name}: job ${job.id}: brak kroku z sekretami Apps Script`); continue; }
    for (const [label, re] of before) {
      const at = list.findIndex(s => runText(s) === re);
      if (at < 0 || at >= cred) bad.push(`${name}: job ${job.id}: ${label} nie poprzedza kroku z sekretami`);
      else if (/^\s*(?:-\s+)?if\s*:/m.test(yamlOnly(list[at]))) bad.push(`${name}: job ${job.id}: ${label} z warunkiem if: przed krokiem z sekretami`);
    }
    const last = list[list.length - 1];
    if (!/^\s*if:\s*always\(\)\s*$/m.test(last) || !/^\s*run:\s*rm -f "\$HOME\/\.clasprc\.json"/m.test(last)) {
      bad.push(`${name}: job ${job.id}: ostatni krok nie usuwa poświadczeń z if: always()`);
    }
  }
  return bad;
}

describe('workflow\'y: stan prawdziwych plików', () => {
  test('lista plików obejmuje oba workflow\'y z sekretami Apps Script', () => {
    assert.ok(WORKFLOW_FILES.length >= 10, `pliki: ${WORKFLOW_FILES.join(', ')}`);
    for (const f of Object.keys(SEKRETNE)) assert.ok(WORKFLOW_FILES.includes(f), `plik ${f} nie istnieje: zaktualizuj SEKRETNE`);
  });

  for (const f of WORKFLOW_FILES) {
    const text = read(`.github/workflows/${f}`);
    test(`${f}: brak wyrażeń \${{ }} w run/script/shell (wartości przez env)`, () => assert.deepEqual(checkNoExpressionsInScripts(text, f), []));
    test(`${f}: zapis uprawnień tylko na poziomie joba, każde uprawnienie z komentarzem`, () => assert.deepEqual(checkPermissions(text, f), []));
    test(`${f}: akcje przypięte do pełnego SHA z komentarzem wersji`, () => assert.deepEqual(checkPins(text, f), []));
    test(`${f}: checkout z persist-credentials: false w with`, () => assert.deepEqual(checkCheckoutCredentials(text, f), []));
    test(`${f}: każdy job ma nazwę równą id`, () => assert.deepEqual(checkJobNames(text, f), []));
    test(`${f}: concurrency`, () => assert.deepEqual(checkConcurrency(text, f), []));
    test(`${f}: tylko zapisy YAML obsługiwane przez test, uprawnienia na górze, bez komentarza zizmor: ignore`, () => {
      assert.deepEqual([...checkFormats(text, f), ...checkTopPermissions(text, f), ...checkNoInlineZizmorIgnore(text, f)], []);
    });
    test(`${f}: sekrety Apps Script tylko w workflow'ach z listy SEKRETNE (AC-2 pkt 1)`, () => assert.deepEqual(checkSecretUse(text, f), []));
  }

  for (const [f, rules] of Object.entries(SEKRETNE)) {
    const text = read(`.github/workflows/${f}`);
    test(`${f}: AC-2 pkt 2, 3, 4 i 6 (wyzwalacze, cache i instalacja, refy i wejścia, kolejność kroków)`, () => {
      assert.deepEqual([
        ...checkSecretTriggers(text, f, rules.triggers),
        ...checkSecretJobDeps(text, f),
        ...checkSecretFormats(text, f),
        ...checkSecretJobRefs(text, f, rules.refs),
        ...checkSecretStepOrder(text, f, rules.before)
      ], []);
    });
  }

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

describe('dokładne wyniki kontroli: komunikaty, numery linii, granice wcięć i kotwice wyrażeń (pomiar Stryker)', () => {
  const SHA = 'a'.repeat(40);
  const wf = body => `name: X\n\non:\n  push:\n\npermissions:\n  contents: read\n\n${body}`;
  const stepsOf = body => wf(`jobs:\n  a:\n    name: a\n    steps:\n${body}`);

  test('odczyt pliku, lista plików YAML i stałe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-'));
    try {
      fs.writeFileSync(path.join(dir, 'x.yml'), 'a\r\nb\r\n');
      assert.equal(readIn(dir, 'x.yml'), 'a\nb\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(workflowFiles(['b.yml', 'a.yaml', 'x.yml.bak', 'y.txt', 'c.yml']), ['a.yaml', 'b.yml', 'c.yml']);
    assert.deepEqual(WYMAGANE_NAZWY, ['validate', 'secret-scan', 'quality-gate', 'pr-title', 'review-ack']);
  });

  test('topBlock, jobs: granice bloku, linia złożona z samych spacji, tekst joba', () => {
    assert.deepEqual(topBlock('a:\n  x\nname: X\nb:\n', 'a'), ['  x']);
    assert.deepEqual(jobs('jobs:\n      \n  a:\n    name: a\n').map(j => j.id), ['a']);
    assert.equal(jobs('jobs:\n  a:\n    name: a\n')[0].text, '  a:\n    name: a\n');
  });

  test('steps: kotwice klucza steps, komentarz po kluczu, linie puste i komentarze, krok niezależny od cudzych wcięć', () => {
    assert.equal(steps('    # steps:\n    steps:\n      - name: a\n').length, 1);
    assert.deepEqual(steps('    steps: &x\n      - name: a\n'), []);
    assert.equal(steps('    steps:  # komentarz\n      - name: a\n').length, 1);
    assert.deepEqual(steps('    name: x\n    - a\n'), []);
    assert.equal(steps('    steps:\n   \n      - name: a\n').length, 1);
    assert.equal(steps('    steps:\n      - name: a\n  \n      - name: b\n').length, 2);
    assert.equal(steps('    steps:\n      - name: a\n        # c\n        run: x\n')[0].includes('# c'), true);
    assert.deepEqual(steps('    steps:\n      foo: 1\n'), []);
    const odd = steps('    steps:\n      - name: a\n    - other\n');
    assert.equal(odd.length, 1);
    assert.doesNotMatch(odd[0], /other/);
    assert.equal(steps('    steps:\n      - name: a\n      weird: 1\n').length, 1);
  });

  test('blockOf: klucz w pierwszej linii, klucz z myślnikiem, linia ze samych spacji w bloku', () => {
    assert.deepEqual(blockOf('with:\n  a: 1\n', 'with'), ['  a: 1', '']);
    assert.deepEqual(blockOf('      - env:\n          A: 1\n        run: x\n', 'env'), ['          A: 1']);
    assert.deepEqual(blockOf('      - uses: x\n        with:\n          a: 1\n  \n          b: 2\n        env:\n', 'with').map(l => l.trim()).filter(Boolean), ['a: 1', 'b: 2']);
  });

  test('skrypty run/script: kotwice, myślnik przy kluczu, linie ze samych spacji, komunikaty', () => {
    assert.deepEqual(checkNoExpressionsInScripts('      - name: rerun: ${{ github.sha }}\n', 'f'), []);
    assert.deepEqual(checkNoExpressionsInScripts('      - run: echo x\n        env:\n          T: ${{ github.sha }}\n', 'f'), []);
    assert.equal(checkNoExpressionsInScripts('      - name: s\n        run: |\n          echo a\n  \n          echo ${{ github.sha }}\n', 'f').length, 1);
    assert.equal(checkNoExpressionsInScripts('        run:\n          echo ${{ github.sha }}\n', 'f').length, 1);
    assert.equal(checkNoExpressionsInScripts('        run:${{ github.sha }}\n', 'f').length, 1);
    assert.deepEqual(checkNoExpressionsInScripts('      - run: |\n          echo "${{ github.sha }}"\n', 'f'), ['f: wyrażenie ${{ }} w skrypcie run/script: |']);
    assert.deepEqual(checkNoExpressionsInScripts('        run:\n          echo ${{ github.sha }}\n', 'f'), ['f: wyrażenie ${{ }} w skrypcie run/script: echo ${{ github.sha }}']);
    const inline = `echo ${'x'.repeat(80)} \${{ github.sha }}`;
    assert.deepEqual(checkNoExpressionsInScripts(`      - run: ${inline}\n`, 'f'), [`f: wyrażenie \${{ }} w skrypcie run/script: ${inline.slice(0, 60)}`]);
    assert.deepEqual(checkNoExpressionsInScripts('      - name: bashshell: ${{ github.sha }}\n', 'f'), []);
    const shell = `shell: bash ${'x'.repeat(70)} \${{ github.sha }}`;
    assert.deepEqual(checkNoExpressionsInScripts(`        ${shell}\n`, 'f'), [`f: wyrażenie \${{ }} w shell: ${shell.slice(0, 60)}`]);
  });

  test('yamlOnly: skrypt zastąpiony pustymi liniami, komentarze usunięte', () => {
    assert.equal(yamlOnly('a:\n  run:\n    echo x\n# c\n'), 'a:\n  run:\n\n');
    // `:\s+` obejmuje puste linie po wyczyszczonym skrypcie: mapa flow w następnej linii jest widoczna
    assert.equal(checkFormats('a:\n  run:\n    echo x\n{ b: 1 }\n', 'f').length, 1);
    // komentarz z zapisem nieobsługiwanym nie jest zarzutem
    assert.deepEqual(checkFormats('a: 1\n# - { b }\n# "k": 1\n# <<: *x\n', 'f'), []);
  });

  test('checkFormats: dokładne komunikaty i granice rozpoznania', () => {
    assert.deepEqual(checkFormats('jobs:\n\ta: 1\n', 'f'), ['f: tabulator w YAML']);
    assert.deepEqual(checkFormats('x:\n  - { a: 1 }\n', 'f'), ['f: mapa w stylu flow ({ ... }) nieobsługiwana przez test']);
    assert.deepEqual(checkFormats('x:\n  "uses": x\n', 'f'), ['f: klucz w cudzysłowie nieobsługiwany przez test']);
    assert.deepEqual(checkFormats('  env: &e\n', 'f'), ['f: kotwica, alias albo merge key nieobsługiwane przez test']);
    assert.deepEqual(checkFormats('x: "\\u0024{{"\n', 'f'), ['f: znak $ zapisany sekwencją ucieczki YAML (ukryte wyrażenie)']);
    assert.deepEqual(checkFormats('on: push\n', 'f'), ['f: wyzwalacze w formie skróconej (on: ...) nieobsługiwane przez test']);
    // zapis w środku tekstu nie jest składnią YAML
    assert.deepEqual(checkFormats('name: x - { y }\n', 'f'), []);
    assert.deepEqual(checkFormats('name: say "hi": there\n', 'f'), []);
    assert.deepEqual(checkFormats('name: a&b\n', 'f'), []);
    assert.deepEqual(checkFormats('cat&dog\n', 'f'), []);
    assert.deepEqual(checkFormats('a<<: b\n', 'f'), []);
    // wielokrotne odstępy też są składnią
    assert.equal(checkFormats('x:\n  -  { a: 1 }\n', 'f').length, 1);
    assert.equal(checkFormats('key:  { a: 1 }\n', 'f').length, 1);
    assert.equal(checkFormats('x:\n  -  "uses": x\n', 'f').length, 1);
    assert.equal(checkFormats('x:\n  "uses" : x\n', 'f').length, 1);
    assert.equal(checkFormats('*alias\n', 'f').length, 1);
    assert.equal(checkFormats('k:  &a\n', 'f').length, 1);
    assert.equal(checkFormats('x:\n  -  *a\n', 'f').length, 1);
    assert.equal(checkFormats('x:\n  - *a\n', 'f').length, 1);
    assert.equal(checkFormats('<<: x\n', 'f').length, 1);
    assert.equal(checkFormats('<<  : x\n', 'f').length, 1);
    assert.equal(checkFormats('<< : x\n', 'f').length, 1);
    assert.equal(checkFormats('on:  push\n', 'f').length, 1);
  });

  test('uprawnienia: komunikaty z numerem linii, komentarz po permissions, cudzysłowy, odstępy, linia ze samych spacji', () => {
    assert.deepEqual(checkPermissions('permissions:\n  issues: write extra\n', 'f'), ['f:2: nieobsługiwana linia uprawnień: issues: write extra']);
    assert.deepEqual(checkPermissions('permissions:\n  foo bar: read\n', 'f'), ['f:2: nieobsługiwana linia uprawnień: foo bar: read']);
    assert.deepEqual(checkPermissions('name: X\n\npermissions: write-all\n', 'f'), ['f:3: permissions: write-all (dozwolone tylko blok albo {})']);
    assert.deepEqual(checkPermissions('permissions: write-all # powód\n', 'f'), ['f:1: permissions: write-all (dozwolone tylko blok albo {})']);
    assert.deepEqual(checkPermissions('permissions: write-all # powód\r\n', 'f'), ['f:1: permissions: write-all (dozwolone tylko blok albo {})']);
    assert.deepEqual(checkPermissions('permissions: # powód\n  contents: read\n', 'f'), []);
    assert.deepEqual(checkPermissions('      - name: set permissions: write\n', 'f'), []);
    assert.deepEqual(checkPermissions('permissions:\n  contents:  read\n', 'f'), []);
    assert.deepEqual(checkPermissions('permissions:\n  contents: "read"\n', 'f'), []);
    assert.deepEqual(checkPermissions('permissions:\n  contents: \'read\'\n', 'f'), []);
    assert.deepEqual(checkPermissions('jobs:\n  a:\n    permissions:\n      contents: write\n', 'f'), ['f:4: contents: write bez komentarza uzasadnienia']);
    assert.deepEqual(checkPermissions('jobs:\n  a:\n    permissions:\n      contents: read\n  \n      actions: write\n', 'f'), ['f:6: actions: write bez komentarza uzasadnienia']);
    assert.deepEqual(checkTopPermissions('name: X\n', 'f'), ['f: brak permissions na poziomie workflow']);
  });

  test('akcje: kotwice i odstępy w wierszu uses, komunikaty z numerem linii', () => {
    assert.deepEqual(checkPins('a: 1\nb: 2\n      - uses: actions/checkout@v7\n', 'f'), ['f:3: actions/checkout@v7 nie jest przypięte do pełnego SHA']);
    assert.deepEqual(checkPins(`a: 1\n      - uses: x/y@${SHA}\n`, 'f'), [`f:2: x/y@${SHA} bez komentarza wersji`]);
    assert.deepEqual(checkPins(`      - uses: x/y@${SHA} # pin v7\n`, 'f'), [`f:1: x/y@${SHA} bez komentarza wersji`]);
    assert.equal(checkPins('        uses: actions/checkout@v7\n', 'f').length, 1);
    assert.equal(checkPins('      -  uses: a/b@main\n', 'f').length, 1);
    assert.equal(checkPins('      - uses:actions/checkout@v7\n', 'f').length, 1);
    assert.equal(checkPins(`      - uses: x/y@${SHA}a # v7\n`, 'f').length, 1);
    assert.equal(checkPins(`      - uses: !x/a@${SHA} # v7\n`, 'f').length, 1);
    assert.equal(checkPins(`      - uses: x/y@${SHA} # v7 extra\n`, 'f').length, 0);
    assert.equal(checkPins('      - uses: a/b@main extra\n', 'f').length, 1);
    assert.deepEqual(checkPins(`      - uses: x/y@${SHA}  # v7\n`, 'f'), []);
    assert.deepEqual(checkPins(`      - uses: x/y@${SHA} #v7\n`, 'f'), []);
    assert.deepEqual(checkPins('      - name: reuses: x/y@main\n', 'f'), []);
  });

  test('checkout: komunikaty, kotwice wyrażeń, odstępy w persist-credentials', () => {
    const co = body => stepsOf(`      - uses: actions/checkout@${SHA} # v7\n${body}`);
    assert.deepEqual(checkCheckoutCredentials(co(''), 'f'), ['f: job a: checkout bez persist-credentials: false w with']);
    assert.deepEqual(checkCheckoutCredentials(wf(`uses: actions/checkout@${SHA} # v7\n`), 'f'), ['f: checkout w pliku bez rozpoznanych jobów']);
    assert.deepEqual(checkCheckoutCredentials(stepsOf('      - run: echo "uses: actions/checkout@v7"\n'), 'f'), []);
    assert.equal(checkCheckoutCredentials(stepsOf(`      - uses:actions/checkout@${SHA} # v7\n`), 'f').length, 1);
    const ok = v => checkCheckoutCredentials(co(`        with:\n          persist-credentials: ${v}\n`), 'f');
    assert.deepEqual(ok('false # powód'), []);
    assert.deepEqual(ok('false   '), []);
    assert.deepEqual(ok(' false'), []);
    assert.equal(ok('falsey').length, 1);
    assert.equal(checkCheckoutCredentials(co('        with:\n          not-persist-credentials: false\n'), 'f').length, 1);
  });

  test('nazwy jobów, concurrency, wyzwalacze: komunikaty i granice', () => {
    assert.deepEqual(checkJobNames(wf('jobs:\n  a:\n    runs-on: x\n'), 'f'), ['f: job a bez name']);
    assert.deepEqual(checkConcurrency(wf('jobs:\n  a:\n    name: a\n'), 'f'), ['f: brak concurrency']);
    assert.deepEqual(triggers('on:\n   \n  push:\n  issues:\n'), ['push', 'issues']);
    assert.deepEqual(triggers('on:\n  push:\n  FOO: 1\n'), ['push']);
    assert.deepEqual(triggers('on:\n  push:\n  x-y: 1\n'), ['push']);
  });

  test('checkNoPrCode: dokładne komunikaty, odstępy w wzorcach, kotwice kroku checkout', () => {
    const run = r => checkNoPrCode(`      - run: ${r}\n`, 'g.yml');
    assert.deepEqual(run('echo ${{ github.head_ref }}'), ['g.yml: odwołanie do github.head_ref']);
    assert.deepEqual(run('echo ${{ github.event.pull_request.merge_commit_sha }}'), ['g.yml: odwołanie do merge_commit_sha']);
    assert.deepEqual(run('echo ${{ github.event.pull_request[ \'head\'].sha }}'), ['g.yml: odwołanie do github.event.pull_request.head']);
    assert.deepEqual(run('gh pr checkout "$PR"'), ['g.yml: gh pr checkout']);
    assert.deepEqual(run('gh  pr checkout "$PR"'), ['g.yml: gh pr checkout']);
    assert.deepEqual(run('gh pr  checkout "$PR"'), ['g.yml: gh pr checkout']);
    assert.deepEqual(run('git fetch origin x'), ['g.yml: polecenie git pobierające albo przełączające kod']);
    assert.deepEqual(run('git  fetch origin x'), ['g.yml: polecenie git pobierające albo przełączające kod']);
    assert.deepEqual(checkNoPrCode(`      - uses: actions/download-artifact@${SHA} # v5\n`, 'g.yml'), ['g.yml: download-artifact (artefakty PR są niezaufane)']);
    const co = (uses, extra) => stepsOf(`      - name: c\n        ${uses}\n${extra}`);
    assert.deepEqual(checkNoPrCode(co(`uses: actions/checkout@${SHA} # v7`, '        with:\n          ref: main\n'), 'g.yml'), ['g.yml: job a: checkout z ref/repository']);
    assert.deepEqual(checkNoPrCode(stepsOf(`      - uses:actions/checkout@${SHA} # v7\n        with:\n          ref: main\n`), 'g.yml'), ['g.yml: job a: checkout z ref/repository']);
    assert.deepEqual(checkNoPrCode(stepsOf('      - name: t\n        run: echo uses: actions/checkout@x\n        with:\n          ref: x\n'), 'g.yml'), []);
    assert.deepEqual(checkNoPrCode(co(`uses: actions/checkout@${SHA} # v7`, '        with:\n          xref: abc\n'), 'g.yml'), []);
  });

  test('zizmor: komunikaty, odstępy, kolejność wpisów, wpisy zagnieżdżone, disable w komentarzu', () => {
    assert.deepEqual(checkNoInlineZizmorIgnore('      - uses: x # zizmor: ignore[unpinned-uses]\n', 'f'), ['f: komentarz zizmor: ignore poza .github/zizmor.yml']);
    assert.equal(checkNoInlineZizmorIgnore('      - uses: x # zizmor:  ignore[unpinned-uses]\n', 'f').length, 1);
    const ok = 'rules:\n  dangerous-triggers:\n    ignore:\n      # powód 1\n      - issue-audit.yml\n      # powód 2\n      - review-gate.yml\n';
    assert.ok(checkZizmorConfig(ok + '\t\n').includes('zizmor.yml: tabulator w YAML'));
    assert.deepEqual(checkZizmorConfig(ok.replace('  dangerous-triggers:', '  dangerous-triggers: ')), []);
    assert.equal(checkZizmorConfig(ok + '  other-rule: x\n').length, 1);
    assert.deepEqual(checkZizmorConfig(ok.replace('      - review-gate.yml\n', '      - review-gate.yml\n        - nested.yml\n')), []);
    assert.deepEqual(checkZizmorConfig(ok.replace('      - issue-audit.yml', '      -  issue-audit.yml')), []);
    assert.deepEqual(checkZizmorConfig('rules:\n  dangerous-triggers:\n    ignore:\n      # powód 2\n      - review-gate.yml\n      # powód 1\n      - issue-audit.yml\n'), []);
    assert.deepEqual(checkZizmorConfig(ok.replace('    ignore:', '    ignore:  # disable: tymczasowo')), []);
    assert.deepEqual(checkZizmorConfig(ok.replace('      # powód 2\n', '')), ['zizmor.yml:6: wpis review-gate.yml bez komentarza uzasadnienia nad nim']);
  });

  test('dependabot: komunikaty, granice wpisów, odstępy, wcięcia cooldown, puste linie, wpis zaczynający się od cooldown', () => {
    const entry = cool => `version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n${cool}    schedule:\n      interval: weekly\n`;
    const good = '    # powód\n    cooldown:\n      default-days: 7\n';
    assert.deepEqual(checkDependabot('version: 2\n'), ['dependabot.yml: brak wpisów updates']);
    assert.deepEqual(checkDependabot(entry(good).replace('interval: weekly', 'interval: weekly  - x')), []);
    assert.deepEqual(checkDependabot('version: 2\nupdates:\n  - directory: / # package-ecosystem: y\n    schedule:\n      interval: weekly\n'), ['dependabot.yml: undefined: brak cooldown.default-days']);
    const low = '    # powód\n    cooldown:\n      default-days: 3\n';
    assert.deepEqual(checkDependabot(entry(low).replace('package-ecosystem: npm', 'package-ecosystem:  npm')), ['dependabot.yml: npm: cooldown.default-days=3 < 7']);
    assert.deepEqual(checkDependabot(`version: 2\nupdates:\n  - directory: /\n    package-ecosystem:  npm\n${low}`), ['dependabot.yml: npm: cooldown.default-days=3 < 7']);
    // cooldown w złym miejscu (za głęboko) albo z wartością w tej samej linii nie jest cooldownem wpisu
    assert.deepEqual(checkDependabot(entry('    schedule2:\n        cooldown:\n          default-days: 9\n')), ['dependabot.yml: npm: brak cooldown.default-days']);
    assert.deepEqual(checkDependabot(entry('    cooldown: x\n')), ['dependabot.yml: npm: brak cooldown.default-days']);
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown: \n      default-days: 7\n')), []);
    // default-days: wcięcie, wartość, odstępy
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n        default-days: 9\n')), ['dependabot.yml: npm: brak cooldown.default-days']);
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 9 dni\n')), ['dependabot.yml: npm: brak cooldown.default-days']);
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n      default-days:  9\n')), []);
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 10\n')), []);
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 9 \n')), []);
    // puste linie (także ze spacjami) w bloku nie przerywają go
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n\n      default-days: 7\n')), []);
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n   \n      default-days: 7\n')), []);
    assert.deepEqual(checkDependabot(entry('    # powód\n    cooldown:\n      default-days: 7\n      a: 1\n      b: 2\n')), ['dependabot.yml: npm: cooldown z dodatkowymi kluczami (a: 1; b: 2)']);
    // wpis zaczynający się od cooldown: brak linii nad nim, więc brak komentarza
    assert.deepEqual(checkDependabot('version: 2\nupdates:\n  -     cooldown:\n      default-days: 7\n    package-ecosystem: npm\n'), ['dependabot.yml: npm: cooldown bez komentarza nad wpisem']);
    // bez cooldown nie ma bloku, nawet gdy pierwsze linie wpisu wyglądają jak jego treść
    assert.deepEqual(checkDependabot('updates:\n  - \n      default-days: 9\n    package-ecosystem: npm\n'), ['dependabot.yml: npm: brak cooldown.default-days']);
  });

  test('uzupełnienia po pomiarze: wartość bez spacji po dwukropku, spacje na końcu, wpis w pierwszej linii, wpis z dodatkowymi spacjami', () => {
    assert.deepEqual(checkPermissions('permissions:write-all\n', 'f'), ['f:1: permissions: write-all (dozwolone tylko blok albo {})']);
    assert.deepEqual(checkPermissions('permissions: write-all  \n', 'f'), ['f:1: permissions: write-all (dozwolone tylko blok albo {})']);
    assert.deepEqual(checkZizmorConfig('      - a.yml\n').filter(x => /wpis/.test(x)), ['zizmor.yml:1: wpis a.yml bez komentarza uzasadnienia nad nim']);
    assert.ok(checkDependabot('\tx\n').includes('dependabot.yml: tabulator w YAML'));
    assert.deepEqual(checkDependabot('version: 2\nupdates:\n  -     package-ecosystem: npm\n    # powód\n    cooldown:\n      default-days: 3\n'), ['dependabot.yml: npm: cooldown.default-days=3 < 7']);
    assert.deepEqual(triggers('name: X\n\non:\n\npermissions:\n  contents: read\n'), []);
  });

  test('obejścia z przeglądu: końce linii inne niż LF, klucz jawny, uses i shell w następnej linii, ukośnik na końcu linii, puste permissions', () => {
    const eol = 'f: znak końca linii inny niż LF (CR, NEL, LS, PS) nieobsługiwany przez test';
    assert.deepEqual(checkFormats('a: 1\r# komentarz\rissues: write\n', 'f'), [eol]);
    assert.deepEqual(checkFormats('a: 1\u0085b\n', 'f'), [eol]);
    assert.deepEqual(checkFormats('a: 1\u2028b\n', 'f'), [eol]);
    assert.deepEqual(checkFormats('a: 1\u2029b\n', 'f'), [eol]);
    assert.deepEqual(checkFormats('a: 1\r\nb: 2\r\n', 'f'), []);
    assert.deepEqual(checkZizmorConfig('rules:\n  dangerous-triggers:\n    ignore:\n      # p\n      - review-gate.yml\r      - ci.yml\n').filter(x => /końca linii/.test(x)), [eol.replace('f:', 'zizmor.yml:')]);
    const key = 'f: klucz jawny (? ...) nieobsługiwany przez test';
    assert.deepEqual(checkFormats('jobs:\n  a:\n    steps:\n      - ? run\n        : echo\n', 'f'), [key]);
    assert.deepEqual(checkFormats('a:\n  ? uses\n  : x\n', 'f'), [key]);
    assert.deepEqual(checkFormats('a:\n  ?\n', 'f'), [key]);
    assert.deepEqual(checkFormats('a: ?x\nname: what?\n', 'f'), []);
    const val = 'f: uses albo shell bez wartości w tej samej linii nieobsługiwane przez test';
    assert.deepEqual(checkFormats('steps:\n  - uses:\n      actions/setup-node@v4\n', 'f'), [val]);
    assert.deepEqual(checkFormats('steps:\n  - uses:  # komentarz\n      x/y@v1\n', 'f'), [val]);
    assert.deepEqual(checkFormats('steps:\n  - shell: >-\n      bash -c "${{ github.event.issue.title }}"\n', 'f'), [val]);
    assert.deepEqual(checkFormats('steps:\n  - shell: |2+\n      bash\n', 'f'), [val]);
    assert.deepEqual(checkFormats('steps:\n  - uses: x/y@v1\n    shell: bash\n', 'f'), []);
    const bs = 'f: ukośnik na końcu linii (ucieczka końca linii w cudzysłowie) nieobsługiwany przez test';
    assert.deepEqual(checkFormats('steps:\n  - run: "echo $\\\n      {{ github.event.issue.title }}"\n', 'f'), [bs]);
    assert.deepEqual(checkFormats('steps:\n  - run: |\n      echo a \\\n      echo b\n', 'f'), []);
    assert.deepEqual(checkFormats('a: b\\c\n', 'f'), []);
    assert.deepEqual(checkPermissions('permissions:\n', 'f'), ['f:1: permissions bez wartości i bez bloku']);
    assert.deepEqual(checkPermissions('jobs:\n  a:\n    permissions: # powód\n    steps: []\n', 'f'), ['f:3: permissions bez wartości i bez bloku']);
    assert.deepEqual(checkPermissions('permissions:\n  # tylko komentarz\n', 'f'), ['f:1: permissions bez wartości i bez bloku']);
    assert.deepEqual(checkPermissions('permissions:\n  contents: read\n', 'f'), []);
  });

  test('obejścia z przeglądu: granice wzorców (odstępy po myślniku, koniec tekstu, kotwica początku, klucz bez myślnika)', () => {
    const key = 'f: klucz jawny (? ...) nieobsługiwany przez test';
    const val = 'f: uses albo shell bez wartości w tej samej linii nieobsługiwane przez test';
    assert.deepEqual(checkFormats('steps:\n  -  ? run\n', 'f'), [key]);
    assert.deepEqual(checkFormats('a:\n  ?', 'f'), [key]);
    assert.deepEqual(checkFormats('name: reuses:\n', 'f'), []);
    assert.deepEqual(checkFormats('steps:\n  - name: a\n    uses:\n      x/y@v1\n', 'f'), [val]);
    assert.deepEqual(checkFormats('steps:\n  -  uses:\n      x/y@v1\n', 'f'), [val]);
  });
});

describe('AC-2: kontrole ujemne reguł dla workflow\'ów z sekretami Apps Script', () => {
  const SHA = 'a'.repeat(40);
  const DEPLOY = SEKRETNE['deploy-apps-script.yml'];
  const DEPLOY_SHA = '${{ steps.ref.outputs.deploy_sha }}';
  const TOOLING_SHA = '${{ steps.ref.outputs.tooling_sha }}';
  const GOOD = [
    'name: X', '', 'on:', '  # komentarz w bloku on', '  release:', '    types: [published]', '', '  workflow_dispatch:', '',
    'permissions:', '  contents: read', '', 'jobs:', '  push:', '    name: push', '    if: >-',
    "      (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||",
    "      (github.event_name == 'release' && github.event.release.prerelease == false)",
    '    env:', '      DEPLOY_REF: ${{ inputs.deploy_ref }}', '', '      # komentarz w env', '      TAG: ${{ github.event.release.tag_name }}',
    '    steps:',
    '      - name: Ref', '        id: ref', '        env:', '          X: ${{ inputs.deploy_ref }}', '        run: echo ok',
    '      - name: Checkout', `        uses: actions/checkout@${SHA} # v7`, '        with:', `          ref: ${DEPLOY_SHA}`, '          persist-credentials: false',
    '      - name: Tooling', `        uses: actions/checkout@${SHA} # v7`, '        with:', `          ref: ${TOOLING_SHA}`, '          persist-credentials: false',
    '          sparse-checkout: |', '            scripts/a.js',
    '      - name: Node', `        uses: actions/setup-node@${SHA} # v7`, '        with:', '          node-version: 22', '          package-manager-cache: false # powód',
    '      - name: Install', '        run: npm ci --ignore-scripts',
    '      - name: Lint', '        run: npm run lint',
    '      - name: Tests', '        run: |', ...TESTY_RUN.split('\n').map(l => `          ${l}`),
    '      - name: Creds', '        env:', '          CLASPRC_JSON: ${{ secrets.CLASPRC_JSON }}', '        run: npx clasp --version',
    '      - name: Remove credentials', '        if: always()', '        run: rm -f "$HOME/.clasprc.json" .clasp.json', ''
  ].join('\n');
  const TESTS = `      - name: Tests\n        run: |\n${TESTY_RUN.split('\n').map(l => `          ${l}\n`).join('')}`;
  const swap = (a, b) => {
    assert.ok(GOOD.includes(a), `fixture zawiera ${a}`);
    return GOOD.replace(a, b);
  };
  /** Dodatkowy krok przed krokiem Lint. */
  const step = body => swap('      - name: Lint\n', `${body}\n      - name: Lint\n`);
  const job = 'f: job push: ';
  const all = text => [
    ...checkSecretTriggers(text, 'f', DEPLOY.triggers), ...checkSecretFormats(text, 'f'), ...checkSecretJobDeps(text, 'f'),
    ...checkSecretJobRefs(text, 'f', DEPLOY.refs), ...checkSecretStepOrder(text, 'f', DEPLOY.before)
  ];

  test('wzorcowy workflow z sekretami przechodzi wszystkie reguły', () => {
    assert.deepEqual(all(GOOD), []);
    assert.deepEqual(checkSecretUse(GOOD, 'deploy-apps-script.yml'), []);
    assert.deepEqual(checkSecretUse(GOOD, 'apps-script-drift.yml'), []);
  });

  test('pkt 1: sekret Apps Script poza listą SEKRETNE; każdy zapis dostępu do sekretów poza secrets.NAZWA z listy', () => {
    const poza = 'ci.yml: odwołanie do sekretów Apps Script poza apps-script-drift.yml i deploy-apps-script.yml';
    const inny = 'ci.yml: dostęp do sekretów inny niż secrets.GITHUB_TOKEN, secrets.CLASPRC_JSON i secrets.APPS_SCRIPT_ID';
    assert.deepEqual(checkSecretUse(GOOD, 'ci.yml'), [poza]);
    for (const ref of ['SECRETS.clasprc_json', 'secrets . APPS_SCRIPT_ID', 'secrets.\nAPPS_SCRIPT_ID']) {
      assert.deepEqual(checkSecretUse(`a: \${{ ${ref} }}\n`, 'ci.yml'), [poza], ref);
    }
    for (const ref of ["secrets['CLASPRC_JSON']", 'toJSON(secrets)', "toJSON(secrets || '')", 'toJSON(secrets.*)', 'secrets.\\x43LASPRC_JSON',
      'secrets.CLASPRC_JSONX', 'secrets.OTHER', 'secrets . GITHUB_TOKENX', 'secrets']) {
      assert.deepEqual(checkSecretUse(`a: \${{ ${ref} }}\n`, 'ci.yml'), [inny], ref);
    }
    for (const t of ['jobs:\n  a:\n    secrets: inherit\n', "    secrets: 'inherit'\n", '    secrets: !!str inherit\n', 'secrets:\n']) {
      assert.deepEqual(checkSecretUse(t, 'ci.yml'), [inny], t);
    }
    assert.deepEqual(checkSecretUse('a: ${{ toJSON(secrets) }}\n', 'deploy-apps-script.yml'),
      ['deploy-apps-script.yml: dostęp do sekretów inny niż secrets.GITHUB_TOKEN, secrets.CLASPRC_JSON i secrets.APPS_SCRIPT_ID']);
    for (const ok of ['a: ${{ secrets.GITHUB_TOKEN }}', 'a: ${{ Secrets . github_token }}', '# ${{ secrets.CLASPRC_JSON }}', 'a: ${{ mysecrets.X }}', 'secretsx: 1']) {
      assert.deepEqual(checkSecretUse(`${ok}\n`, 'ci.yml'), [], ok);
    }
  });

  test('zapisy YAML w workflow\'ach z sekretami: skalar blokowy poza run/if/sparse-checkout, ucieczki, tagi, kotwice, spacja przed dwukropkiem', () => {
    for (const ok of ['      - run: |\n          printf "\\x41 & *"\n', '    if: >-\n', '          sparse-checkout:  |  # c\n', '  - if: |+2\n',
      '    x: a&b*c!\n', '    a: b : c\n', '    x: "\\n"\n', '# x: !tag\n']) {
      assert.deepEqual(checkSecretFormats(ok, 'f'), [], ok);
    }
    for (const [t, key] of [['          ssh-known-hosts: |\n', 'ssh-known-hosts'], ['      NOTE: >-\n', 'NOTE'], ['      - script: |\n', 'script'],
      ['      - name: |-\n', 'name'], ['          scope: >2 # c\n', 'scope'], ['  runx: |\n', 'runx']]) {
      assert.deepEqual(checkSecretFormats(t, 'f'), [`f: skalar blokowy przy kluczu ${key} nieobsługiwany przez test`], t);
    }
    const runForm = t => `f: run: tylko w jednej linii albo jako |: ${t}`;
    for (const [t, line] of [
      ['        run: >\n          a\n', 'run: >'], ['        run: >-\n          a\n', 'run: >-'], ['        run: |-\n          a\n', 'run: |-'],
      ['        run: |2\n          a\n', 'run: |2'], ['      - run: >\n          a\n', '- run: >'],
      ['        run: set -euo pipefail\n          npm test\n', 'run: set -euo pipefail'], ['        run:\n          npm test\n', 'run:'],
      ['        run: "a\n          b"\n', 'run: "a'], ['        run: a\n\n          b\n', 'run: a']
    ]) {
      assert.deepEqual(checkSecretFormats(t, 'f'), [runForm(line)], t);
    }
    for (const ok of ['        run: |\n          a\n', '        run: | # c\n          a\n', '        run: a\n          # c\n', '        run: a\n\n', '        run:\n',
      '        run: a\n        if: b\n', '      - run: a\n        name: b\n']) {
      assert.deepEqual(checkSecretFormats(ok, 'f'), [], ok);
    }
    const long = `      - run: "npx clasp --version; echo $\\x7B{ \\x69nputs.deploy_ref }} ${'x'.repeat(40)}"`;
    for (const t of ['    x: "\\x41"', '    x: "\\u0041"', '    x: "\\U00000041"', long]) {
      assert.deepEqual(checkSecretFormats(`${t}\n`, 'f'), [`f: sekwencja ucieczki YAML (\\x, \\u, \\U) nieobsługiwana przez test: ${t.trim().slice(0, 60)}`], t);
    }
    for (const t of ['  evil: &0', '  !!str evil:', '      - !x a', '        run: *0', '    secrets: !!str inherit', `    X: &a ${'y'.repeat(70)}`]) {
      assert.deepEqual(checkSecretFormats(`${t}\n`, 'f'), [`f: tag, kotwica albo alias nieobsługiwane przez test: ${t.trim().slice(0, 60)}`], t);
    }
    for (const t of ['  evil :', '      - uses : actions/cache@v4', '  a  :', `  ${'k'.repeat(70)} : 1`]) {
      assert.deepEqual(checkSecretFormats(`${t}\n`, 'f'), [`f: klucz ze spacją przed dwukropkiem nieobsługiwany przez test: ${t.trim().slice(0, 60)}`], t);
    }
  });

  test('pkt 2: wyzwalacz spoza listy, brak bloku on, zapis nieobsługiwany, linia z samych spacji', () => {
    for (const t of ['push', 'pull_request', 'pull_request_target', 'issue_comment', 'workflow_run']) {
      assert.deepEqual(checkSecretTriggers(swap('  workflow_dispatch:\n', `  workflow_dispatch:\n  ${t}:\n`), 'f', DEPLOY.triggers),
        [`f: wyzwalacz ${t} poza dozwolonymi (release, workflow_dispatch)`]);
    }
    assert.deepEqual(checkSecretTriggers('name: X\n', 'f', DEPLOY.triggers), ['f: brak rozpoznanych wyzwalaczy']);
    assert.deepEqual(checkSecretTriggers('on:\n  - release\n', 'f', DEPLOY.triggers), ['f: brak rozpoznanych wyzwalaczy']);
    assert.deepEqual(checkSecretTriggers(swap('  workflow_dispatch:\n', '  workflow_dispatch:\n  "push":\n'), 'f', DEPLOY.triggers),
      ['f: wyzwalacz w zapisie nieobsługiwanym przez test']);
    assert.deepEqual(checkSecretTriggers(swap('  # komentarz w bloku on\n', '  # komentarz w bloku on\n  \n'), 'f', DEPLOY.triggers), []);
  });

  test('pkt 3 i AC-3: akcje spoza listy, setup-node z cache albo bez package-manager-cache: false', () => {
    for (const u of [`actions/cache@${SHA}`, `actions/cache/restore@${SHA}`, `actions/download-artifact@${SHA}`, `someorg/cache@${SHA}`, './local', `Actions/Checkout@${SHA}`]) {
      const name = u.split('@')[0];
      assert.deepEqual(checkSecretJobDeps(step(`      - uses: ${u} # v4`), 'f'), [`${job}akcja ${name} poza listą dozwolonych w jobie z sekretami`], u);
    }
    for (const u of [`      - uses: actions/upload-artifact@${SHA} # v7`, `      - name: U\n        uses: actions/upload-artifact@${SHA}`]) {
      assert.deepEqual(checkSecretJobDeps(step(u), 'f'), [], u);
    }
    for (const u of [`      -  uses: actions/cache@${SHA}`, `      - uses:  actions/cache@${SHA}`, `      - name: C\n        uses: actions/cache@${SHA}`]) {
      assert.deepEqual(checkSecretJobDeps(step(u), 'f'), [`${job}akcja actions/cache poza listą dozwolonych w jobie z sekretami`], u);
    }
    assert.deepEqual(checkSecretJobDeps(step(`      - run: echo uses: actions/cache@${SHA}`), 'f'), []);
    const noPmc = `${job}setup-node bez package-manager-cache: false`;
    const pmc = '          package-manager-cache: false # powód\n';
    assert.deepEqual(checkSecretJobDeps(swap('          node-version: 22\n', '          node-version: 22\n          cache: yarn\n'), 'f'), [`${job}setup-node z cache`]);
    for (const repl of ['', '          package-manager-cache: true\n', '          x-package-manager-cache: false\n', '          package-manager-cache: false x\n', '\n          # package-manager-cache: false\n']) {
      assert.deepEqual(checkSecretJobDeps(swap(pmc, repl), 'f'), [noPmc], repl);
    }
    assert.deepEqual(checkSecretJobDeps(swap(pmc, '\n          package-manager-cache:  false  \n'), 'f'), []);
    for (const u of [`      -  uses: actions/setup-node@${SHA}`, `      - uses:  actions/setup-node@${SHA}`]) {
      assert.deepEqual(checkSecretJobDeps(step(`${u}\n        with:\n          cache: yarn`), 'f'), [`${job}setup-node z cache`, noPmc], u);
    }
    assert.deepEqual(checkSecretJobDeps(step(`      - run: echo uses: actions/setup-node@${SHA}`), 'f'), []);
    assert.deepEqual(checkSecretJobDeps('name: X\n', 'f'), ['f: brak rozpoznanych jobów']);
  });

  test('pkt 3 i AC-3: npm tylko w dokładnych poleceniach z listy, npx tylko clasp i eslint, bez continue-on-error i git/gh pobierających kod', () => {
    for (const cmd of ['npm ci', 'npm install', 'npm i', 'npm ci # --ignore-scripts', 'npm ci --ignore-scripts=false', 'npm  ci --ignore-scripts',
      'npm ci --ignore-scripts && npm rebuild', 'npm --foreground-scripts ci', 'npm clean-install', 'npm run lint || true', 'echo "npm test pominięty"']) {
      assert.deepEqual(checkSecretJobDeps(swap('run: npm ci --ignore-scripts', `run: ${cmd}`), 'f'), [`${job}npm poza listą dozwolonych poleceń: run: ${cmd}`], cmd);
    }
    assert.deepEqual(checkSecretJobDeps(step('      - run: |\n          npm \\\n            install'), 'f'), [`${job}npm poza listą dozwolonych poleceń: npm \\`]);
    for (const ok of ['      -  run: npm ci --ignore-scripts   ', '      - run:  npm test', '      - run: |\n          npm run quality:gate -- --changed=none\n          npm test',
      '      # npm ci', '      - run: npmx ci', '      - run: npx eslint x', '      - run: x; npx clasp status; y']) {
      assert.deepEqual(checkSecretJobDeps(step(ok), 'f'), [], ok);
    }
    for (const cmd of ['npx -y evil', 'npx evil', 'npx claspx a', 'npx clasp', 'x && npx  -p y clasp a']) {
      assert.deepEqual(checkSecretJobDeps(step(`      - run: ${cmd}`), 'f'), [`${job}npx poza clasp i eslint: - run: ${cmd}`], cmd);
    }
    for (const t of ['        continue-on-error: true', '      - continue-on-error: false\n        run: echo']) {
      assert.deepEqual(checkSecretJobDeps(swap('      - name: Lint\n', `      - name: Lint\n${t}\n`), 'f'), [`${job}continue-on-error w jobie z sekretami`], t);
    }
    assert.deepEqual(checkSecretJobDeps(step('      - run: echo continue-on-error: true'), 'f'), []);
    for (const cmd of ['git checkout origin/feature', 'git fetch', 'git  switch x', 'gh run download -n x', 'gh release download', 'gh pr checkout 1',
      'x; git restore .', 'git show x:y > a.js', 'git -c protocol.version=2 fetch origin', 'git -C . checkout x -- s', 'git submodule update',
      'git', 'gh api', 'gh api repos/x', 'gh  api x', 'gh api "repos/$GITHUB_REPOSITORY/tarball/feature" > src.tgz',
      `${GH_W_JOBIE_Z_SEKRETAMI} # c`, 'echo $(git log)', "node -e \"x('git rev-list')\"", 'a && gh run list', 'x|git apply']) {
      assert.deepEqual(checkSecretJobDeps(step(`      - run: ${cmd}`), 'f'), [`${job}polecenie git/gh spoza listy (git rev-parse, gh api z kroku walidacji): - run: ${cmd}`], cmd);
    }
    assert.deepEqual(checkSecretJobDeps(step('      - run: git rev-parse x; git fetch'), 'f'),
      [`${job}polecenie git/gh spoza listy (git rev-parse, gh api z kroku walidacji): - run: git rev-parse x; git fetch`]);
    for (const ok of ['git rev-parse HEAD', GH_W_JOBIE_Z_SEKRETAMI, `${GH_W_JOBIE_Z_SEKRETAMI}   `, 'gitx checkout', 'ghx run', 'echo $(git rev-parse --short HEAD)', "node -e \"x('git rev-parse --short HEAD')\"",
      'echo .git/x', 'echo x-git y', 'echo GH_TOKEN gh-pages']) {
      assert.deepEqual(checkSecretJobDeps(step(`      - run: ${ok}`), 'f'), [], ok);
    }
  });

  test('pkt 3: shell tylko bash, set tylko set -euo pipefail, bez pliku zdarzenia (porażka testów zatrzymuje job, wejścia tylko jako dane)', () => {
    for (const t of ['set +e', 'set +o errexit', 'set -uo pipefail', 'set -euo pipefail; set +e', 'x; set +e', '(set +e', 'set -e']) {
      assert.deepEqual(checkSecretJobDeps(step(`      - run: |\n          ${t}\n          echo`), 'f'), [`${job}set inny niż set -euo pipefail: ${t}`], t);
    }
    for (const ok of ['set -euo pipefail', 'set -euo pipefail   ', 'echo offset -1', 'echo reset +x', 'echo set', 'echo settings -x']) {
      assert.deepEqual(checkSecretJobDeps(step(`      - run: |\n          ${ok}\n          echo`), 'f'), [], ok);
    }
    for (const sh of ['bash {0}', 'bash -e {0}', 'sh', 'pwsh', 'Bash']) {
      assert.deepEqual(checkSecretJobDeps(step(`      - name: S\n        shell: ${sh}\n        run: echo`), 'f'), [`${job}shell inny niż bash: shell: ${sh}`], sh);
    }
    assert.deepEqual(checkSecretJobDeps(step('      - shell: sh\n        run: echo'), 'f'), [`${job}shell inny niż bash: - shell: sh`]);
    for (const ok of ['      - name: S\n        shell:  bash  \n        run: echo', '      - shell: bash\n        run: echo', '      - shell: bash # c\n        run: echo', '      - run: echo shell: sh']) {
      assert.deepEqual(checkSecretJobDeps(step(ok), 'f'), [], ok);
    }
    const evt = line => [`${job}plik zdarzenia w jobie z sekretami: ${line}`];
    assert.deepEqual(checkSecretJobDeps(step('      - env:\n          EVT: ${{ github.event_path }}\n        run: jq . "$EVT"'), 'f'), evt('EVT: ${{ github.event_path }}'));
    for (const t of ['jq . "$GITHUB_EVENT_PATH"', 'echo ${{ github . event_path }}']) {
      assert.deepEqual(checkSecretJobDeps(step(`      - run: ${t}`), 'f'), evt(`- run: ${t}`), t);
    }
    for (const ok of ['echo ${{ github.event_name }}', 'echo $GITHUB_EVENT_PATHX', 'echo github.event_paths']) {
      assert.deepEqual(checkSecretJobDeps(step(`      - run: ${ok}`), 'f'), [], ok);
    }
  });

  test('pkt 4: checkout tylko z refem z listy pliku, bez repository', () => {
    const noRef = `${job}checkout bez ref z listy (${DEPLOY_SHA}, ${TOOLING_SHA})`;
    const ref = `ref: ${DEPLOY_SHA}`;
    assert.deepEqual(checkSecretJobRefs(swap(ref, 'ref: ${{ inputs.deploy_ref }}'), 'f', DEPLOY.refs),
      [noRef, `${job}wejście poza env i if: ref: \${{ inputs.deploy_ref }}`]);
    for (const r of ['ref: ${{ env.DEPLOY_REF }}', 'ref: main', 'ref: ${{ steps.any.outputs.r }}', `${ref} x`, `${ref} # c`, 'ref: ${{steps.ref.outputs.deploy_sha}}', `x${ref}`, 'x: main']) {
      assert.deepEqual(checkSecretJobRefs(swap(ref, r), 'f', DEPLOY.refs), [noRef], r);
    }
    assert.deepEqual(checkSecretJobRefs(swap(ref, `ref:   ${DEPLOY_SHA}  `), 'f', DEPLOY.refs), []);
    assert.deepEqual(checkSecretJobRefs(swap(ref, 'ref: main'), 'f', ['main', TOOLING_SHA]), []);
    assert.deepEqual(checkSecretJobRefs(swap(`          ${ref}\n`, `          ${ref}\n          repository: o/r\n`), 'f', DEPLOY.refs), [`${job}checkout z repository`]);
    for (const extra of ['          note: repository: x\n']) {
      assert.deepEqual(checkSecretJobRefs(swap(`          ${ref}\n`, `          ${ref}\n${extra}`), 'f', DEPLOY.refs), [], extra);
    }
    for (const u of [`      -  uses: actions/checkout@${SHA}`, `      - uses:  actions/checkout@${SHA}`]) {
      assert.deepEqual(checkSecretJobRefs(step(`${u}\n        with:\n          ref: x\n          persist-credentials: false`), 'f', DEPLOY.refs), [noRef], u);
    }
    assert.deepEqual(checkSecretJobRefs(step(`      - run: echo uses: actions/checkout@${SHA}`), 'f', DEPLOY.refs), []);
  });

  test('pkt 4: wejścia (inputs, github.event, head_ref, cały kontekst github w wyrażeniu, plik zdarzenia) tylko w env i if', () => {
    const shown = body => [`${job}wejście poza env i if: ${body.trim().slice(0, 60)}`];
    for (const body of [
      '      - run: echo "$GITHUB_EVENT_PATH"', '      - run: echo github.head_ref', '      - run: echo inputs .a', '      - run: echo inputs',
      '      - run: echo github .event', '      - run: echo github. event', '      - run: echo if: ${{ inputs.a }}', `      - run: echo ${'x'.repeat(70)} inputs.a`
    ]) {
      assert.deepEqual(checkSecretJobRefs(step(body), 'f', DEPLOY.refs), shown(body), body);
    }
    for (const [body, line] of [
      ['      - run: |\n          echo inputs.x', 'echo inputs.x'],
      [`      - uses: o/a@${SHA} # v1\n        with:\n          tag: \${{ github.event.release.tag_name }}`, 'tag: ${{ github.event.release.tag_name }}'],
      [`      - uses: o/a@${SHA} # v1\n        with:\n          tag: \${{ github['event'] }}`, "tag: ${{ github['event'] }}"],
      [`      - uses: o/a@${SHA} # v1\n        with:\n          tag: \${{ inputs['x'] }}`, "tag: ${{ inputs['x'] }}"],
      [`      - uses: o/a@${SHA} # v1\n        with:\n          p: \${{ fromJSON(toJSON(inputs)).deploy_ref }}`, 'p: ${{ fromJSON(toJSON(inputs)).deploy_ref }}'],
      [`      - uses: o/a@${SHA} # v1\n        with:\n          p: \${{ toJSON(github) }}`, 'p: ${{ toJSON(github) }}'],
      [`      - uses: o/a@${SHA} # v1\n        with:\n          p: \${{ github }}`, 'p: ${{ github }}'],
      ['      - env:\n          X: >-\n            ${{ inputs.a }}\n        run: echo', '${{ inputs.a }}'],
      ['      - run: echo env:\n          ${{ inputs.a }}', '${{ inputs.a }}']
    ]) {
      assert.deepEqual(checkSecretJobRefs(step(body), 'f', DEPLOY.refs), shown(line), body);
    }
    for (const body of [
      '      - if: github.event.release.prerelease == false\n        run: echo',
      '      - env:\n\n          # komentarz\n          X: ${{ inputs.a }}\n        run: echo',
      '      # ${{ inputs.a }}\n      - run: echo',
      `      - uses: o/a@${SHA} # v1\n        with:\n          tag: \${{ github.event_name }}\n          r: \${{ github.ref }}\n          s: \${{ secrets.GITHUB_TOKEN }}`,
      "      - run: echo\n        if: inputs.a == 'x'", "      -  if: inputs.a == 'x'\n        run: echo", '      -  env:\n          X: ${{ inputs.a }}\n        run: echo',
      '      - run: echo GitHub GITHUB_REPOSITORY'
    ]) {
      assert.deepEqual(checkSecretJobRefs(step(body), 'f', DEPLOY.refs), [], body);
    }
  });

  test('pkt 6: sekret tylko w krokach, kolejność kroków wokół poświadczeń, sprzątanie w ostatnim kroku', () => {
    const creds = '      - name: Creds\n        env:\n          CLASPRC_JSON: ${{ secrets.CLASPRC_JSON }}\n        run: npx clasp --version\n';
    const early = GOOD.replace(creds, '').replace('      - name: Lint\n', `${creds}      - name: Lint\n`);
    assert.deepEqual(checkSecretStepOrder(early, 'f', DEPLOY.before), [`${job}lint nie poprzedza kroku z sekretami`, `${job}testy nie poprzedza kroku z sekretami`]);
    assert.deepEqual(checkSecretStepOrder(swap(TESTS, ''), 'f', DEPLOY.before), [`${job}testy nie poprzedza kroku z sekretami`]);
    const all3 = [`${job}npm ci nie poprzedza kroku z sekretami`, `${job}lint nie poprzedza kroku z sekretami`, `${job}testy nie poprzedza kroku z sekretami`];
    for (const s of ['${{ secrets.CLASPRC_JSON }}', '${{ secrets . apps_script_id }}']) {
      const same = GOOD.replace(creds, '').replace('      - name: Install\n        run: npm ci --ignore-scripts\n',
        `      - name: Install\n        env:\n          C: ${s}\n        run: npm ci --ignore-scripts\n`);
      assert.deepEqual(checkSecretStepOrder(same, 'f', DEPLOY.before), all3, s);
    }
    const noTests = [`${job}testy nie poprzedza kroku z sekretami`];
    const body = TESTY_RUN.split('\n');
    const block = (lines, head = '      - name: Tests\n        run: |\n', ind = '          ') => `${head}${lines.map(l => `${ind}${l}\n`).join('')}`;
    for (const t of [
      block(body, '      # - name: Tests\n      #   run: |\n', '      #     '),
      '      - name: Tests\n        run: npm run quality:gate -- --changed=none\n',
      block(['trap \'exit 0\' EXIT', ...body]), block(['if [ "$SKIP_TESTS" = true ]; then exit 0; fi', ...body]), block(['shopt -uo errexit', ...body]),
      block(body.map(l => l.replace('--changed=none', '--changed=none || true'))), block(body.slice(1)), block([...body, 'echo gotowe']),
      block(body, '      - name: Tests\n        run: |-\n'), block(body, '      - name: Tests\n        run: >\n'),
      block(body, '      - name: Tests\n        run: set -euo pipefail\n'), block(body, '      - name: Tests\n        run: |\n          (\n'),
      `      - name: Tests\n        run: ${body[0]}\n`
    ]) {
      assert.deepEqual(checkSecretStepOrder(swap(TESTS, t), 'f', DEPLOY.before), noTests, t);
    }
    for (const t of [
      block([body[0], '# komentarz bash', ...body.slice(1)]), block(body.map(l => `${l}   `)), `${block(body)}\n`, block(body, '      - name: Tests\n        run: | # c\n'),
      block(body, '      - run: |\n'), block(body, '      - name: Tests\n        run: |\n', '            '), block(body, '      - name: Tests\n        # if: false\n        run: |\n')
    ]) {
      assert.deepEqual(checkSecretStepOrder(swap(TESTS, t), 'f', DEPLOY.before), [], t);
    }
    for (const [label, run] of [['npm ci', 'npm ci --ignore-scripts'], ['lint', 'npm run lint']]) {
      for (const bad of [`${run} || true`, `${run}; echo`, `echo ${run}`, `${run} # c`]) {
        assert.deepEqual(checkSecretStepOrder(swap(`run: ${run}\n`, `run: ${bad}\n`), 'f', DEPLOY.before), [`${job}${label} nie poprzedza kroku z sekretami`], bad);
      }
      assert.deepEqual(checkSecretStepOrder(swap(`run: ${run}\n`, `run: |\n          ${run}\n`), 'f', DEPLOY.before), [], run);
    }
    const cond = label => [`${job}${label} z warunkiem if: przed krokiem z sekretami`];
    for (const c of ['if: false', 'if: ${{ !inputs.skip_tests }}', "if: github.event_name == 'release'", 'if : false']) {
      assert.deepEqual(checkSecretStepOrder(swap('      - name: Tests\n', `      - name: Tests\n        ${c}\n`), 'f', DEPLOY.before), cond('testy'), c);
      assert.deepEqual(checkSecretStepOrder(swap('      - name: Lint\n', `      - name: Lint\n        ${c}\n`), 'f', DEPLOY.before), cond('lint'), c);
    }
    assert.deepEqual(checkSecretStepOrder(swap('      - name: Install\n', '      - if: false\n        name: Install\n'), 'f', DEPLOY.before), cond('npm ci'));
    assert.deepEqual(checkSecretStepOrder(swap('      - name: Creds\n', '      - name: Creds\n        if: false\n'), 'f', DEPLOY.before), []);
    const poza = 'f: sekret Apps Script poza krokami (env albo if workflow\'u lub joba)';
    assert.deepEqual(checkSecretStepOrder(swap('      TAG: ${{ github.event.release.tag_name }}\n', '      TAG: ${{ github.event.release.tag_name }}\n      C: ${{ secrets.CLASPRC_JSON }}\n'), 'f', DEPLOY.before), [poza]);
    assert.deepEqual(checkSecretStepOrder(swap('permissions:\n', 'env:\n  C: ${{ secrets.APPS_SCRIPT_ID }}\npermissions:\n'), 'f', DEPLOY.before), [poza]);
    assert.deepEqual(checkSecretStepOrder(swap('      TAG: ${{ github.event.release.tag_name }}\n', '      TAG: ${{ github.event.release.tag_name }}\n      # C: ${{ secrets.CLASPRC_JSON }}\n'), 'f', DEPLOY.before), []);
    assert.deepEqual(checkSecretStepOrder(swap('${{ secrets.CLASPRC_JSON }}', '${{ secrets.GITHUB_TOKEN }}'), 'f', DEPLOY.before), [`${job}brak kroku z sekretami Apps Script`]);
    assert.deepEqual(checkSecretStepOrder(swap('          CLASPRC_JSON: ${{ secrets.CLASPRC_JSON }}\n', '          # ${{ secrets.CLASPRC_JSON }}\n          A: 1\n'), 'f', DEPLOY.before), [`${job}brak kroku z sekretami Apps Script`]);

    const order = (pre, rm = '        if: always()\n        run: rm -f "$HOME/.clasprc.json"\n') =>
      `jobs:\n  d:\n    name: d\n    steps:\n${pre}      - env:\n          A: \${{ secrets.APPS_SCRIPT_ID }}\n        run: echo\n      - name: R\n${rm}`;
    const not = label => [`f: job d: ${label} nie poprzedza kroku z sekretami`];
    const LINT = DEPLOY.before[1];
    assert.deepEqual(checkSecretStepOrder(order('      - run: echo x run: npm ci\n'), 'f', [NPM_CI]), not('npm ci'));
    assert.deepEqual(checkSecretStepOrder(order('      - run: echo x run: npm run lint\n'), 'f', [LINT]), not('lint'));
    for (const pre of ['      -  run: npm ci --ignore-scripts\n', '      - run:  npm ci --ignore-scripts\n']) {
      assert.deepEqual(checkSecretStepOrder(order(pre), 'f', [NPM_CI]), [], pre);
    }
    for (const pre of ['      -  run: npm run lint\n', '      - run:  npm run lint\n']) {
      assert.deepEqual(checkSecretStepOrder(order(pre), 'f', [LINT]), [], pre);
    }
    assert.deepEqual(checkSecretStepOrder(order(''), 'f', SEKRETNE['apps-script-drift.yml'].before), not('npm ci'));
    assert.deepEqual(checkSecretStepOrder(order(''), 'f', []), []);

    const last = ['f: job d: ostatni krok nie usuwa poświadczeń z if: always()'];
    for (const rm of ['        run: rm -f "$HOME/.clasprc.json"\n', '        if: always() && x\n        run: rm -f "$HOME/.clasprc.json"\n',
      '        if: always()\n        run: echo rm -f "$HOME/.clasprc.json"\n', '        run: rm -f "$HOME/.clasprc.json" # if: always()\n',
      '        if: always()\n        run: echo run: rm -f "$HOME/.clasprc.json"\n',
      '        if: always()\n        run: rm -f "$HOME/.clasprc.json"\n      - name: After\n        run: echo\n']) {
      assert.deepEqual(checkSecretStepOrder(order('', rm), 'f', []), last, rm);
    }
    for (const rm of ['        if:  always()   \n        run:  rm -f "$HOME/.clasprc.json" live/x\n', '        run: rm -f "$HOME/.clasprc.json"\n        if: always()\n']) {
      assert.deepEqual(checkSecretStepOrder(order('', rm), 'f', []), [], rm);
    }
  });

  test('parentLine: rodzic z pominięciem pustych linii, komentarzy i linii z samych spacji', () => {
    const lines = ['a:', '  b:', '', '  # c', '    d: 1', 'e: 2'];
    assert.equal(parentLine(['a:', '  b:', '   ', '    d: 1'], 3), '  b:');
    assert.equal(parentLine(lines, 4), '  b:');
    assert.equal(parentLine(lines, 1), 'a:');
    assert.equal(parentLine(lines, 5), undefined);
    assert.equal(parentLine(lines, 0), undefined);
  });
});
