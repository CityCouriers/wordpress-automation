'use strict';

/**
 * #240: zapadka długu w `ci.yml` i w hooku pre-commit działa w trybie blokady (`--mode=enforce`).
 * Silnik ma własny domyślny tryb (`enforce`), więc to właśnie podpięcie decyduje, czy czerwony wynik
 * blokuje scalenie. Test pilnuje każdego wywołania silnika w obu miejscach (nowe wywołanie bez trybu
 * albo w trybie raportu czerwieni test) oraz opisów, które o raporcie by kłamały.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');
const ENGINE = /scripts\/quality\/debt-ratchet\.js/;

function engineCalls(rel) {
  return read(rel).split(/\r?\n/).filter(line => ENGINE.test(line) && !/^\s*#/.test(line));
}

describe('#240: zapadka długu blokuje (tryb enforce) w CI i w hooku', () => {
  for (const rel of ['.github/workflows/ci.yml', '.githooks/pre-commit']) {
    test(`${rel}: są wywołania silnika i każde ma --mode=enforce`, () => {
      const calls = engineCalls(rel);
      assert.ok(calls.length >= 1, `brak wywołania silnika w ${rel}`);
      for (const call of calls) {
        assert.match(call, /--mode=enforce(\s|$)/, `wywołanie bez --mode=enforce: ${call.trim()}`);
        assert.doesNotMatch(call, /--mode=report/, `wywołanie w trybie raportu: ${call.trim()}`);
      }
    });
  }

  test('ci.yml: wywołania w PR i na push mają ten sam tryb, a krok nie nazywa się raportem', () => {
    const ci = read('.github/workflows/ci.yml');
    assert.equal(engineCalls('.github/workflows/ci.yml').length, 2, 'oczekiwane dwa wywołania: PR (--base=SHA) i push (--base=none)');
    assert.match(ci, /^\s*- name: Debt ratchet\s*$/m);
    assert.doesNotMatch(ci, /Debt ratchet \(report/);
    const step = ci.split(/\r?\n(?=\s*- name: )/).find(block => /^\s*- name: Debt ratchet\s*$/m.test(block));
    assert.ok(step, 'brak kroku Debt ratchet w ci.yml');
    assert.doesNotMatch(step, /continue-on-error/, 'krok nie może być nieblokujący');
    assert.doesNotMatch(step, /\|\|\s*(true|:)/, 'krok nie może połykać kodu wyjścia');
    assert.doesNotMatch(step, /nie blokuje/, 'komentarz kroku nie może obiecywać braku blokady');
  });

  test('pre-commit: krok zapadki nie obiecuje trybu raportu', () => {
    const hook = read('.githooks/pre-commit');
    assert.doesNotMatch(hook, /ratchet \(report/i);
    assert.doesNotMatch(hook, /does not block/);
    assert.match(hook, /step "Debt ratchet \(enforce\)"/);
  });

  test('dokumentacja nie twierdzi, że zapadka tylko raportuje', () => {
    const doc = read('docs/quality/debt-ratchet.md');
    const claude = read('CLAUDE.md');
    assert.doesNotMatch(doc, /do czasu przełączenia/);
    assert.doesNotMatch(doc, /krok nie blokuje scalenia/);
    assert.doesNotMatch(doc, /krok `Debt ratchet \(report\)`/);
    assert.doesNotMatch(claude, /na razie tryb\s+raportu/);
    assert.doesNotMatch(claude, /raportu \(nie blokuje\)/);
  });
});
