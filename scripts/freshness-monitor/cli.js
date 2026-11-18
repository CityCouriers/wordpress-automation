#!/usr/bin/env node
'use strict';

/**
 * Wejście sprawdzacza świeżości (#295) dla workflow instalacji i dla jej niezależnej kontroli życia.
 *
 *   node cli.js check                      jeden przebieg sprawdzacza (kody wyjścia: 0 zielony, 1 czerwony, 2 błąd konfiguracji)
 *   node cli.js liveness --state <plik>    ocena życia sprawdzacza z pliku stanu (0 OK, 1 ALERT, 2 błąd konfiguracji)
 *
 * Wszystko, co instalacja ma prywatnego, przychodzi ze środowiska (sekrety workflow): konfiguracja
 * (`FRESHNESS_MONITOR_CONFIG`, `FRESHNESS_LIVENESS_CONFIG`), identyfikator pliku sygnałowego
 * (`SIGNAL_FILE_ID`), komórka (`SIGNAL_RANGE`), token odczytu (`GOOGLE_ACCESS_TOKEN`), adres kanału
 * (`ALERT_WEBHOOK_URL`) i katalog z klonem prywatnego repozytorium (`STATE_REPO_DIR`). Do wyjścia trafiają
 * wyłącznie stałe kody i linie z pól o stałym kształcie, nigdy wartości sekretów ani tekst wyjątków.
 */

const fs = require('fs');
const { spawnSync } = require('child_process');
const { ConfigError, normalizeConfig, normalizeLivenessConfig } = require('./config');
const { createGitStore } = require('./git-store');
const { evaluateLiveness } = require('./liveness');
const { runCheck } = require('./monitor');
const { createSheetsReader } = require('./sheets-reader');
const { createWebhookSender } = require('./webhook-sender');

/** Wykonawca gita w katalogu klonu; wynik bez wyjątków (status różny od zera opisuje błąd). */
function gitExec(directory, spawn = spawnSync) {
  return async (args, options = {}) => {
    const out = spawn('git', args, {
      cwd: directory, input: options.input, env: { ...process.env, ...options.env }, encoding: 'utf8', maxBuffer: 1 << 24
    });
    return { status: out.status === null ? 1 : out.status, stdout: out.stdout || '', stderr: out.stderr || '' };
  };
}

/** Kod błędu do wypisania: tylko stały kod (`LITERY_I_PODKREŚLENIA[:pole]`), inaczej ogólny. */
function safeCode(error, fallback) {
  const known = error && typeof error.message === 'string' && /^[A-Z_]+(?::[A-Za-z]+)?$/.test(error.message);
  return known ? error.message : fallback;
}

/** Kod do wypisania dla błędu konfiguracji: zły JSON to `CONFIG_INVALID:config`, reszta przez `safeCode`. */
function configCode(error) {
  return error instanceof SyntaxError ? 'CONFIG_INVALID:config' : safeCode(error, 'SETUP_FAILED');
}

function buildAdapters(env, deps) {
  return {
    reader: deps.reader || createSheetsReader({ fileId: env.SIGNAL_FILE_ID, range: env.SIGNAL_RANGE, token: env.GOOGLE_ACCESS_TOKEN }),
    store: deps.store || createGitStore({ exec: gitExec(env.STATE_REPO_DIR, deps.spawn) }),
    sender: deps.sender || createWebhookSender({ url: env.ALERT_WEBHOOK_URL })
  };
}

async function check(env, io, deps) {
  let config;
  let adapters;
  try {
    config = normalizeConfig(JSON.parse(env.FRESHNESS_MONITOR_CONFIG));
    adapters = buildAdapters(env, deps);
  } catch (error) {
    io.error(`[monitor] problem=${configCode(error)}`);
    return 2;
  }
  const result = await runCheck({
    config,
    ...adapters,
    clock: deps.clock || (() => new Date()),
    sleep: deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    log: line => io.log(line)
  });
  return result.green ? 0 : 1;
}

function readStateFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

async function liveness(args, env, io, deps) {
  const file = args[0] === '--state' ? args[1] : undefined;
  let config;
  try {
    if (!file) throw new ConfigError('state');
    config = normalizeLivenessConfig(JSON.parse(env.FRESHNESS_LIVENESS_CONFIG));
  } catch (error) {
    io.error(`[monitor] problem=${configCode(error)}`);
    return 2;
  }
  const now = (deps.clock || (() => new Date()))();
  const verdict = evaluateLiveness({ text: readStateFile(file), now, config });
  const age = hours => (hours === null ? '-' : hours);
  io.log(`[${config.label}] kontrola_zycia=${verdict.level} powody=${verdict.reasons.join(',') || '-'}` +
    ` puls_h=${age(verdict.heartbeatAgeHours)} niedostarczona_h=${age(verdict.undeliveredAgeHours)} przebieg=${now.toISOString()}`);
  return verdict.level === 'OK' ? 0 : 1;
}

/**
 * @param {string[]} argv argumenty po nazwie skryptu
 * @param {object} [env]
 * @param {{log: function, error: function}} [io]
 * @param {object} [deps] atrapy do testów: reader, store, sender, clock, sleep
 * @return {Promise<number>} kod wyjścia
 */
async function main(argv, env = process.env, io = console, deps = {}) {
  if (argv[0] === 'check') return check(env, io, deps);
  if (argv[0] === 'liveness') return liveness(argv.slice(1), env, io, deps);
  io.error('użycie: cli.js check | liveness --state <plik>');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

module.exports = { configCode, gitExec, main, readStateFile, safeCode };
