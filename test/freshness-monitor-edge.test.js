'use strict';

/**
 * #295: przypadki brzegowe sprawdzacza świeżości, które zamykają mutanty w nazwach błędów, wzorcach i tekstach
 * logów: każdy z tych testów pada, gdy odpowiadającą mu stałą albo warunek się popsuje.
 */

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setImmediate } = require('node:timers');
const { at } = require('./helpers/zone');
const {
  OK_MARKER, STALE_MARKER, LABEL, createReader, createSender, createStore, makeConfig, notifiedState, run
} = require('./helpers/monitor-fakes');
const { calibrateThreshold } = require('../scripts/freshness-monitor/calibration');
const { ConfigError, normalizeConfig, normalizeLivenessConfig } = require('../scripts/freshness-monitor/config');
const { main, readStateFile, safeCode } = require('../scripts/freshness-monitor/cli');
const { StoreError, createGitStore } = require('../scripts/freshness-monitor/git-store');
const { determineMessage, reconcile } = require('../scripts/freshness-monitor/monitor');
const { ReadError, ReaderConfigError, createSheetsReader } = require('../scripts/freshness-monitor/sheets-reader');
const { initialSourceState, serializeStateFile } = require('../scripts/freshness-monitor/state');
const { wallSeconds, roundHalfAwayFromZero } = require('../scripts/freshness-monitor/wall-time');
const { SendError, SenderConfigError } = require('../scripts/freshness-monitor/webhook-sender');

const CLI = path.join(__dirname, '..', 'scripts', 'freshness-monitor', 'cli.js');
const WINDOW = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };
const RAW = { label: 'zrodlo-1', timeZone: 'Europe/Warsaw', rawThresholdHours: 2, workingHoursThresholdHours: 6, window: WINDOW };
const LIVENESS_RAW = { label: 'zrodlo-1', timeZone: 'Europe/Warsaw', window: WINDOW };
const FILE_ID = 'SYNTH0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SHA = 'a'.repeat(40);

const makeIo = () => {
  const io = { out: [], err: [], log: line => io.out.push(line), error: line => io.err.push(line) };
  return io;
};

const ENV = () => ({
  FRESHNESS_MONITOR_CONFIG: JSON.stringify(RAW),
  FRESHNESS_LIVENESS_CONFIG: JSON.stringify(LIVENESS_RAW),
  SIGNAL_FILE_ID: FILE_ID,
  SIGNAL_RANGE: 'A1',
  GOOGLE_ACCESS_TOKEN: 'tok-synth',
  ALERT_WEBHOOK_URL: 'https://hooks.example.invalid/synthetic-channel',
  STATE_REPO_DIR: 'katalog-nieistniejacy'
});

describe('#295 błędy: nazwy i kody to stałe', () => {
  test('klasy błędów mają stałe nazwy, a błędy adapterów nie niosą tekstu spoza kodu', () => {
    assert.equal(new ConfigError('label').name, 'ConfigError');
    assert.equal(new StoreError('GIT_FETCH_FAILED').name, 'StoreError');
    assert.equal(new ReadError(503).name, 'ReadError');
    assert.equal(new ReaderConfigError('range').name, 'ReaderConfigError');
    assert.equal(new SendError(503).name, 'SendError');
    assert.equal(new SenderConfigError().name, 'SenderConfigError');
  });

  test('safeCode przepuszcza tylko stały kod, a wszystko inne zastępuje ogólnym', () => {
    assert.equal(safeCode({ message: 'CONFIG_INVALID:label' }, 'X'), 'CONFIG_INVALID:label');
    assert.equal(safeCode({ message: 'ABC_DEF' }, 'X'), 'ABC_DEF');
    assert.equal(safeCode({ message: 'GET https://host/SECRET' }, 'X'), 'X', 'wzorzec jest zakotwiczony na początku');
    assert.equal(safeCode({ message: 'SECRET trailing text' }, 'X'), 'X');
    assert.equal(safeCode({ message: 'tajne' }, 'X'), 'X');
    assert.equal(safeCode({ message: { toString: () => 'SECRET' } }, 'X'), 'X', 'tylko tekst jest kodem');
    assert.equal(safeCode({ message: ['SECRET'] }, 'X'), 'X');
    assert.equal(safeCode(undefined, 'X'), 'X');
    assert.equal(safeCode(null, 'X'), 'X');
  });

  test('wyjątek spoza kontraktu przy składaniu adapterów to ogólny kod SETUP_FAILED bez tekstu', async () => {
    const env = ENV();
    Object.defineProperty(env, 'SIGNAL_FILE_ID', { get() { throw new Error('https://host/tajny-adres jan@example.invalid'); } });
    const io = makeIo();
    assert.equal(await main(['check'], env, io, { store: createStore(null), sender: createSender() }), 2);
    assert.deepEqual(io.err, ['[monitor] problem=SETUP_FAILED']);
  });
});

describe('#295 konfiguracja: brzegi walidacji', () => {
  const fieldOf = fn => { try { fn(); } catch (error) { return error.field; } return 'brak błędu'; };

  test('strefa czasowa jest wymagana (brak strefy nie oznacza strefy maszyny)', () => {
    assert.equal(fieldOf(() => normalizeConfig({ ...RAW, timeZone: undefined })), 'timeZone');
    assert.equal(fieldOf(() => normalizeLivenessConfig({ ...LIVENESS_RAW, timeZone: undefined })), 'timeZone');
  });

  test('okno: jeden zły dzień unieważnia całą listę', () => {
    assert.equal(fieldOf(() => normalizeConfig({ ...RAW, window: { ...WINDOW, days: [1, 9] } })), 'window');
    assert.equal(fieldOf(() => normalizeConfig({ ...RAW, window: { ...WINDOW, days: [0, 2] } })), 'window');
    assert.equal(fieldOf(() => normalizeConfig({ ...RAW, window: { ...WINDOW, days: [1, 1] } })), 'window');
  });

  test('święta: tylko teksty dat (tablica z datą nie jest datą)', () => {
    assert.equal(fieldOf(() => normalizeConfig({ ...RAW, holidays: [['2026-12-25']] })), 'holidays');
    assert.equal(fieldOf(() => normalizeConfig({ ...RAW, holidays: [20261225] })), 'holidays');
    assert.equal(fieldOf(() => normalizeConfig({ ...RAW, holidays: ['2026-12-25'] })), 'brak błędu');
  });

  test('etykieta kontroli życia jest wymagana i musi być tekstem', () => {
    assert.equal(fieldOf(() => normalizeLivenessConfig({ ...LIVENESS_RAW, label: undefined })), 'label');
    assert.equal(fieldOf(() => normalizeLivenessConfig({ ...LIVENESS_RAW, label: ['zrodlo-1'] })), 'label');
  });
});

describe('#295 czas ścienny i kalibracja: brzegi', () => {
  test('zaokrąglenie połówek od zera zachowuje znak zera', () => {
    assert.ok(Object.is(roundHalfAwayFromZero(0), 0));
    assert.equal(roundHalfAwayFromZero(-2.5), -3);
    assert.equal(roundHalfAwayFromZero(-2.4), -2);
    assert.equal(roundHalfAwayFromZero(2.4), 2);
    assert.equal(roundHalfAwayFromZero(2.5), 3);
  });

  test('wartość niebędąca datą ani tekstem to null, także gdy wygląda jak tekst daty', () => {
    assert.equal(wallSeconds(['2026-11-18 09:00:00'], 'Europe/Warsaw'), null);
    assert.equal(wallSeconds({ toString: () => '2026-11-18 09:00:00' }, 'Europe/Warsaw'), null);
    assert.equal(wallSeconds('2026-11-18 09:00:00', 'Europe/Warsaw'), Date.UTC(2026, 10, 18, 9) / 1000);
  });

  test('kalibracja: znacznik równy chwili „teraz” wchodzi do próby, a znacznik spoza kontraktu nie', () => {
    const config = makeConfig();
    const now = at('2026-11-18 10:00:00');
    const result = calibrateThreshold({ stamps: ['2026-11-18 08:00:00', '2026-11-18 10:00:00', 'nie-data', null], now, config });
    assert.equal(result.samples, 2);
    assert.equal(result.longestGapHours, 2);
    const future = calibrateThreshold({ stamps: ['2026-11-18 08:00:00', '2026-11-18 10:00:01'], now, config });
    assert.equal(future.samples, 1);
  });
});

describe('#295 adaptery: brzegi', () => {
  test('czytnik odrzuca identyfikator i komórkę niebędące tekstem, nawet gdy po zamianie na tekst pasują', () => {
    const base = { fileId: FILE_ID, range: 'A1', token: 't', fetchFn: async () => ({}) };
    for (const [patch, field] of [
      [{ fileId: undefined }, 'fileId'], [{ fileId: [FILE_ID] }, 'fileId'],
      [{ range: undefined }, 'range'], [{ range: ['A1'] }, 'range']
    ]) {
      assert.throws(() => createSheetsReader({ ...base, ...patch }), error => error instanceof ReaderConfigError && error.message === `READER_CONFIG_INVALID:${field}`);
    }
    createSheetsReader(base);
  });

  test('magazyn: wersja z rev-parse musi być dokładnie 40 znakami szesnastkowymi', async () => {
    const storeWith = revParse => createGitStore({
      exec: async args => {
        if (args[0] === 'rev-parse') return { status: 0, stdout: `${revParse}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      }
    });
    for (const bad of [`a${SHA}`, `${SHA}a`, 'xyz', SHA.toUpperCase(), '']) {
      await assert.rejects(storeWith(bad).read(), error => error instanceof StoreError && error.message === 'GIT_REV_PARSE_FAILED', bad);
    }
    assert.equal((await storeWith(SHA).read()).version, SHA);
  });
});

describe('#295 protokół: brzegi', () => {
  const alertStale = { alertLevel: 'ALERT_STALE', deferred: false };
  const now = at('2026-11-18 10:00:00');
  const config = makeConfig();

  test('eventId wiadomości: nowy alarm dostaje własny messageId, przypomnienie i powrót zachowują zdarzenie', () => {
    const fresh = determineMessage(initialSourceState(), alertStale, now, config);
    assert.equal(fresh.kind, 'ALERT_STALE');
    assert.equal(fresh.eventId, `${LABEL}#1`);
    const error = determineMessage(initialSourceState(), { alertLevel: 'ALERT_ERROR', deferred: false }, now, config);
    assert.equal(error.eventId, `${LABEL}#1`);
    const recovery = determineMessage(notifiedState('ALERT_STALE'), { alertLevel: 'OK', deferred: false }, now, config);
    assert.equal(recovery.kind, 'RECOVERY');
    assert.equal(recovery.eventId, `${LABEL}#3`);
    const reminder = determineMessage(notifiedState('ALERT_STALE', { lastNotifiedAt: '2026-11-13T08:00:00.000Z' }), alertStale, now, config);
    assert.equal(reminder.kind, 'REMINDER');
    assert.equal(reminder.eventId, `${LABEL}#3`);
  });

  test('stan OK po powrocie nie dostaje „przypomnienia” mimo dawnej wiadomości', async () => {
    const store = createStore(notifiedState('OK'));
    const { deps, result } = await run({ store, reader: createReader('2026-11-23 11:00:00'), clock: () => at('2026-11-23 12:00:00') });
    assert.equal(deps.sender.calls, 0);
    assert.equal(result.green, true);
  });

  test('rozliczenie: wiadomość o tym samym kluczu, już zapisana, nie nadpisuje stanu', () => {
    const state = notifiedState('ALERT_STALE', { lastNotifiedAt: '2026-11-18T08:30:00.000Z', undeliveredSince: '2026-11-18T08:45:00.000Z' });
    const message = {
      kind: 'ALERT_STALE', notifiedState: 'ALERT_STALE', seq: 3, messageId: `${LABEL}#3`, key: `${LABEL}#3:ALERT_STALE`,
      eventId: `${LABEL}#3`, sentAt: '2026-11-18T09:00:00.000Z'
    };
    assert.deepEqual(reconcile(state, [message]), state);
  });

  test('log: odroczony alarm i brak powodu mają stały zapis', async () => {
    const okLine = (await run({ reader: createReader(OK_MARKER) })).deps.lines[0];
    assert.equal(okLine, '[zrodlo-1] stan=OK surowy=ACTIVE powod=- wiek_h=1 praca_h=1 prog_h=6 limit_h=96 odroczony=nie zdarzenie=- przebieg=2026-11-18T09:00:00.000Z');
    const night = await run({ reader: createReader('2026-11-17 08:00:00'), clock: () => at('2026-11-18 20:00:00') });
    assert.match(night.deps.lines[0], / odroczony=tak /);
    assert.equal(night.deps.sender.calls, 0);
  });

  test('log: problemy zapisu, odczytu po konflikcie i wyczerpania prób mają stałe zapisy', async () => {
    const writeStore = createStore(null);
    writeStore.failNextWrites = 1;
    const write = await run({ store: writeStore });
    assert.ok(write.deps.lines.includes('[zrodlo-1] problem=STATE_WRITE_FAILED'));

    const readStore = createStore(notifiedState('OK'));
    readStore.beforeWrite = async () => { readStore.external({}); readStore.failReads = true; };
    const read = await run({ store: readStore });
    assert.ok(read.deps.lines.includes('[zrodlo-1] problem=STATE_READ_FAILED'));

    const exhaustedStore = createStore(notifiedState('OK'));
    exhaustedStore.beforeWrite = async () => exhaustedStore.external({});
    const exhausted = await run({ store: exhaustedStore });
    assert.ok(exhausted.deps.lines.includes('[zrodlo-1] problem=COMMIT_EXHAUSTED'));
  });

  test('nieudana wysyłka razem z wyczerpanymi próbami zapisu to oba problemy w tej kolejności', async () => {
    const store = createStore(notifiedState('OK'));
    store.beforeWrite = async () => store.external({});
    const { result } = await run({ store, reader: createReader(STALE_MARKER), sender: createSender(['unconfirmed']) });
    assert.deepEqual(result.problems, ['SEND_FAILED', 'COMMIT_EXHAUSTED']);
  });
});

describe('#295 CLI: składanie adapterów i wejście procesu', () => {
  const clock = () => at('2026-11-18 10:00:00');

  test('domyślny magazyn używa podanego wykonawcy gita w STATE_REPO_DIR, a domyślny nadawca nie blokuje przebiegu', async () => {
    const calls = [];
    const spawn = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      const out = { ls: { status: 2, stdout: '', stderr: '' } };
      if (args[0] === 'ls-remote') return out.ls;
      const stdout = { 'hash-object': 'b'.repeat(40), mktree: 'c'.repeat(40), 'commit-tree': 'd'.repeat(40) }[args[0]] || '';
      return { status: 0, stdout, stderr: '' };
    };
    const io = makeIo();
    assert.equal(await main(['check'], ENV(), io, { reader: createReader(OK_MARKER), clock, spawn }), 0);
    assert.ok(calls.length >= 5);
    assert.ok(calls.every(call => call.command === 'git' && call.cwd === 'katalog-nieistniejacy'));
    assert.deepEqual(calls.map(call => call.args[0]).slice(0, 2), ['ls-remote', 'hash-object']);
    assert.deepEqual(io.err, []);
  });

  test('czytanie pliku stanu zwraca tekst, a brak pliku to null', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-monitor-edge-')), 'state.json');
    try {
      fs.writeFileSync(file, 'tekst');
      assert.equal(typeof readStateFile(file), 'string');
      assert.equal(readStateFile(file), 'tekst');
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
    assert.equal(readStateFile(file), null);
  });

  test('domyślne oczekiwanie przed ponowieniem odczytu trwa 60 s (przebieg czeka na zegar)', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const io = makeIo();
      let settled = false;
      const pending = main(['check'], ENV(), io, {
        reader: createReader(new Error('x'), OK_MARKER), store: createStore(null), sender: createSender(), clock
      }).then(code => { settled = true; return code; });
      for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'bez upływu czasu przebieg nie może się skończyć');
      mock.timers.tick(59999);
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'jeszcze przed upływem 60 s');
      mock.timers.tick(1);
      assert.equal(await pending, 0);
    } finally {
      mock.timers.reset();
    }
  });

  describe('proces: kody wyjścia przechodzą do systemu', () => {
    const runCli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
    const withState = (source, action) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-monitor-proc-'));
      const file = path.join(dir, 'state.json');
      fs.writeFileSync(file, serializeStateFile({ sources: { 'zrodlo-1': { ...initialSourceState(), ...source } } }));
      try {
        return action(file);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const env = { FRESHNESS_LIVENESS_CONFIG: JSON.stringify(LIVENESS_RAW) };

    test('kontrola życia: świeży puls to kod 0, stary puls to kod 1', () => {
      const fresh = withState({ lastSuccessfulCheckAt: new Date().toISOString() }, file => runCli(['liveness', '--state', file], env));
      assert.equal(fresh.status, 0, fresh.stderr);
      assert.match(fresh.stdout, /kontrola_zycia=OK/);
      const old = withState({ lastSuccessfulCheckAt: '2020-01-01T00:00:00.000Z' }, file => runCli(['liveness', '--state', file], env));
      assert.equal(old.status, 1);
      assert.match(old.stdout, /kontrola_zycia=ALERT/);
    });

    test('błędne wywołanie to kod 2 i użycie na stderr', () => {
      const out = runCli([], {});
      assert.equal(out.status, 2);
      assert.match(out.stderr, /użycie: cli\.js check \| liveness --state <plik>/);
    });
  });
});
