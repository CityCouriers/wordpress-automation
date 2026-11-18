#!/usr/bin/env node
'use strict';

/**
 * Jawny rekord wdrożenia Apps Script w GitHub Deployments (#297).
 *
 * Workflow wdrożenia zapisuje go PO `actions/checkout` i odczycie
 * `git rev-parse HEAD`, więc `ref` rekordu to pełny SHA faktycznie wypchniętego
 * checkoutu, a `payload.tag` to DEPLOY_REF (`main` albo tag `v*`). Automatyczny
 * rekord środowiska `production` tego nie dowodzi: opisuje kontekst uruchomienia
 * workflow, nie checkout (rollback uruchomiony z `main`). Dlatego drift check
 * czyta wyłącznie środowisko `apps-script-live`.
 *
 * Statusy ustawia ten sam workflow: `in_progress` zaraz po utworzeniu (przed
 * `clasp push`), `success` po weryfikacji z #44, `failure` przy niepowodzeniu po
 * pushu. Zapisuje je wyłącznie token joba (`deployments: write`), więc edytor
 * Apps Script ani edycja Version.gs ich nie zmienią.
 *
 * Użycie (CLI, wartości z env: GITHUB_REPOSITORY, GH_TOKEN, GITHUB_API_URL, DEPLOY_REF):
 *   node deployment-record.js start  [--cwd <katalog checkoutu>]
 *   node deployment-record.js finish --id <numer> --state success|failure
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENVIRONMENT = 'apps-script-live';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TAG_PATTERN = /^(main|v[0-9][0-9A-Za-z._-]*)$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FINAL_STATES = ['success', 'failure'];
const PAGE = 100;

/** Wartość z zewnątrz do komunikatu: bez złamań linii i znaczników poleceń. */
function show(value) {
  return JSON.stringify(String(value).slice(0, 80));
}

function repositoryFromEnv(env) {
  if (!REPO_PATTERN.test(env.GITHUB_REPOSITORY)) throw new Error('GITHUB_REPOSITORY musi mieć postać właściciel/repozytorium');
  return env.GITHUB_REPOSITORY;
}

function contextFromEnv(env) {
  const repo = repositoryFromEnv(env);
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  if (!token) throw new Error('Brak GH_TOKEN (token joba z uprawnieniem deployments)');
  const apiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  return { apiUrl, repo, token };
}

async function request(ctx, method, route, body) {
  const res = await fetch(`${ctx.apiUrl}/repos/${ctx.repo}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${method} ${route}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function validateRevision(sha, tag) {
  if (!SHA_PATTERN.test(sha)) throw new Error(`Pełny SHA checkoutu ma niepoprawną postać: ${show(sha)}`);
  if (!TAG_PATTERN.test(tag)) throw new Error(`DEPLOY_REF musi być "main" albo tagiem v*: ${show(tag)}`);
}

async function setStatus(ctx, id, state, description) {
  if (!FINAL_STATES.concat('in_progress').includes(state)) throw new Error(`Niedozwolony status rekordu: ${show(state)}`);
  await request(ctx, 'POST', `/deployments/${encodeURIComponent(id)}/statuses`, {
    state,
    environment: ENVIRONMENT,
    description
  });
}

/** Tworzy rekord i od razu ustawia `in_progress`; zwraca numer rekordu. */
async function createRecord(ctx, { sha, tag }) {
  validateRevision(sha, tag);
  const created = await request(ctx, 'POST', '/deployments', {
    ref: sha,
    environment: ENVIRONMENT,
    auto_merge: false,
    required_contexts: [],
    payload: { tag },
    description: `Apps Script: ${tag}`,
    transient_environment: false,
    production_environment: false
  });
  if (!created || !Number.isInteger(created.id)) throw new Error('GitHub nie utworzył rekordu wdrożenia (brak numeru w odpowiedzi)');
  await setStatus(ctx, created.id, 'in_progress', `Wdrażanie ${tag}`);
  return created.id;
}

/** Tag z payloadu rekordu; tylko obiekt (tak zapisuje go krok deployu), tekst daje undefined. */
function tagOf(payload) {
  return payload ? payload.tag : undefined;
}

/** Tag najnowszego opublikowanego wydania; informacja pomocnicza, więc każdy błąd daje null. */
async function latestReleaseTag(ctx) {
  try {
    return (await request(ctx, 'GET', '/releases/latest')).tag_name;
  } catch {
    return null;
  }
}

const byIdDesc = (a, b) => b.id - a.id;

/**
 * Najnowszy rekord środowiska wraz z jego najnowszym statusem. Kolejności
 * odpowiedzi API nie zakładamy: wybór po największym numerze.
 */
async function latestRecord(ctx) {
  const list = await request(ctx, 'GET', `/deployments?environment=${ENVIRONMENT}&per_page=${PAGE}`);
  const newest = list.filter(d => d.environment === ENVIRONMENT).sort(byIdDesc)[0];
  if (!newest) return null;
  const statuses = await request(ctx, 'GET', `/deployments/${newest.id}/statuses?per_page=${PAGE}`);
  const last = statuses.sort(byIdDesc)[0];
  return {
    id: newest.id,
    ref: newest.ref,
    resolvedSha: newest.sha,
    tag: tagOf(newest.payload),
    state: last ? last.state : null
  };
}

/**
 * Ocena rekordu przez drift check. Fail-closed: tylko `success` z pełnym SHA
 * (`ref` równy rozwiązanemu `sha`) i poprawnym tagiem daje { ok: true }.
 */
function classifyRecord(rec) {
  if (!rec) {
    return { ok: false, kind: 'no-record', message: `BRAK DOWODU WDROŻENIA: brak rekordu Deployments w środowisku ${ENVIRONMENT}. Do pierwszego wdrożenia z krokiem zapisu rekordu (albo zapisu bazowego) nie wiadomo, co jest na żywym projekcie.` };
  }
  const label = `rekord Deployments #${rec.id} (${ENVIRONMENT})`;
  if (rec.state !== 'success') {
    return { ok: false, kind: 'unfinished', message: `OSTATNIE WDROŻENIE NIEZAKOŃCZONE: ${label} ma status ${show(rec.state === null ? 'brak' : rec.state)}; stan żywego projektu jest nieznany, a starszego wdrożenia nie wolno traktować jako obowiązującego.` };
  }
  if (!SHA_PATTERN.test(rec.ref) || rec.resolvedSha !== rec.ref || !TAG_PATTERN.test(rec.tag)) {
    return { ok: false, kind: 'inconsistent', message: `NIESPÓJNY TAG/SHA: ${label} ma ref ${show(rec.ref)} i tag ${show(rec.tag)} niezgodne z wzorcem (pełny SHA, "main" albo "v*").` };
  }
  return { ok: true, id: rec.id, sha: rec.ref, tag: rec.tag, source: label };
}

function parseCli(argv) {
  const opts = {};
  const value = (i, flag) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--cwd') opts.cwd = path.resolve(value(i++, '--cwd'));
    else if (argv[i] === '--id') opts.id = value(i++, '--id');
    else if (argv[i] === '--state') opts.state = value(i++, '--state');
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

async function main(argv, env) {
  const command = argv[0];
  const opts = parseCli(argv);
  const ctx = contextFromEnv(env);
  if (command === 'start') {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: opts.cwd, encoding: 'utf8' }).trim();
    const id = await createRecord(ctx, { sha, tag: env.DEPLOY_REF });
    console.log(`Rekord wdrożenia #${id}: ${env.DEPLOY_REF} (${sha}), status in_progress.`);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `id=${id}\n`);
  } else if (command === 'finish') {
    if (!/^[0-9]+$/.test(opts.id)) throw new Error('--id musi być numerem rekordu');
    if (!FINAL_STATES.includes(opts.state)) throw new Error('--state musi być success albo failure');
    await setStatus(ctx, opts.id, opts.state, `Wdrożenie zakończone: ${opts.state}`);
    console.log(`Rekord wdrożenia #${opts.id}: status ${opts.state}.`);
  } else {
    throw new Error('Użycie: deployment-record.js start | finish --id <numer> --state success|failure');
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).catch(e => {
    console.error(`\n[deployment-record] FAIL: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { ENVIRONMENT, repositoryFromEnv, request, latestReleaseTag, SHA_PATTERN, TAG_PATTERN, contextFromEnv, createRecord, setStatus, latestRecord, classifyRecord, show, main };
