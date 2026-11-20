'use strict';

/**
 * Drift check: żywy projekt Apps Script kontra rewizja WDROŻONA (#297).
 *
 * Rewizję wskazuje najnowszy jawny rekord GitHub Deployments (środowisko
 * apps-script-live, zapisywany przez workflow wdrożenia, patrz deployment-record.js),
 * a nie `main`: scalenie do `main` przed wdrożeniem, hotfix z `main` i rollback
 * nie są alarmem. Alarm to: brak rekordu, wdrożenie niezakończone albo nieudane,
 * niespójny tag/SHA, różnica w plikach lub w całym Version.gs.
 *
 * Granica zaufania: ten kod pochodzi z `main`; drzewo porównywanej rewizji jest
 * czytane wyłącznie jako dane (`git ls-tree` + `git cat-file`), nic z niego nie
 * jest wykonywane, instalowane ani ładowane.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dr = require('./deployment-record');

const VERSION_FILE = 'Version.gs';
const COMPARE_REF_PATTERN = /^(main|v[0-9][0-9A-Za-z._-]*|[0-9a-f]{40})$/;
const STAMP_COMMIT = /^[0-9a-f]{7,40}$/;
const STAMP_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const STAMP_ACTOR = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/;
const STAMP_KEYS = ['tag', 'commit', 'deployedAt', 'deployedBy'];

function runGit(repoDir, args) {
  return spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Wynik polecenia git albo wyjątek z kodem i komunikatem gita (stderr jest buforowany, nie trafia na konsolę). */
function git(repoDir, args) {
  const r = runGit(repoDir, args);
  if (r.status !== 0) throw new Error(`git ${args[0]} zakończone kodem ${r.status}: ${r.error ? r.error.message : r.stderr.trim()}`);
  return r.stdout;
}

function gitOk(repoDir, args) {
  return runGit(repoDir, args).status === 0;
}

function isSourceName(name) {
  return /\.gs$/.test(name) || name === 'appsscript.json';
}

function withNewline(text) {
  return text.length && !text.endsWith('\n') ? text + '\n' : text;
}

// --- Version.gs: kanoniczny zapis tworzony przez krok "Stamp deployed version" ---

function versionHeader(repository) {
  return '/**\n' +
    ' * Wygenerowane przez workflow "Deploy to Apps Script". Nie edytuj ręcznie.\n' +
    ` * Źródło: https://github.com/${repository}/releases\n` +
    ' */\n';
}

/** Dokładnie ten tekst, który zapisuje krok deployu (test zgodności pilnuje obu miejsc). */
function renderVersionFile(stamp, repository) {
  const body = STAMP_KEYS.map(k => `  ${k}: ${JSON.stringify(String(stamp[k]))}`).join(',\n');
  return `${versionHeader(repository)}const DEPLOYED_VERSION = {\n${body}\n};\n`;
}

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Literał tekstowy w formie, którą JSON.parse zawsze przyjmie (bez znaków sterujących).
const JSON_STRING = '("(?:[^"\\\\\\u0000-\\u001f]|\\\\["\\\\/bfnrt]|\\\\u[0-9a-fA-F]{4})*")';

/** Odczyt czterech pól stempla z żywego pliku BEZ wykonywania; null, gdy struktura różni się od szablonu. */
function parseVersionFile(text, repository) {
  const body = STAMP_KEYS.map(k => `  ${k}: ${JSON_STRING}`).join(',\n');
  const re = new RegExp('^' + escapeRegExp(`${versionHeader(repository)}const DEPLOYED_VERSION = {\n`) + body + escapeRegExp('\n};\n') + '$');
  const m = re.exec(text);
  if (!m) return null;
  const stamp = {};
  STAMP_KEYS.forEach((k, i) => { stamp[k] = JSON.parse(m[i + 1]); });
  return stamp;
}

function stampFieldProblems(stamp) {
  const checks = [['tag', dr.TAG_PATTERN], ['commit', STAMP_COMMIT], ['deployedAt', STAMP_DATE], ['deployedBy', STAMP_ACTOR]];
  return checks.filter(([key, pattern]) => !pattern.test(stamp[key])).map(([key]) => `Version.gs: pole ${key} ${dr.show(stamp[key])} niezgodne ze wzorcem.`);
}

function stampRecordProblems(stamp, expected) {
  const problems = [];
  if (stamp.tag !== expected.tag) problems.push(`Version.gs: tag ${dr.show(stamp.tag)} różni się od rekordu wdrożenia ${dr.show(expected.tag)}.`);
  if (!expected.sha.startsWith(stamp.commit)) problems.push(`Version.gs: commit ${dr.show(stamp.commit)} nie jest początkiem SHA z rekordu wdrożenia.`);
  return problems;
}

/**
 * Problemy z żywym Version.gs (pusta lista = zgodny). `expected` = { tag, sha } z jawnego
 * rekordu albo null w trybie diagnostycznym (wtedy tylko szablon i wzorce pól). Grupy
 * ustaleń są kolejnymi bramkami: struktura, wzorce pól, zgodność z rekordem, zapis kanoniczny.
 */
function versionProblems(liveText, repository, expected) {
  if (liveText === null) return ['Brak Version.gs w żywym projekcie.'];
  const text = withNewline(liveText);
  const stamp = parseVersionFile(text, repository);
  if (!stamp) return ['Version.gs różni się od szablonu wdrożenia (zmieniona struktura albo dopisany kod).'];
  const fields = stampFieldProblems(stamp);
  if (fields.length) return fields;
  const mismatch = expected ? stampRecordProblems(stamp, expected) : [];
  if (mismatch.length) return mismatch;
  return renderVersionFile(stamp, repository) === text ? [] : ['Version.gs: zapis różni się od kanonicznego (inne ucieczki znaków).'];
}

// --- rewizja porównywana jako dane ---

/** Drzewo źródeł rewizji: { dir, files: Map<nazwa, tekst> }; Version.gs pomijany (stempluje go deploy). */
function readTree(repoDir, sha) {
  const dir = gitOk(repoDir, ['cat-file', '-e', `${sha}:src/appsscript.json`]) ? 'src' : '.';
  const spec = dir === '.' ? sha : `${sha}:${dir}`;
  const files = new Map();
  for (const entry of git(repoDir, ['ls-tree', '-z', spec]).split('\0')) {
    // "<tryb> <typ> <obiekt>\t<nazwa>"; nazwa może zawierać dowolne znaki poza NUL.
    const tab = entry.indexOf('\t');
    const [, type, hash] = entry.slice(0, tab).split(' ');
    const name = entry.slice(tab + 1);
    if (type !== 'blob' || !isSourceName(name) || name === VERSION_FILE) continue;
    files.set(name, git(repoDir, ['cat-file', 'blob', hash]));
  }
  return { dir, files };
}

/** Cel porównania z rekordu: sprawdza spójność tag/SHA w repozytorium. */
function resolveRecordTarget(repoDir, record) {
  const { sha, tag } = record;
  if (tag === 'main') {
    if (!gitOk(repoDir, ['cat-file', '-e', `${sha}^{commit}`])) return { ok: false, message: `NIESPÓJNY TAG/SHA: SHA ${dr.show(sha)} z rekordu nie istnieje w repozytorium.` };
    if (!gitOk(repoDir, ['merge-base', '--is-ancestor', sha, 'refs/heads/main'])) return { ok: false, message: `NIESPÓJNY TAG/SHA: SHA ${dr.show(sha)} z rekordu (main) nie jest przodkiem obecnego main.` };
  } else {
    const resolved = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { cwd: repoDir, encoding: 'utf8' }).stdout.trim();
    if (!resolved) return { ok: false, message: `NIESPÓJNY TAG/SHA: tag ${dr.show(tag)} z rekordu nie istnieje w repozytorium.` };
    if (resolved !== sha) return { ok: false, message: `NIESPÓJNY TAG/SHA: tag ${dr.show(tag)} wskazuje ${dr.show(resolved)}, a rekord wdrożenia ${dr.show(sha)} (przesunięty tag).` };
  }
  return { ok: true, sha, tag, source: record.source, stamp: { tag, sha }, diagnostic: false };
}

/** Cel diagnostyczny z compare_ref: tylko zwalidowane dane, bez rekordu. */
function resolveDiagnosticTarget(repoDir, ref) {
  if (!COMPARE_REF_PATTERN.test(ref)) return { ok: false, message: `compare_ref musi być "main", tagiem v* albo pełnym SHA: ${dr.show(ref)}.` };
  // Wzorzec wyżej gwarantuje jedną z trzech postaci; SHA nie zaczyna się od "v".
  const rev = ref === 'main' ? 'refs/heads/main' : (ref.startsWith('v') ? `refs/tags/${ref}` : ref);
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd: repoDir, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, message: `compare_ref ${dr.show(ref)} nie istnieje w repozytorium.` };
  return { ok: true, sha: r.stdout.trim(), tag: ref, source: 'compare_ref (tryb diagnostyczny)', stamp: null, diagnostic: true };
}

// --- porównanie ---

function readLive(liveDir) {
  const files = new Map();
  for (const name of fs.readdirSync(liveDir)) {
    if (isSourceName(name) && fs.statSync(path.join(liveDir, name)).isFile()) files.set(name, fs.readFileSync(path.join(liveDir, name), 'utf8'));
  }
  return files;
}

function writeSide(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of files) fs.writeFileSync(path.join(dir, name), withNewline(text));
}

/** Patch z różnic: strona `ref` (rewizja, z kanonicznym Version.gs) kontra `live`. */
function buildPatch({ workDir, refFiles, liveFiles }) {
  writeSide(path.join(workDir, 'ref'), refFiles);
  writeSide(path.join(workDir, 'live'), liveFiles);
  return spawnSync('git', ['--no-pager', 'diff', '--no-index', '--no-color', 'ref', 'live'], { cwd: workDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout;
}

/** Strona rewizji w patchu: pliki drzewa; przy problemie z Version.gs także jego kanoniczny wzorzec. */
function patchSides({ tree, live, liveVersion, problems, expected, repository }) {
  const refFiles = new Map(tree.files);
  const liveFiles = new Map(live);
  if (problems.length && liveVersion !== null) {
    liveFiles.set(VERSION_FILE, liveVersion);
    const e = expected || { tag: 'main', sha: '0000000' };
    refFiles.set(VERSION_FILE, renderVersionFile({ tag: e.tag, commit: e.sha.slice(0, 7), deployedAt: '', deployedBy: '' }, repository));
  }
  return { refFiles, liveFiles };
}

/**
 * Porównuje pobrany żywy projekt z drzewem rewizji. Zwraca { changes, problems, patch }:
 * changes - lista plików (` M`, `??` tylko w żywym, ` D` tylko w rewizji), problems -
 * ustalenia o Version.gs. Końcowa nowa linia jest normalizowana po obu stronach.
 */
function compareTrees({ liveDir, tree, repository, expected, workDir }) {
  const live = readLive(liveDir);
  const liveVersion = live.has(VERSION_FILE) ? live.get(VERSION_FILE) : null;
  live.delete(VERSION_FILE);
  const problems = versionProblems(liveVersion, repository, expected);
  const changes = [];
  for (const name of [...new Set([...tree.files.keys(), ...live.keys()])].sort()) {
    if (!live.has(name)) changes.push(` D ${name}`);
    else if (!tree.files.has(name)) changes.push(`?? ${name}`);
    else if (withNewline(live.get(name)) !== withNewline(tree.files.get(name))) changes.push(` M ${name}`);
  }
  if (problems.length) changes.push(` M ${VERSION_FILE}`);
  return { changes, problems, patch: buildPatch({ workDir, ...patchSides({ tree, live, liveVersion, problems, expected, repository }) }) };
}

function assertEmptyLiveDir(liveDir) {
  fs.mkdirSync(liveDir, { recursive: true });
  const present = fs.readdirSync(liveDir).filter(isSourceName).sort();
  if (present.length) throw new Error(`Katalog pobrania ${liveDir} zawiera już pliki źródłowe (${present.join(', ')}); pobranie ma trafić do czystego katalogu.`);
}

/** Cel porównania: z rekordu wdrożenia albo (tryb diagnostyczny) z compare_ref. */
async function resolveTarget(repoDir, compareRef, ctx) {
  if (compareRef) return resolveDiagnosticTarget(repoDir, compareRef);
  const verdict = dr.classifyRecord(await dr.latestRecord(ctx));
  return verdict.ok ? resolveRecordTarget(repoDir, verdict) : verdict;
}

function releaseNotice(released, target) {
  if (!released || released === target.tag) return null;
  return `Najnowsze opublikowane wydanie ${dr.show(released)} jest inne niż wdrożony ref ${dr.show(target.tag)} (${target.sha}); to informacja, nie awaria.`;
}

/** Raport z wyniku porównania: { ok, headline, lines, patch }. */
function describeResult(target, cmp, pulled) {
  const where = `${target.tag} (${target.sha}), źródło: ${target.source}`;
  const prefix = target.diagnostic ? 'DIAGNOSTYCZNY, nie zastępuje kontroli regularnej: ' : '';
  if (!cmp.changes.length) {
    const lines = [`✅ ${prefix}Apps Script zgodny z wdrożoną rewizją ${where}.`];
    if (pulled) lines.push('', '```', pulled, '```');
    return { ok: true, headline: '', lines, patch: cmp.patch };
  }
  const headline = `${prefix}Żywy projekt Apps Script różni się od wdrożonej rewizji ${where}.`;
  return { ok: false, headline, lines: [`❌ ${headline}`, '', '```', cmp.changes.join('\n'), '```', ...cmp.problems], patch: cmp.patch };
}

/**
 * Cały drift check. opts: { cwd (katalog pobrania), repoDir, refDir (opcjonalny katalog
 * roboczy; bez niego powstaje tymczasowy i jest sprzątany), env: zmienne procesu, pull:
 * funkcja pobierająca żywy projekt do katalogu. Zwraca { ok, headline, lines, patch, notices };
 * wypisaniem i kodem wyjścia zajmuje się wołający.
 */
async function runDrift(opts, env, pull) {
  const repository = dr.repositoryFromEnv(env);
  const compareRef = env.COMPARE_REF || '';
  const ctx = compareRef ? null : dr.contextFromEnv(env);
  const target = await resolveTarget(opts.repoDir, compareRef, ctx);
  if (!target.ok) return { ok: false, headline: target.message, lines: [`❌ ${target.message}`], patch: '', notices: [] };

  const note = releaseNotice(ctx ? await dr.latestReleaseTag(ctx) : null, target);
  assertEmptyLiveDir(opts.cwd);
  const pulled = pull(opts.cwd);
  const ownWorkDir = opts.refDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'apps-script-drift-'));
  try {
    const cmp = compareTrees({
      liveDir: opts.cwd, tree: readTree(opts.repoDir, target.sha), repository, expected: target.stamp, workDir: opts.refDir || ownWorkDir
    });
    return { ...describeResult(target, cmp, pulled), notices: note ? [note] : [] };
  } finally {
    if (ownWorkDir) fs.rmSync(ownWorkDir, { recursive: true });
  }
}

module.exports = {
  VERSION_FILE, COMPARE_REF_PATTERN, renderVersionFile, parseVersionFile, versionProblems,
  readTree, resolveRecordTarget, resolveDiagnosticTarget, compareTrees, assertEmptyLiveDir, runDrift
};
