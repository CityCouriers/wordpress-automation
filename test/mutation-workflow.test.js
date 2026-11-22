'use strict';

// Kontrakt workflow próby mutacji (#253): tylko workflow_dispatch, brak sekretów, środowisk i pull_request_target,
// akcje po pełnym SHA, kontener izolujący z wymaganymi flagami. Sprawdzamy tekst pliku, bo workflow nie wolno
// uruchamiać, żeby go zbadać. Funkcja `violations` ma też negatywne kontrole: zepsuty workflow MUSI dać zarzuty.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WORKDIR } = require('../scripts/mutation/isolation-guard.js');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, '.github', 'workflows');
const FILES = fs.readdirSync(DIR).filter(f => /mutation.*\.ya?ml$/.test(f));

/** Skrypty `run:` (jednolinijkowe i blokowe `|`), po jednym łańcuchu na krok. */
function runBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!/^[|>][+-]?$/.test(m[2])) {
      out.push(m[2]);
      continue;
    }
    const block = [];
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) block.push(lines[j]);
    out.push(block.join('\n'));
  }
  return out;
}

const runLines = text => runBlocks(text).join('\n').split('\n');
const withoutComments = text => text.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

/** Zarzuty wobec kroków spoza kontenera: nic, co uruchamia testy albo mutanty, nie może iść poza docker run. */
function bypassViolations(text) {
  const outside = runBlocks(withoutComments(text)).filter(script => !/docker run/.test(script));
  return outside.filter(script => /stryker(\.js| run)|scripts\/mutation|npm (run )?test|npx|node scripts/.test(script)).map(script => `krok poza kontenerem uruchamia narzędzia mutacji: ${script.trim().slice(0, 60)}`);
}

/** Podmiana OSTATNIEGO wystąpienia (pierwsze bywa w komentarzu na górze pliku). */
function swapLast(text, from, to) {
  const at = text.lastIndexOf(from);
  return at < 0 ? text : text.slice(0, at) + to + text.slice(at + from.length);
}

/** Bloki wyzwalaczy: klucze bezpośrednio pod `on:`. */
function triggers(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^on:\s*$/.test(l));
  if (start < 0) return null;
  const keys = [];
  for (let i = start + 1; i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i])); i++) {
    const m = /^ {2}([a-z_]+):/.exec(lines[i]);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function topLevelBlock(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => l.startsWith(`${key}:`));
  if (start < 0) return null;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length && (lines[i].trim() === '' || /^\s/.test(lines[i])); i++) block.push(lines[i]);
  return block.join('\n');
}

/** Lista zarzutów wobec treści workflow próby mutacji; pusta = zgodny z kontraktem. */
function violations(text) {
  const bad = [];
  const code = withoutComments(text);
  if (/secrets\./i.test(code)) bad.push('używa secrets.*');
  if (/^\s*environment:/m.test(code)) bad.push('używa environment:');
  if (/pull_request_target/.test(code)) bad.push('używa pull_request_target');
  const keys = triggers(code);
  if (!keys || keys.length !== 1 || keys[0] !== 'workflow_dispatch') bad.push(`wyzwalacze inne niż samo workflow_dispatch: ${keys}`);
  const perms = topLevelBlock(code, 'permissions');
  if (!perms || perms.trim().split('\n').map(l => l.trim()).join('|') !== 'permissions:|contents: read') bad.push('permissions inne niż samo contents: read');
  if (/^\s{4,}permissions:/m.test(code)) bad.push('uprawnienia nadpisane na poziomie jobu');
  for (const m of code.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)) {
    if (!/@[0-9a-f]{40}$/.test(m[1])) bad.push(`akcja bez pełnego SHA: ${m[1]}`);
  }
  for (const m of code.matchAll(/uses:\s*actions\/checkout@\S+[^\n]*\n((?:\s+.*\n)*)/g)) {
    if (!/persist-credentials:\s*false/.test(m[1].split(/\n\s*-\s/)[0])) bad.push('checkout bez persist-credentials: false');
  }
  if (!/uses:\s*actions\/checkout@/.test(code)) bad.push('brak kroku checkout');
  if (runLines(code).some(l => /\$\{\{/.test(l))) bad.push('interpolacja ${{ }} wewnątrz run: (wstrzyknięcie)');
  bad.push(...dockerViolations(runLines(code).join('\n'), code));
  return bad;
}

/** Dzieli wiersz powłoki na słowa po białych znakach poza cudzysłowami (cudzysłowy zostają w słowie). */
function tokenize(line) {
  const tokens = [];
  let current = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Kanoniczne polecenie kontenera: porównanie słowo w słowo zamyka drogę dodatkowym flagom, których wyliczanka
 * regułami nie przewidzi (--volumes-from, --group-add, --add-host, --sysctl, --ulimit, --cgroup-parent, --uts...).
 * Zmiana polecenia wymaga zmiany tej listy, czyli przeglądu zmiany kontraktu izolacji.
 */
const CANONICAL_DOCKER_RUN = [
  'docker', 'run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--user', '1000:1000', '--pids-limit', '4096', '--memory', '12g',
  '--memory-swap', '12g', '--cpus', '4', '--tmpfs', '/tmp:rw,nosuid,size=2g',
  '--mount', `type=bind,source="$RUNNER_TEMP/mutation-run",target=${WORKDIR}`, '--workdir', WORKDIR, '--env', 'TZ=UTC',
  '--entrypoint', 'node', '"$NODE_IMAGE"', 'scripts/mutation/trial.js', '"$TRIAL_FILE"', '"--suite=$TRIAL_SUITE"',
  '"--concurrency=$TRIAL_CONCURRENCY"', '"--outside=$RUNNER_TEMP/mutation-outside/kontrolny.txt,$GITHUB_WORKSPACE/package.json"'
];

function canonicalViolations(docker) {
  const bad = [];
  const verbs = [...docker.matchAll(/\bdocker\s+(\S+)/g)].map(m => m[1]);
  if (verbs.some(v => v !== 'pull' && v !== 'run') || verbs.filter(v => v === 'run').length !== 1) bad.push(`polecenia docker inne niż jedno run i pull: ${verbs.join(' ')}`);
  const lines = docker.split('\n').filter(l => /^\s*docker run\b/.test(l));
  if (lines.length !== 1) return [...bad, `oczekiwano jednego wiersza docker run, jest ${lines.length}`];
  const tokens = tokenize(lines[0]);
  if (tokens.join(' ') !== CANONICAL_DOCKER_RUN.join(' ')) bad.push(`docker run różni się od kanonicznego polecenia kontraktu: ${tokens.join(' ')}`);
  return bad;
}

/** Raporty z katalogu przebiegu (nieufnego) czyta tylko krok zbierający; reszta bierze kopię spoza niego. */
function reportViolations(code) {
  const bad = [];
  const scripts = runBlocks(code);
  const collect = scripts.filter(s => /sudo find "\$SRC" -maxdepth 1 -type f/.test(s));
  if (collect.length !== 1) bad.push('brak jednego kroku zbierającego raporty (find -type f)');
  if (scripts.some(s => !collect.includes(s) && /mutation-run\/reports/.test(s))) bad.push('krok inny niż zbierający czyta raporty z katalogu przebiegu');
  if (!/path:\s*\$\{\{ runner\.temp \}\}\/mutation-reports\s*$/m.test(code)) bad.push('wysyłka raportów nie czyta z kopii poza katalogiem przebiegu');
  if (/path:.*mutation-run/.test(code)) bad.push('wysyłka raportów czyta z katalogu przebiegu');
  const prepare = scripts.find(s => /cp -a "\$GITHUB_WORKSPACE\/\." "\$RUN_DIR\/"/.test(s)) || '';
  if (!/rm -rf "\$RUN_DIR\/reports"/.test(prepare)) bad.push('przygotowanie katalogu nie usuwa reports/ z kopii repozytorium');
  if (!/\.npmrc/.test(scripts.find(s => /TRIAL_FILE/.test(s) && /grep -Eq/.test(s)) || '')) bad.push('brak odmowy dla .npmrc w repozytorium');
  return bad;
}

function dockerViolations(script, code) {
  const bad = [...reportViolations(code)];
  const all = script.replace(/\\\n/g, ' ');
  bad.push(...canonicalViolations(all));
  // Reguły flag dotyczą wyłącznie wiersza docker run (inne kroki mają własne `-e`, `-v` itp.).
  const docker = all.split('\n').find(l => /^\s*docker run\b/.test(l)) || '';
  const need = [
    [/--network none\b/, '--network none'], [/--read-only\b/, '--read-only'], [/--cap-drop ALL\b/, '--cap-drop ALL'],
    [/--security-opt no-new-privileges\b/, '--security-opt no-new-privileges'], [/--pull never\b/, '--pull never'],
    [/--entrypoint node\b/, '--entrypoint node'], [/--tmpfs \/tmp:/, '--tmpfs /tmp']
  ];
  for (const [re, label] of need) if (!re.test(docker)) bad.push(`docker run bez ${label}`);
  const user = /--user (\d+):(\d+)\b/.exec(docker);
  if (!user || user[1] === '0' || user[2] === '0') bad.push('docker run bez nieuprzywilejowanego --user UID:GID');
  const mounts = [...docker.matchAll(/(?:--mount|--volume|-v)[ =](\S+)/g)].map(m => m[1]);
  if (mounts.length !== 1 || !new RegExp(`^type=bind,source="?\\$RUNNER_TEMP/mutation-run"?,target=${WORKDIR}$`).test(mounts[0])) bad.push(`montowania inne niż sam katalog przebiegu: ${mounts.join(' ')}`);
  if (!new RegExp(`--workdir ${WORKDIR}\\b`).test(docker)) bad.push('docker run bez --workdir zgodnego z kontraktem');
  for (const [re, label] of [[/--privileged/, '--privileged'], [/--network[ =](?!none\b)\S+/, 'inna sieć niż none'], [/--net[ =]host/, '--net host'], [/--pid[ =]/, '--pid'], [/--ipc[ =]/, '--ipc'],
    [/--cap-add/, '--cap-add'], [/--device/, '--device'], [/--env-file/, '--env-file'], [/docker\.sock/, 'docker.sock'], [/--security-opt (?!no-new-privileges)\S+/, 'inna opcja bezpieczeństwa'],
    [/--user[ =]root/, '--user root'], [/--userns/, '--userns']]) {
    if (re.test(docker)) bad.push(`docker run z ${label}`);
  }
  const envs = [...docker.matchAll(/(?:--env|-e)[ =](\S+)/g)].map(m => m[1]);
  if (envs.length !== 1 || envs[0] !== 'TZ=UTC') bad.push(`zmienne środowiska kontenera inne niż TZ=UTC: ${envs.join(' ')}`);
  if (!/NODE_IMAGE:\s*node:[\w.-]+@sha256:[0-9a-f]{64}\b/.test(code)) bad.push('obraz kontenera bez skrótu sha256');
  if (!/"\$NODE_IMAGE"/.test(docker)) bad.push('docker run nie używa przypiętego NODE_IMAGE');
  if (!/scripts\/mutation\/trial\.js/.test(docker)) bad.push('docker run nie uruchamia trial.js');
  return bad;
}

test('istnieje workflow próby mutacji', () => {
  assert.ok(FILES.includes('mutation-trial.yml'), FILES.join(', '));
});

for (const file of FILES) {
  test(`${file}: zgodny z kontraktem (bez sekretów, środowisk i pull_request_target; tylko workflow_dispatch; kontener izolujący)`, () => {
    assert.deepEqual(violations(fs.readFileSync(path.join(DIR, file), 'utf8')), []);
  });
}

test('katalog przebiegu w workflow to ten sam /work, którego wymaga bramka izolacji', () => {
  const yml = fs.readFileSync(path.join(DIR, 'mutation-trial.yml'), 'utf8');
  assert.match(yml, new RegExp(`target=${WORKDIR}\\b`));
  assert.equal(WORKDIR, '/work');
});

test('workflow nie ma kroków, które mogłyby ominąć kontener (npm test, stryker, node scripts poza docker run)', () => {
  assert.deepEqual(bypassViolations(fs.readFileSync(path.join(DIR, 'mutation-trial.yml'), 'utf8')), []);
});

// --- negatywne kontrole: zepsuty workflow musi dać zarzuty -----------------------------------------

const GOOD = fs.readFileSync(path.join(DIR, 'mutation-trial.yml'), 'utf8');
const BREAKS = {
  'sekret': [t => t.replace('contents: read', 'contents: read\n  id-token: write').replace('TRIAL_FILE: ${{ inputs.file }}', 'TRIAL_FILE: ${{ secrets.TOKEN }}'), /secrets/],
  'środowisko': [t => t.replace('    runs-on:', '    environment: production\n    runs-on:'), /environment/],
  'pull_request_target': [t => t.replace('  workflow_dispatch:', '  pull_request_target:\n  workflow_dispatch:'), /pull_request_target|wyzwalacze/],
  'dodatkowy wyzwalacz pull_request': [t => t.replace('on:\n', 'on:\n  pull_request:\n'), /wyzwalacze/],
  'harmonogram': [t => t.replace('on:\n', 'on:\n  schedule:\n    - cron: "0 3 * * 1"\n'), /wyzwalacze/],
  'zapis do repozytorium': [t => t.replace('contents: read', 'contents: write'), /permissions/],
  'dodatkowe uprawnienie': [t => t.replace('contents: read\n', 'contents: read\n  pull-requests: write\n'), /permissions/],
  'uprawnienia jobu': [t => t.replace('    timeout-minutes: 180', '    timeout-minutes: 180\n    permissions:\n      contents: write'), /uprawnienia nadpisane/],
  'akcja po tagu': [t => t.replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v7'), /bez pełnego SHA/],
  'akcja po skróconym SHA': [t => t.replace(/actions\/setup-node@[0-9a-f]{40}/, 'actions/setup-node@949feb2'), /bez pełnego SHA/],
  'checkout z poświadczeniami': [t => t.replace('persist-credentials: false', 'persist-credentials: true'), /persist-credentials/],
  'interpolacja w skrypcie': [t => t.replace('test -f "src/$TRIAL_FILE"', 'test -f "src/${{ inputs.file }}"'), /interpolacja/],
  'sieć w kontenerze': [t => swapLast(t, '--network none', '--network bridge'), /--network none|inna sieć/],
  'brak --network none': [t => t.replace('            --network none \\\n', ''), /--network none/],
  'system plików zapisywalny': [t => t.replace('            --read-only \\\n', ''), /--read-only/],
  'uprawnienia nie odebrane': [t => t.replace('--cap-drop ALL', '--cap-drop NET_RAW'), /--cap-drop ALL/],
  'tryb uprzywilejowany': [t => swapLast(t, '--network none', '--network none --privileged'), /--privileged/],
  'root w kontenerze': [t => t.replace('--user 1000:1000', '--user 0:0'), /--user/],
  'brak --user': [t => t.replace('            --user 1000:1000 \\\n', ''), /--user/],
  'no-new-privileges usunięte': [t => t.replace('--security-opt no-new-privileges', '--security-opt seccomp=unconfined'), /no-new-privileges|inna opcja/],
  'gniazdo dockera': [t => t.replace('--workdir /work', '--workdir /work -v /var/run/docker.sock:/var/run/docker.sock'), /docker\.sock|montowania/],
  'drugie montowanie (katalog domowy)': [t => t.replace('--workdir /work', '--workdir /work --volume "$HOME":/home/x'), /montowania/],
  'montowanie całego workspace zamiast kopii': [t => t.replace('source="$RUNNER_TEMP/mutation-run"', 'source="$GITHUB_WORKSPACE"'), /montowania/],
  'plik środowiska': [t => t.replace('--env TZ=UTC', '--env TZ=UTC --env-file .env'), /env-file|zmienne środowiska/],
  'zmienna z sekretem w kontenerze': [t => t.replace('--env TZ=UTC', '--env TZ=UTC -e GITHUB_TOKEN'), /zmienne środowiska/],
  'obraz po ruchomym tagu': [t => t.replace(/node:22-bookworm@sha256:[0-9a-f]{64}/, 'node:22-bookworm'), /sha256/],
  'katalog roboczy inny niż /work': [t => t.replace('--workdir /work', '--workdir /home/node'), /--workdir/],
  'przestrzeń nazw PID hosta': [t => swapLast(t, '--network none', '--network none --pid=host'), /--pid/],
  'dodatkowe uprawnienie kontenera': [t => t.replace('--cap-drop ALL', '--cap-drop ALL --cap-add SYS_ADMIN'), /--cap-add/],
  'brak --pull never': [t => t.replace('--pull never', ''), /--pull never/],
  'wolumeny innego kontenera': [t => t.replace('--workdir /work', '--workdir /work --volumes-from other'), /kanonicznego/],
  'dodatkowa grupa': [t => t.replace('--workdir /work', '--workdir /work --group-add 0'), /kanonicznego/],
  'dodatkowy host': [t => t.replace('--workdir /work', '--workdir /work --add-host x:1.2.3.4'), /kanonicznego/],
  'limit pamięci usunięty': [t => t.replace('            --memory-swap 12g \\\n', ''), /kanonicznego/],
  'drugi docker run': [t => t.replace('      - name: Pull Node image', '      - name: Drugi\n        run: docker run --rm "$NODE_IMAGE" true\n\n      - name: Pull Node image'), /polecenia docker|jednego wiersza/],
  'docker exec': [t => t.replace('      - name: Pull Node image', '      - name: Exec\n        run: docker exec x sh\n\n      - name: Pull Node image'), /polecenia docker/],
  'wysyłka raportów z katalogu przebiegu': [t => t.replace('path: ${{ runner.temp }}/mutation-reports', 'path: ${{ runner.temp }}/mutation-run/reports/mutation'), /wysyłka raportów/],
  'podsumowanie z katalogu przebiegu': [t => t.replace('"$RUNNER_TEMP/mutation-reports/summary.md"', '"$RUNNER_TEMP/mutation-run/reports/mutation/summary.md"'), /krok inny niż zbierający/],
  'brak kroku zbierającego': [t => t.replace('sudo find "$SRC" -maxdepth 1 -type f', 'sudo find "$SRC" -maxdepth 1'), /zbierającego/],
  'kopia z raportami z repozytorium': [t => t.replace('rm -rf "$RUN_DIR/reports" ', 'true '), /usuwa reports/],
  'brak odmowy dla .npmrc': [t => t.split('.npmrc').join('.npmrx'), /\.npmrc/]
};

for (const [label, [mutate, pattern]] of Object.entries(BREAKS)) {
  test(`negatywna kontrola: ${label} daje zarzut`, () => {
    const broken = mutate(GOOD);
    assert.notEqual(broken, GOOD, 'zmiana nie zadziałała (test byłby pusty)');
    assert.match(violations(broken).join('\n'), pattern);
  });
}

test('negatywna kontrola: krok uruchamiający mutanty poza kontenerem daje zarzut', () => {
  for (const command of ['node scripts/mutation/run-file.js Payloads.gs', 'npm test', 'npx stryker run']) {
    const broken = GOOD.replace('      - name: Pull Node image', `      - name: Obejście\n        run: ${command}\n\n      - name: Pull Node image`);
    assert.notEqual(broken, GOOD);
    assert.match(bypassViolations(broken).join('\n'), /poza kontenerem/, command);
  }
});
