#!/usr/bin/env node
'use strict';

/**
 * Porównanie projektu Apps Script z bieżącym checkoutem (#44).
 *
 * Wspólna logika dla dwóch workflow'ów:
 *   - Deploy: tuż po `clasp push` dowodzi, że w Apps Script jest dokładnie to,
 *     co wypchnęliśmy z wdrażanego taga.
 *   - Drift check: co tydzień dowodzi, że nikt nie edytował kodu w edytorze.
 *
 * Kroki:
 *   1. `clasp pull` nadpisuje pliki źródłowe w katalogu roboczym.
 *   2. Normalizacja końcowego znaku nowej linii (edytor Apps Script go obcina).
 *   3. `Version.gs` wraca do wersji z gita (wdrożenie stempluje go celowo).
 *   4. `git status` ograniczony do źródeł (src/*.gs, albo *.gs w starszych tagach);
 *      (np. .clasp.json) nie liczy się jako różnica.
 *   5. Różnica → lista plików, patch (opcjonalnie do pliku) i kod wyjścia 1.
 *
 * Tryb `--drift` (#297, drift check) nie porównuje z checkoutem, tylko z rewizją
 * WDROŻONĄ: wskazuje ją jawny rekord GitHub Deployments, drzewo rewizji jest czytane
 * jako dane, a Version.gs porównywany w całości z kanonicznym zapisem. Logika w
 * apps-script-drift.js; tu tylko pobranie projektu i raport.
 *
 * Użycie:
 *   node scripts/quality/apps-script-compare.js [--label <opis>] [--patch <plik>] [--cwd <katalog>]
 *   node scripts/quality/apps-script-compare.js --drift --cwd <czysty katalog pobrania> --repo-dir <repo z main>
 *        [--ref-dir <katalog roboczy>] [--patch <plik względem katalogu bieżącego>]
 *   (w trybie --drift: GITHUB_REPOSITORY, GH_TOKEN, opcjonalnie COMPARE_REF = tryb diagnostyczny)
 * Zmienna APPS_SCRIPT_PULL_CMD nadpisuje komendę pobrania (domyślnie `npx clasp pull`);
 * testy podstawiają w ten sposób fałszywy clasp.
 */

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { runDrift } = require('./apps-script-drift');

function parseArgs(argv) {
  const opts = { label: 'the checked-out ref', patch: '', cwd: process.cwd(), drift: false, repoDir: process.cwd(), refDir: '' };
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--label') opts.label = value(i++, '--label');
    else if (argv[i] === '--patch') opts.patch = value(i++, '--patch');
    else if (argv[i] === '--cwd') opts.cwd = path.resolve(value(i++, '--cwd'));
    else if (argv[i] === '--drift') opts.drift = true;
    else if (argv[i] === '--repo-dir') opts.repoDir = path.resolve(value(i++, '--repo-dir'));
    else if (argv[i] === '--ref-dir') opts.refDir = path.resolve(value(i++, '--ref-dir'));
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

/** Wypisuje raport i dopisuje go do podsumowania joba. */
function report(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Wyjście gita z opcją -z: wpisy rozdzielone NUL, bez pustych. */
function splitNul(out) {
  return out.split('\0').filter(Boolean);
}

function pull(cwd) {
  const override = process.env.APPS_SCRIPT_PULL_CMD;
  // Default runs without a shell; only an explicit override (tests) goes
  // through one. On Windows npx is a .cmd wrapper and needs the shell anyway.
  const r = override
    ? spawnSync(override, { cwd, shell: true, encoding: 'utf8' })
    : spawnSync('npx', ['clasp', 'pull'], { cwd, shell: process.platform === 'win32', encoding: 'utf8' });
  const cmd = override || 'npx clasp pull';
  if (r.error) throw new Error(`Pull failed (${cmd}): ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`Pull failed (${cmd}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return (r.stdout || '').trim();
}

/**
 * Katalog ze źródłami wdrażanego refa. Od #105 to src/, ale rollback do
 * wcześniejszego taga ma je w katalogu głównym, a to narzędzie zawsze pochodzi
 * z main, więc musi obsłużyć oba układy.
 */
function sourceDir(cwd) {
  return fs.existsSync(path.join(cwd, 'src', 'appsscript.json')) ? 'src' : '.';
}

/** Pathspec ograniczający git status/diff do samych źródeł Apps Script. */
function sourcePathspec(cwd) {
  const dir = sourceDir(cwd);
  return dir === '.' ? ['*.gs', 'appsscript.json'] : [dir + '/*.gs', dir + '/appsscript.json'];
}

function normalizeTrailingNewline(cwd) {
  const dir = path.join(cwd, sourceDir(cwd));
  for (const f of fs.readdirSync(dir)) {
    if (!/\.gs$/.test(f) && f !== 'appsscript.json') continue;
    const p = path.join(dir, f);
    const s = fs.readFileSync(p, 'utf8');
    if (s.length && !s.endsWith('\n')) fs.writeFileSync(p, s + '\n');
  }
}

/**
 * Druga strona tej samej normalizacji: plik w repozytorium (index) bez znaku
 * nowej linii na końcu, który Apps Script oddaje z tym znakiem, nie jest
 * driftem. Gdy jedyną różnicą jest ten znak, index dostaje wersję z
 * roboczego katalogu; każda inna różnica zostaje widoczna w status/diff.
 */
function normalizeIndexTrailingNewline(cwd) {
  const tracked = splitNul(git(cwd, ['ls-files', '-z', '--', ...sourcePathspec(cwd)]));
  for (const f of tracked) {
    const shown = spawnSync('git', ['show', ':' + f], { cwd, encoding: 'utf8' });
    if (shown.status !== 0) continue;
    const indexed = shown.stdout;
    if (!indexed.length || indexed.endsWith('\n')) continue;
    const p = path.join(cwd, f);
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === indexed + '\n') git(cwd, ['add', '--', f]);
  }
}

/** Zwraca { changes: string, patch: string } albo puste stringi gdy brak różnic. */
function compare(cwd) {
  normalizeTrailingNewline(cwd);
  normalizeIndexTrailingNewline(cwd);
  // Restore only when the ref tracks Version.gs (older tags do not have it).
  const versionFile = sourceDir(cwd) === '.' ? 'Version.gs' : 'src/Version.gs';
  if (git(cwd, ['ls-files', '--', versionFile]).trim()) {
    git(cwd, ['checkout', '--', versionFile]);
  }
  const pathspec = ['--', ...sourcePathspec(cwd)];
  // Wpisy rozdzielone NUL (-z): git nie cytuje nazw (spacje, NBSP, znaki spoza ASCII),
  // więc nazw nie wolno przycinać. Zachowujemy wiodące kolumny statusu (" M", "??").
  // --no-renames: w -z wpis przemianowania ma drugie pole (poprzednia nazwa), które
  // inaczej byłoby czytane jako osobna zmiana. Wpisy ze zmianą tylko w indeksie
  // (np. "M  Kod.gs" po normalizacji końcowej nowej linii) nie są driftem:
  // drift to katalog roboczy względem indeksu.
  const entries = splitNul(git(cwd, ['status', '--porcelain', '-z', '--no-renames', ...pathspec]))
    .filter(e => e.startsWith('??') || e[1] !== ' ');
  if (!entries.length) return { changes: '', patch: '' };
  const changes = entries.join('\n');
  // Untracked files enter the diff via intent-to-add; reset afterwards.
  const untracked = entries.filter(e => e.startsWith('??')).map(e => e.slice(3));
  if (untracked.length) git(cwd, ['add', '-N', '--', ...untracked]);
  const patch = git(cwd, ['--no-pager', 'diff', ...pathspec]);
  if (untracked.length) git(cwd, ['reset', '-q', '--', ...untracked]);
  return { changes, patch };
}

/** Drift check: rewizja z jawnego rekordu wdrożenia (albo diagnostyczna z COMPARE_REF). */
async function driftMain(opts) {
  const result = await runDrift(opts, process.env, pull);
  for (const notice of result.notices) console.log(`::notice::${notice}`);
  const summary = result.lines;
  if (result.patch && opts.patch) {
    fs.writeFileSync(path.resolve(opts.patch), result.patch);
    summary.push(`Patch saved to ${opts.patch}.`);
  }
  report(summary.join('\n'));
  if (!result.ok) {
    console.error(`::error::${result.headline}${result.patch && opts.patch ? ' Patch w artefakcie.' : ''}`);
    process.exitCode = 1; // bez process.exit: na Windows kończy proces z otwartym uchwytem fetch awarią
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.drift) return driftMain(opts);
  const pulled = pull(opts.cwd);
  const { changes, patch } = compare(opts.cwd);
  const summary = [];

  if (!changes) {
    summary.push(`✅ Apps Script matches ${opts.label}.`);
    if (pulled) summary.push('', '```', pulled, '```');
  } else {
    summary.push(`❌ Apps Script differs from ${opts.label}:`, '', '```', changes, '```');
    if (opts.patch) {
      fs.writeFileSync(path.resolve(opts.cwd, opts.patch), patch);
      summary.push(`Patch saved to ${opts.patch}.`);
    }
  }

  report(summary.join('\n'));
  if (changes) {
    console.error(`::error::Apps Script project differs from ${opts.label}. See the job summary${opts.patch ? ' and the patch artifact' : ''}.`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(`\n[apps-script-compare] FAIL: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { compare, normalizeTrailingNewline, normalizeIndexTrailingNewline };
