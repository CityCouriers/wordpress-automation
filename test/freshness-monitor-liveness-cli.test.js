'use strict';

/**
 * #295: niezależna kontrola życia sprawdzacza (W1, przypadek 27 w części, którą da się sprawdzić bez instalacji)
 * oraz wejście CLI. Kontrola ocenia plik stanu; dostarczenie jej alarmu należy do procesu instalacji.
 */

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { at } = require('./helpers/zone');
const { stripGitEnv } = require('./helpers/git-env');
const { OK_MARKER, STALE_MARKER, CONFIG_RAW, createReader, createSender, createStore, leakyError, notifiedState } = require('./helpers/monitor-fakes');
const { evaluateLiveness } = require('../scripts/freshness-monitor/liveness');
const { normalizeLivenessConfig, ConfigError } = require('../scripts/freshness-monitor/config');
const { initialSourceState, serializeStateFile } = require('../scripts/freshness-monitor/state');
const { main, safeCode } = require('../scripts/freshness-monitor/cli');

stripGitEnv();

const LIVENESS_RAW = { label: 'zrodlo-1', timeZone: 'Europe/Warsaw', window: { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' } };
const live = (extra = {}) => normalizeLivenessConfig({ ...LIVENESS_RAW, ...extra });
const stateText = patch => serializeStateFile({ sources: { 'zrodlo-1': { ...initialSourceState(), ...patch } } });
const evaluate = (patch, nowText, extra) => evaluateLiveness({ text: stateText(patch), now: at(nowText), config: live(extra) });

describe('#295 W1: ocena życia sprawdzacza z pliku stanu', () => {
  test('konfiguracja kontroli: wartości domyślne (6 h pracy, 26 h bezwzględnie), walidacja jak w sprawdzaczu', () => {
    const c = live();
    assert.deepEqual([c.deadWorkingHours, c.deadHardHours, c.label, c.timeZone, c.holidays.length], [6, 26, 'zrodlo-1', 'Europe/Warsaw', 0]);
    assert.ok(Object.isFrozen(c));
    assert.equal(live({ deadWorkingHours: 3, deadHardHours: 10, holidays: ['2026-11-11'] }).holidays[0], '2026-11-11');
    for (const [patch, field] of [
      [{ label: 'Zły' }, 'label'], [{ timeZone: 'Nie/Ma' }, 'timeZone'], [{ window: undefined }, 'window'],
      [{ deadWorkingHours: 0 }, 'deadWorkingHours'], [{ deadHardHours: '26' }, 'deadHardHours'],
      [{ holidays: ['x'] }, 'holidays'], [{ rawThresholdHours: 2 }, 'unknown']
    ]) {
      assert.throws(() => live(patch), err => err instanceof ConfigError && err.field === field, field);
    }
    for (const input of [null, undefined, [], 'x']) assert.throws(() => normalizeLivenessConfig(input), err => err.field === 'config');
  });

  test('puls świeży: OK, z wiekiem w pełnych godzinach i bez niedostarczonej wiadomości', () => {
    const v = evaluate({ lastSuccessfulCheckAt: at('2026-11-18 09:30:00').toISOString() }, '2026-11-18 10:00:00');
    assert.deepEqual(v, { level: 'OK', reasons: [], heartbeatAgeHours: 0, undeliveredAgeHours: null });
    const v2 = evaluate({ lastSuccessfulCheckAt: at('2026-11-18 07:00:00').toISOString() }, '2026-11-18 10:00:00');
    assert.equal(v2.heartbeatAgeHours, 3);
  });

  test('brak stanu źródła, brak pulsu i plik nie do odczytu to alarm', () => {
    assert.deepEqual(evaluateLiveness({ text: null, now: at('2026-11-18 10:00:00'), config: live() }),
      { level: 'ALERT', reasons: ['NO_STATE'], heartbeatAgeHours: null, undeliveredAgeHours: null });
    assert.deepEqual(evaluateLiveness({ text: '{"sources":{}}', now: at('2026-11-18 10:00:00'), config: live() }).reasons, ['NO_STATE']);
    const other = serializeStateFile({ sources: { 'inne-zrodlo': initialSourceState() } });
    assert.deepEqual(evaluateLiveness({ text: other, now: at('2026-11-18 10:00:00'), config: live() }).reasons, ['NO_STATE']);
    assert.deepEqual(evaluate({}, '2026-11-18 10:00:00').reasons, ['NO_HEARTBEAT']);
    for (const text of ['{', 'null', '{"sources":{"zrodlo-1":{"messageSeq":"x"}}}', '[]']) {
      assert.deepEqual(evaluateLiveness({ text, now: at('2026-11-18 10:00:00'), config: live() }),
        { level: 'ALERT', reasons: ['STATE_INVALID'], heartbeatAgeHours: null, undeliveredAgeHours: null }, text);
    }
  });

  test('27: wyłączony harmonogram — puls starszy niż 6 godzin pracy to alarm HEARTBEAT_STALE, granica jest ostra', () => {
    // Środa 08:00 → 14:00 to dokładnie 6 h pracy (jeszcze OK); sekunda więcej to alarm.
    const heartbeat = at('2026-11-18 08:00:00').toISOString();
    assert.equal(evaluate({ lastSuccessfulCheckAt: heartbeat }, '2026-11-18 14:00:00').level, 'OK');
    const late = evaluate({ lastSuccessfulCheckAt: heartbeat }, '2026-11-18 14:00:01');
    assert.deepEqual([late.level, late.reasons, late.heartbeatAgeHours], ['ALERT', ['HEARTBEAT_STALE'], 6]);
  });

  test('27: termin bezwzględny 26 h działa także poza godzinami pracy (weekend) i jest ostry', () => {
    // Piątek 17:00 → sobota 19:00 = 26 h rzeczywistych, 1 h pracy: OK; sekunda więcej to alarm z terminu bezwzględnego.
    const heartbeat = at('2026-11-13 17:00:00').toISOString();
    assert.equal(evaluate({ lastSuccessfulCheckAt: heartbeat }, '2026-11-14 19:00:00').level, 'OK');
    const late = evaluate({ lastSuccessfulCheckAt: heartbeat }, '2026-11-14 19:00:01');
    assert.deepEqual([late.level, late.reasons], ['ALERT', ['HEARTBEAT_STALE']]);
    assert.equal(late.heartbeatAgeHours, 26);
  });

  test('noc i weekend bez przebiegów w oknie pracy nie dają fałszywego alarmu, a terminy pochodzą z konfiguracji', () => {
    const heartbeat = at('2026-11-17 17:30:00').toISOString();
    assert.equal(evaluate({ lastSuccessfulCheckAt: heartbeat }, '2026-11-18 08:30:00').level, 'OK');
    assert.equal(evaluate({ lastSuccessfulCheckAt: heartbeat }, '2026-11-18 08:30:00', { deadWorkingHours: 0.25 }).level, 'ALERT');
    assert.equal(evaluate({ lastSuccessfulCheckAt: heartbeat }, '2026-11-18 08:30:00', { deadHardHours: 10 }).level, 'ALERT');
    assert.equal(evaluate({ lastSuccessfulCheckAt: at('2026-11-10 16:00:00').toISOString() }, '2026-11-12 09:00:00', { holidays: ['2026-11-11'], deadWorkingHours: 3, deadHardHours: 100 }).level, 'OK');
  });

  test('puls z przyszłości to HEARTBEAT_INVALID (niespójny zegar nie jest życiem)', () => {
    const v = evaluate({ lastSuccessfulCheckAt: at('2026-11-18 10:00:01').toISOString() }, '2026-11-18 10:00:00');
    assert.deepEqual([v.level, v.reasons, v.heartbeatAgeHours], ['ALERT', ['HEARTBEAT_INVALID'], null]);
    assert.equal(evaluate({ lastSuccessfulCheckAt: at('2026-11-18 10:00:00').toISOString() }, '2026-11-18 10:00:00').level, 'OK');
  });

  test('niedostarczona wiadomość starsza niż termin to UNDELIVERED_STALE, także gdy puls jest świeży', () => {
    const base = { lastSuccessfulCheckAt: at('2026-11-18 13:55:00').toISOString() };
    assert.equal(evaluate({ ...base, undeliveredSince: at('2026-11-18 08:00:00').toISOString() }, '2026-11-18 14:00:00').level, 'OK');
    const late = evaluate({ ...base, lastSuccessfulCheckAt: at('2026-11-18 13:59:59').toISOString(), undeliveredSince: at('2026-11-18 08:00:00').toISOString() }, '2026-11-18 14:00:01');
    assert.deepEqual([late.level, late.reasons, late.undeliveredAgeHours, late.heartbeatAgeHours], ['ALERT', ['UNDELIVERED_STALE'], 6, 0]);
    const both = evaluate({ lastSuccessfulCheckAt: at('2026-11-14 10:00:00').toISOString(), undeliveredSince: at('2026-11-14 10:00:00').toISOString() }, '2026-11-18 10:00:00');
    assert.deepEqual(both.reasons, ['HEARTBEAT_STALE', 'UNDELIVERED_STALE']);
    const future = evaluate({ ...base, undeliveredSince: at('2026-11-18 14:00:01').toISOString() }, '2026-11-18 14:00:00');
    assert.deepEqual([future.reasons, future.undeliveredAgeHours], [['UNDELIVERED_STALE'], null]);
  });

  test('końcowy scenariusz z magazynem: sprawdzacz działał, a potem „wyłączono harmonogram”', async () => {
    const store = createStore(null);
    const { runCheck } = require('../scripts/freshness-monitor/monitor');
    await runCheck({
      config: require('./helpers/monitor-fakes').makeConfig(), clock: () => at('2026-11-18 10:00:00'), reader: createReader(OK_MARKER),
      store, sender: createSender(), sleep: async () => {}, log: () => {}
    });
    const config = live();
    assert.equal(evaluateLiveness({ text: store.text, now: at('2026-11-18 10:30:00'), config }).level, 'OK');
    // Brak kolejnych przebiegów: po 6 godzinach pracy kontrola zgłasza brak życia.
    assert.equal(evaluateLiveness({ text: store.text, now: at('2026-11-18 16:00:01'), config }).level, 'ALERT');
  });
});

function makeIo() {
  const io = { out: [], err: [], log: line => io.out.push(line), error: line => io.err.push(line) };
  return io;
}

const ENV = () => ({
  FRESHNESS_MONITOR_CONFIG: JSON.stringify(CONFIG_RAW),
  FRESHNESS_LIVENESS_CONFIG: JSON.stringify(LIVENESS_RAW),
  SIGNAL_FILE_ID: 'SYNTH0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  SIGNAL_RANGE: 'A1',
  GOOGLE_ACCESS_TOKEN: 'tok-synth',
  ALERT_WEBHOOK_URL: 'https://hooks.example.invalid/synthetic-channel',
  STATE_REPO_DIR: 'katalog-nieistniejacy'
});

describe('#295 CLI: check', () => {
  const deps = (extra = {}) => ({
    reader: createReader(OK_MARKER), store: createStore(null), sender: createSender(), clock: () => at('2026-11-18 10:00:00'), sleep: async () => {}, ...extra
  });

  test('zielony przebieg to kod 0, a log trafia na wyjście', async () => {
    const io = makeIo();
    assert.equal(await main(['check'], ENV(), io, deps()), 0);
    assert.equal(io.out.length, 1);
    assert.match(io.out[0], /^\[zrodlo-1\] stan=OK /);
    assert.deepEqual(io.err, []);
  });

  test('czerwony przebieg (ALERT_STALE) to kod 1, także gdy wiadomość została dostarczona', async () => {
    const io = makeIo();
    const d = deps({ reader: createReader(STALE_MARKER) });
    assert.equal(await main(['check'], ENV(), io, d), 1);
    assert.equal(d.sender.sent.length, 1);
  });

  test('zły JSON i zła konfiguracja to kod 2 z samym kodem błędu, bez wartości', async () => {
    for (const [value, expected] of [
      ['{', 'CONFIG_INVALID:config'], [undefined, 'CONFIG_INVALID:config'], ['null', 'CONFIG_INVALID:config'],
      [JSON.stringify({ ...CONFIG_RAW, label: 'ktos@example.invalid' }), 'CONFIG_INVALID:label'],
      [JSON.stringify({ ...CONFIG_RAW, hasloDoWpisania: 'tajne-wartosc' }), 'CONFIG_INVALID:unknown']
    ]) {
      const io = makeIo();
      const env = { ...ENV(), FRESHNESS_MONITOR_CONFIG: value };
      assert.equal(await main(['check'], env, io, deps()), 2, String(value));
      assert.deepEqual(io.err, [`[monitor] problem=${expected}`]);
      assert.deepEqual(io.out, []);
    }
  });

  test('brak albo zła konfiguracja adapterów to kod 2 z kodem pola', async () => {
    for (const [patch, expected] of [
      [{ SIGNAL_FILE_ID: undefined }, 'READER_CONFIG_INVALID:fileId'],
      [{ SIGNAL_RANGE: 'A1:B2' }, 'READER_CONFIG_INVALID:range'],
      [{ GOOGLE_ACCESS_TOKEN: '' }, 'READER_CONFIG_INVALID:token'],
      [{ ALERT_WEBHOOK_URL: 'http://hooks.example.invalid/x' }, 'SENDER_CONFIG_INVALID:url']
    ]) {
      const io = makeIo();
      assert.equal(await main(['check'], { ...ENV(), ...patch }, io, { store: createStore(null), clock: () => at('2026-11-18 10:00:00') }), 2);
      assert.deepEqual(io.err, [`[monitor] problem=${expected}`]);
    }
  });

  test('domyślny magazyn to gałąź gita w STATE_REPO_DIR; błąd gita to czerwony przebieg bez tekstu błędu', async () => {
    const io = makeIo();
    const d = deps({ store: undefined });
    delete d.store;
    const env = { ...ENV(), STATE_REPO_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-monitor-cli-')) };
    try {
      assert.equal(await main(['check'], env, io, d), 1);
    } finally {
      fs.rmSync(env.STATE_REPO_DIR, { recursive: true, force: true });
    }
    assert.deepEqual(io.out, ['[zrodlo-1] problem=STATE_READ_FAILED']);
  });

  test('domyślny zegar i domyślne oczekiwanie (60 s, zegar sztuczny) działają, a odczyt ponowiony zielony przebieg daje kod 0', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      const now = new Date();
      const marker = (() => {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        }).formatToParts(now).map(p => [p.type, p.value]));
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
      })();
      const io = makeIo();
      const d = { reader: createReader(leakyError(503), marker), store: createStore(null), sender: createSender() };
      const pending = main(['check'], ENV(), io, d);
      // Poczekaj, aż przebieg dojdzie do oczekiwania na ponowienie odczytu, i przesuń zegar o 60 s.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      mock.timers.tick(60000);
      assert.equal(await pending, 0);
      assert.match(io.out[0], /^\[zrodlo-1\] stan=OK /);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('#295 CLI: liveness i użycie', () => {
  const withStateFile = (text, fn) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-monitor-live-'));
    const file = path.join(dir, 'state.json');
    if (text !== null) fs.writeFileSync(file, text);
    return Promise.resolve(fn(file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  };
  const clock = () => at('2026-11-18 10:00:00');

  test('OK to kod 0 i jedna linia z polami o stałym kształcie', async () => {
    const io = makeIo();
    const text = stateText({ lastSuccessfulCheckAt: at('2026-11-18 09:30:00').toISOString() });
    const code = await withStateFile(text, file => main(['liveness', '--state', file], ENV(), io, { clock }));
    assert.equal(code, 0);
    assert.deepEqual(io.out, ['[zrodlo-1] kontrola_zycia=OK powody=- puls_h=0 niedostarczona_h=- przebieg=2026-11-18T09:00:00.000Z']);
  });

  test('ALERT to kod 1 z powodami; brak pliku stanu to NO_STATE', async () => {
    const io = makeIo();
    const text = stateText({ lastSuccessfulCheckAt: at('2026-11-10 09:30:00').toISOString(), undeliveredSince: at('2026-11-10 09:30:00').toISOString() });
    assert.equal(await withStateFile(text, file => main(['liveness', '--state', file], ENV(), io, { clock })), 1);
    assert.equal(io.out[0], '[zrodlo-1] kontrola_zycia=ALERT powody=HEARTBEAT_STALE,UNDELIVERED_STALE puls_h=192 niedostarczona_h=192 przebieg=2026-11-18T09:00:00.000Z');
    const io2 = makeIo();
    assert.equal(await withStateFile(null, file => main(['liveness', '--state', file], ENV(), io2, { clock })), 1);
    assert.equal(io2.out[0], '[zrodlo-1] kontrola_zycia=ALERT powody=NO_STATE puls_h=- niedostarczona_h=- przebieg=2026-11-18T09:00:00.000Z');
  });

  test('brak --state albo zła konfiguracja kontroli to kod 2', async () => {
    for (const [argv, env, expected] of [
      [['liveness'], ENV(), 'CONFIG_INVALID:state'],
      [['liveness', '--inne', 'x'], ENV(), 'CONFIG_INVALID:state'],
      [['liveness', '--state', 'plik'], { ...ENV(), FRESHNESS_LIVENESS_CONFIG: '{' }, 'CONFIG_INVALID:config'],
      [['liveness', '--state', 'plik'], { ...ENV(), FRESHNESS_LIVENESS_CONFIG: JSON.stringify({ ...LIVENESS_RAW, tajne: 'x' }) }, 'CONFIG_INVALID:unknown']
    ]) {
      const io = makeIo();
      assert.equal(await main(argv, env, io, { clock }), 2);
      assert.deepEqual(io.err, [`[monitor] problem=${expected}`]);
    }
  });

  test('domyślny zegar kontroli życia to bieżąca chwila', async () => {
    const io = makeIo();
    const text = stateText({ lastSuccessfulCheckAt: new Date().toISOString() });
    assert.equal(await withStateFile(text, file => main(['liveness', '--state', file], ENV(), io)), 0);
  });

  test('nieznane polecenie to kod 2 i opis użycia; brak polecenia też', async () => {
    for (const argv of [[], ['nieznane'], ['CHECK']]) {
      const io = makeIo();
      assert.equal(await main(argv, ENV(), io, {}), 2);
      assert.deepEqual(io.err, ['użycie: cli.js check | liveness --state <plik>']);
    }
  });

  test('safeCode przepuszcza tylko stałe kody', () => {
    assert.equal(safeCode(new Error('CONFIG_INVALID:label'), 'X'), 'CONFIG_INVALID:label');
    assert.equal(safeCode(new Error('SETUP_FAILED'), 'X'), 'SETUP_FAILED');
    for (const error of [new Error('https://x.example.invalid'), new Error('config_invalid'), new Error('A:b:c'), new Error('A:'), new Error(''), null, undefined, {}, { message: 5 }]) {
      assert.equal(safeCode(error, 'X'), 'X', String(error && error.message));
    }
  });

  test('CLI jest zgodny ze stanem z notifiedState (pomocnik nie rozjeżdża się ze schematem)', () => {
    assert.doesNotThrow(() => serializeStateFile({ sources: { 'zrodlo-1': notifiedState('ALERT_STALE') } }));
  });
});
