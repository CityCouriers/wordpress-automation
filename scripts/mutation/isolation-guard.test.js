'use strict';

// Testy bramki startu pilota mutacji. Nie uruchamiają mutantów, nie dotykają sieci ani poświadczeń.
// Uruchamianie: node --test scripts/mutation/isolation-guard.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verdict } = require('./isolation-probe.js');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOLS = ['run-file.js', 'validate-selection.js'];
const ARTIFACTS = ['.stryker-tmp', '.stryker-shadow', path.join('reports', 'mutation')];

/** Środowiska, w których narzędzie NIE może wystartować: pusty, „idealnie czysty” i z fałszywymi deklaracjami. */
const ENVS = {
  'tylko PATH': () => ({ PATH: process.env.PATH || process.env.Path || '' }),
  'czyste otoczenie z CI=true': () => ({ PATH: process.env.PATH || process.env.Path || '', CI: 'true' }),
  'fałszywe deklaracje izolacji': () => ({
    PATH: process.env.PATH || process.env.Path || '', CI: 'true',
    MUTATION_ISOLATED: '1', MUTATION_ISOLATION_OK: '1', ISOLATED: 'true', NETWORK: 'none', MUTATION_SELECTION: 'nie-istnieje.json'
  })
};

function snapshot() {
  return ARTIFACTS.map(a => [a, fs.existsSync(path.join(ROOT, a))]);
}

for (const tool of TOOLS) {
  for (const [label, makeEnv] of Object.entries(ENVS)) {
    test(`${tool} nie startuje mutantów (${label})`, () => {
      const before = snapshot();
      const r = spawnSync(process.execPath, [path.join(__dirname, tool), 'Payloads.gs'], { cwd: ROOT, encoding: 'utf8', env: makeEnv() });
      assert.equal(r.status, 3, `oczekiwano kodu 3, jest ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /no-go-izolacja/);
      assert.deepEqual(snapshot(), before, 'narzędzie nie może tworzyć katalogów Strykera ani raportów');
    });
  }

  test(`${tool}: odmowa jest przed pierwszym uruchomieniem procesu potomnego`, () => {
    const code = fs.readFileSync(path.join(__dirname, tool), 'utf8');
    const refuse = code.indexOf('refuseStart(');
    const firstSpawn = code.search(/spawnSync\(/);
    assert.ok(refuse > 0 && firstSpawn > 0 && refuse < firstSpawn, 'refuseStart musi poprzedzać spawnSync');
  });
}

test('sonda nigdy nie daje zgody: brak wykrytej ekspozycji to kod 4 i brak słowa „potwierdzona”', () => {
  const none = verdict([]);
  assert.equal(none.code, 4);
  assert.match(none.text, /NIE jest dowód izolacji/);
  assert.doesNotMatch(none.text, /potwierdzon/i);
  assert.notEqual(none.code, 0);
});

test('sonda z wykrytą ekspozycją daje kod 3 i wymienia powody', () => {
  const v = verdict(['sieć nie jest odcięta', 'zapis poza katalogiem']);
  assert.equal(v.code, 3);
  assert.match(v.text, /sieć nie jest odcięta/);
  assert.match(v.text, /zapis poza katalogiem/);
});

test('żaden kod pilota nie traktuje sondy ani zmiennej środowiskowej jako zgody na start', () => {
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotMatch(code, /assertIsolated|isolation-probe\.js'\)\.(probe|assert)/, `${f} używa sondy jako zgody`);
    assert.doesNotMatch(code, /process\.env\.(MUTATION_ISOLATED|MUTATION_ISOLATION_OK|ISOLATED)/, `${f} czyta deklarację izolacji ze środowiska`);
  }
});
