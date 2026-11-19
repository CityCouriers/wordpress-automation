'use strict';

/**
 * #303: wyjątki skanera sekretów (`.gitleaksignore`) i polecenie skanu w `ci.yml`.
 *
 * `secret-scan` na `push` skanuje wszystkie gałęzie, więc znalezisko w starym commicie bocznej gałęzi czerwieni `main`
 * tak długo, jak gałąź istnieje. Plik wyjątków wycisza dokładnie dwa takie znaleziska (syntetyczny ciąg w fixture testu
 * redakcji logu). Ten test pilnuje, żeby lista wyjątków nie rosła po cichu i żeby polecenie skanu nie straciło
 * redakcji, szczegółów znaleziska (`-v`) ani zakresu `--all` na `push`.
 *
 * Kolejny wyjątek (także podmiana wpisu) wymaga zmiany listy `EXPECTED_ENTRIES`, a więc recenzji tego pliku.
 * Cała logika jest w tym pliku; nie ma kodu pomocniczego poza testem.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
/** Brak pliku to pusty tekst: asercje niżej zgłaszają wtedy brak wpisów, a nie wyjątek odczytu. */
const read = rel => {
  const file = path.join(REPO, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

/** Odcisk znaleziska w commicie: `<SHA commita>:<ścieżka>:<reguła>:<linia>`. Krótsza postać (bez commita) działa globalnie. */
const ENTRY = /^[0-9a-f]{40}:[^:\s]+:[a-z0-9-]+:[1-9][0-9]*$/;
const ISSUE_NUMBER = /#[1-9][0-9]*/;
const EXPECTED_ENTRIES = [
  'ba32ceec7bb17fcd85b684a6ef7a0b54a4a73992:test/run-marker-annotation.test.js:generic-api-key:163',
  'b3439697fb361d26e792cadf362a27a7b6d54e00:test/run-marker-annotation.test.js:generic-api-key:163'
];

describe('#303: plik wyjątków .gitleaksignore', () => {
  // Skaner przycina wiersz, pomija pusty i zaczynający się od `#`; każdy inny traktuje jako odcisk.
  const lines = read('.gitleaksignore').split(/\r?\n/);
  const isComment = line => line.trim().startsWith('#');
  const entryIndexes = [...lines.keys()].filter(index => lines[index].trim() !== '' && !isComment(lines[index]));
  const entries = entryIndexes.map(index => lines[index]);

  test('plik ma dokładnie dwa wpisy: odciski z #303', () => {
    assert.equal(entries.length, 2, `oczekiwano 2 wpisów, jest ${entries.length}`);
    assert.deepEqual(entries, EXPECTED_ENTRIES);
  });

  test('każdy wpis to odcisk z commitem: <40 znaków szesnastkowych>:<ścieżka>:<reguła>:<linia>', () => {
    assert.ok(entries.length > 0, 'brak wpisów w .gitleaksignore');
    for (const entry of entries) assert.match(entry, ENTRY);
  });

  test('każdy wpis jest poprzedzony komentarzem z numerem zgłoszenia', () => {
    assert.ok(entryIndexes.length > 0, 'brak wpisów w .gitleaksignore');
    for (const index of entryIndexes) {
      // Blok komentarza to wiersze `#` bezpośrednio nad wpisem, bez pustego wiersza po drodze.
      const block = [];
      for (let above = index - 1; above >= 0 && isComment(lines[above]); above--) block.push(lines[above].trim().slice(1));
      assert.ok(block.length > 0, `wpis w wierszu ${index + 1} nie ma komentarza bezpośrednio nad sobą`);
      assert.match(block.join('\n'), ISSUE_NUMBER, `komentarz nad wpisem w wierszu ${index + 1} nie podaje numeru zgłoszenia`);
    }
  });
});

describe('#303: krok Gitleaks w ci.yml', () => {
  // Krok to wiersze pod `- name: Gitleaks` aż do pierwszego wiersza z wcięciem płytszym niż treść kroku (8 spacji).
  const ciLines = read('.github/workflows/ci.yml').split(/\r?\n/);
  const start = ciLines.indexOf('      - name: Gitleaks');
  const body = [];
  for (let i = start + 1; start >= 0 && i < ciLines.length && (ciLines[i].trim() === '' || ciLines[i].startsWith('        ')); i++) body.push(ciLines[i]);
  // Polecenia skryptu bez komentarzy i pustych wierszy; wcięcie wewnątrz skryptu nie ma znaczenia.
  const runAt = body.indexOf('        run: |');
  const script = (runAt < 0 ? [] : body.slice(runAt + 1)).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'));
  const scans = script.filter(line => /gitleaks"? git(\s|$)/.test(line));

  test('polecenie skanera jest jedno, redaguje wartość (--redact) i wskazuje znalezisko (-v)', () => {
    assert.equal(scans.length, 1, `oczekiwano jednego polecenia skanera w kroku Gitleaks, jest ${scans.length}`);
    const tokens = scans[0].split(/\s+/);
    assert.ok(tokens.includes('--redact'), 'polecenie skanera bez --redact ujawnia wartość w logu');
    assert.ok(tokens.includes('-v'), 'polecenie skanera bez -v nie wskazuje pliku, linii ani commita znaleziska');
  });

  test('zakres na push to --all; zawęża go tylko gałąź pull_request, do BASE..HEAD', () => {
    assert.deepEqual(script.slice(0, -1), [
      'scope=--all',
      'if [ "$EVENT_NAME" = pull_request ]; then',
      'scope="${BASE_SHA}..${HEAD_SHA}"',
      'fi'
    ]);
    assert.equal(script[script.length - 1], scans[0], 'polecenie skanera ma być ostatnim poleceniem kroku');
    assert.match(String(scans[0]), / --log-opts="--diff-merges=first-parent \$scope" /);
  });
});
