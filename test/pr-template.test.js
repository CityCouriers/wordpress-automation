'use strict';

/**
 * #49: kontrola wypełnienia szablonu PR – parser treści PR-a.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { evaluate } = require('../scripts/quality/pr-template');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'quality', 'pr-template.js');

const GOOD_EN = `## Context

- **Why:** value.

## Test matrix

| ID  | Scenario | Criticality | Layer | Test |
| --- | -------- | ----------- | ----- | ---- |
| T1  | happy path | P1 | Unit | foo.test.js |

**Residual risk / deferred:** none.

## Evidence matrix

- [x] **Unit (VM):** tests added, \`npm test\` green
- [x] **Coverage:** 100%
- [ ] **Sheet manual test:** N/A (no sheet changes)
- [x] **Runtime:** N/A (no workflow changes)
- [x] **Security:** N/A

**Coverage deficit justification:** none.

## Bot reviews

- [x] Copilot finished

## Links

Fixes: #12

## Before merge

- [x] Title
`;

const GOOD_PL = `## Kontekst

- **Dlaczego:** wartość.

## Macierz testów

| ID | Scenariusz | Krytyczność | Warstwa | Test |
| --- | --- | --- | --- | --- |
| T1 | ścieżka szczęśliwa | P1 | Unit | „test 1” |
| T9 | uruchomienie w arkuszu | P2 | Sheet | ręcznie po wdrożeniu |

**Ryzyko rezydualne / odłożone:** brak.

## Macierz dowodów

- [x] **Unit (VM):** 9 testów; \`npm test\` 329/329
- [x] **Pokrycie:** 100 %
- [ ] **Test ręczny w arkuszu:** T9 po wdrożeniu
- [x] **Runtime:** bez zmian w workflow
- [x] **Bezpieczeństwo:** brak identyfikatorów witryny

**Uzasadnienie deficytu pokrycia:** brak.

## Recenzje botów

- [ ] Copilot zakończył

## Linki

Fixes: #47
Refs: #78

## Przed merge

- [ ] Tytuł zgodny z konwencją
`;

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8');

describe('pr-template: komplet', () => {
  test('T4: poprawnie wypełniony szablon angielski → PASS', () => {
    assert.deepEqual(evaluate(GOOD_EN), { ok: true, problems: [] });
  });

  test('T4b: poprawnie wypełniony szablon polski, z odłożonym testem ręcznym „po wdrożeniu” → PASS', () => {
    assert.deepEqual(evaluate(GOOD_PL), { ok: true, problems: [] });
  });

  test('nieodhaczona pozycja z odwołaniem do issue albo „follow-up” liczy się jako jawnie odłożona', () => {
    const body = GOOD_EN.replace('- [ ] **Sheet manual test:** N/A (no sheet changes)', '- [ ] **Sheet manual test:** deferred to #99');
    assert.equal(evaluate(body).ok, true);
    const body2 = GOOD_EN.replace('- [ ] **Sheet manual test:** N/A (no sheet changes)', '- [ ] **Sheet manual test:** follow-up after the next release');
    assert.equal(evaluate(body2).ok, true);
  });
});

describe('pr-template: braki', () => {
  test('nietknięty szablon z repozytorium → FAIL z trzema rodzajami braków', () => {
    const out = evaluate(TEMPLATE);
    assert.equal(out.ok, false);
    assert.ok(out.problems.some(p => /Matryca testów nie ma żadnego kompletnego wiersza/.test(p)), 'empty table');
    assert.ok(out.problems.some(p => /nie jest odhaczona/.test(p)), 'unchecked evidence');
    assert.ok(out.problems.some(p => /placeholder `<nr>`/.test(p)), 'links placeholder');
  });

  test('T1: pusta tabela matrycy (tylko nagłówek i separator, wiersz T1 bez treści) → FAIL', () => {
    const body = GOOD_EN.replace('| T1  | happy path | P1 | Unit | foo.test.js |', '| T1  |  |  |  |  |');
    const out = evaluate(body);
    assert.equal(out.ok, false);
    assert.deepEqual(out.problems, ['Matryca testów nie ma żadnego kompletnego wiersza (ID, scenariusz, krytyczność, warstwa, test – wszystkie komórki wypełnione).']);
  });

  test('T1b: wiersz z jedną wypełnioną komórką (np. tylko krytyczność) nie liczy się jako kompletny', () => {
    const body = GOOD_EN.replace('| T1  | happy path | P1 | Unit | foo.test.js |', '| T1  |  | P1 |  |  |');
    assert.equal(evaluate(body).ok, false);
    const partial = GOOD_EN.replace('| T1  | happy path | P1 | Unit | foo.test.js |', '| T1  | scenario | P1 | Unit |  |');
    assert.equal(evaluate(partial).ok, false, 'missing test cell');
    const twoRows = GOOD_EN.replace('| T1  | happy path | P1 | Unit | foo.test.js |', '| T1  |  | P1 |  |  |\n| T2  | full row | P2 | Sheet | manual |');
    assert.equal(evaluate(twoRows).ok, true, 'one complete row is enough');
  });

  test('T2b: usunięta kategoria dowodów (np. Coverage) → FAIL z nazwą kategorii, także po polsku', () => {
    const noCoverage = GOOD_EN.replace('- [x] **Coverage:** 100%\n', '');
    assert.deepEqual(evaluate(noCoverage).problems, ['Macierz dowodów nie ma pozycji „Coverage / Pokrycie” (usunięta z szablonu?).']);
    const noSecurityPl = GOOD_PL.replace('- [x] **Bezpieczeństwo:** brak identyfikatorów witryny\n', '');
    assert.deepEqual(evaluate(noSecurityPl).problems, ['Macierz dowodów nie ma pozycji „Security / Bezpieczeństwo” (usunięta z szablonu?).']);
    const onlyOne = GOOD_EN.replace(/- \[[ x]\] \*\*(Coverage|Sheet manual test|Runtime|Security)[^\n]*\n/g, '');
    assert.equal(evaluate(onlyOne).problems.length, 4, 'four missing categories reported');
  });

  test('T2: pozycja dowodów bez [x] i bez N/A → FAIL z nazwą pozycji', () => {
    const body = GOOD_EN.replace('- [x] **Coverage:** 100%', '- [ ] **Coverage:** 100%');
    const out = evaluate(body);
    assert.deepEqual(out.problems, ['Pozycja „Coverage:” nie jest odhaczona, nie ma „N/A (powód)” ani jawnego odłożenia (po wdrożeniu / follow-up / #issue).']);
  });

  test('T3: N/A bez powodu → FAIL', () => {
    const body = GOOD_EN.replace('- [x] **Security:** N/A', '- [ ] **Security:** N/A ()');
    assert.deepEqual(evaluate(body).problems, ['Pozycja „Security:”: N/A bez powodu w nawiasie.']);
  });

  test('puste uzasadnienie deficytu pokrycia i brak linii → FAIL', () => {
    const empty = GOOD_EN.replace('**Coverage deficit justification:** none.', '**Coverage deficit justification:**');
    assert.deepEqual(evaluate(empty).problems, ['Uzasadnienie deficytu pokrycia jest puste (wpisz „none” / „brak” albo listę wyjątków z powodem).']);
    const missing = GOOD_EN.replace('**Coverage deficit justification:** none.\n', '');
    assert.deepEqual(evaluate(missing).problems, ['Brak linii „Coverage deficit justification” / „Uzasadnienie deficytu pokrycia”.']);
  });

  test('sekcja linków bez Fixes/Refs → FAIL; „Fixes #12” bez dwukropka i „Closes: #3” przechodzą', () => {
    assert.deepEqual(evaluate(GOOD_EN.replace('Fixes: #12', 'zobacz issue')).problems, ['Sekcja linków nie ma `Fixes: #<numer>` ani `Refs: #<numer>`.']);
    assert.equal(evaluate(GOOD_EN.replace('Fixes: #12', 'Fixes #12')).ok, true);
    assert.equal(evaluate(GOOD_EN.replace('Fixes: #12', 'Closes: #3')).ok, true);
  });

  test('brak sekcji → osobny komunikat dla każdej; pusta treść → jeden komunikat', () => {
    const out = evaluate('## Context\n\n- **Why:** x\n');
    assert.deepEqual(out.problems, [
      'Brak sekcji „Test matrix” / „Macierz testów”.',
      'Brak sekcji „Evidence matrix” / „Macierz dowodów”.',
      'Brak sekcji „Links” / „Linki”.'
    ]);
    assert.deepEqual(evaluate('   '), { ok: false, problems: ['Treść PR-a jest pusta; wypełnij szablon.'] });
    assert.deepEqual(evaluate(undefined).ok, false);
  });

  test('komentarze HTML szablonu nie liczą się jako treść; macierz bez żadnej pozycji listy → FAIL', () => {
    const body = GOOD_EN.replace(/- \[[ x]\] \*\*[^\n]*\n/g, '').replace('## Evidence matrix', '## Evidence matrix\n<!-- - [x] ukryte w komentarzu -->');
    const out = evaluate(body);
    assert.ok(out.problems.includes('Macierz dowodów nie ma żadnej pozycji listy `- [ ]` / `- [x]`.'));
  });
});

describe('pr-template: CLI', () => {
  const run = (env, args = []) => {
    try {
      return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { env: Object.assign({}, process.env, env), encoding: 'utf8' }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) + String(e.stderr) };
    }
  };

  test('PR_BODY poprawny → kod 0; z brakami → kod 1 i lista; plik przez --body-file; zły argument → kod 2', () => {
    assert.equal(run({ PR_BODY: GOOD_EN }).code, 0);
    const bad = run({ PR_BODY: TEMPLATE });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /\[pr-template\] Braki w szablonie PR:\n {2}- /);
    const file = path.join(require('os').tmpdir(), 'pr-template-body-' + process.pid + '.md');
    fs.writeFileSync(file, GOOD_PL);
    try {
      assert.equal(run({ PR_BODY: '' }, ['--body-file', file]).code, 0);
    } finally {
      fs.unlinkSync(file);
    }
    assert.equal(run({}, ['--bogus']).code, 2);
    assert.equal(run({}, ['--body-file']).code, 2);
  });
});

describe('#290 komentarze HTML usuwane do stanu stałego', () => {
  const { splitSections } = require('../scripts/quality/pr-template');
  const CZYSTA = '## Test matrix\n\n| T1 | x |\n\n';
  const nazwy = body => Object.keys(splitSections(body));
  // Komentarz zagnieżdżony na `poziomy` poziomów: poziom 0 to zwykły komentarz, każdy kolejny składa się dopiero po usunięciu wewnętrznego.
  const zagniezdzony = poziomy => {
    let tekst = '<!-- x -->';
    for (let i = 0; i < poziomy; i++) tekst = '<!' + tekst + '-- y -->';
    return tekst;
  };

  test('komentarz złożony przez usunięcie wewnętrznego ukrywa swoją treść tak samo jak zwykły komentarz', () => {
    const ukryte = '\n## Links\n\nFixes #1\n';
    assert.deepEqual(nazwy(CZYSTA), ['_preamble', 'test matrix']);
    for (const komentarz of ['<!--' + ukryte + '-->', '<!<!-- a -->--' + ukryte + '-->', '<!-<!-- a -->-' + ukryte + '-->',
      '<!<!<!-- a -->-- b -->--' + ukryte + '-->', '<!-- <!-- -->']) {
      assert.deepEqual(splitSections(CZYSTA + komentarz + '\n'), splitSections(CZYSTA + '\n'), komentarz);
    }
  });

  test('komentarze obok siebie i w środku sekcji znikają, treść wokół zostaje', () => {
    const sections = splitSections('## Links\n\n<!-- a --> Fixes <!-- b -->#7<!-- c -->\n');
    assert.deepEqual(sections.links.join('\n').trim(), 'Fixes #7');
  });

  test('zagnieżdżenie głębsze niż limit przebiegów: splitSections zwraca null, evaluate odrzuca treść', () => {
    // Granica: 14 poziomów jest jeszcze usuwane, 15 nie (każdy poziom to przebieg, a ostatni potwierdza stan stały).
    assert.deepEqual(nazwy(CZYSTA + zagniezdzony(14)), ['_preamble', 'test matrix']);
    assert.equal(splitSections(CZYSTA + zagniezdzony(15)), null);
    const wynik = evaluate(GOOD_EN + zagniezdzony(15));
    assert.equal(wynik.ok, false);
    assert.deepEqual(wynik.problems, ['Komentarze HTML w treści są zagnieżdżone głębiej niż 16 poziomów; uprość treść PR-a.']);
    assert.equal(evaluate(GOOD_EN + zagniezdzony(14)).ok, true);
  });

  test('ogromna treść z głębokim zagnieżdżeniem kończy się szybko', () => {
    const start = Date.now();
    const glebokie = '<!'.repeat(20000) + '<!-- x -->' + '-- y -->'.repeat(20000);
    assert.equal(splitSections(glebokie), null);
    assert.ok(Date.now() - start < 5000, 'limit przebiegów ogranicza koszt');
  });
});
