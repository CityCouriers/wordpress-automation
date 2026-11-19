'use strict';

/**
 * Atrapy do testów sprawdzacza świeżości (#295): magazyn stanu z porównaniem wersji, nadawca z potwierdzeniem,
 * czytnik znacznika i zegar. Dane są syntetyczne; żadna atrapa nie zna prawdziwej instalacji.
 */

const { at } = require('./zone');
const { normalizeConfig } = require('../../scripts/freshness-monitor/config');
const { initialSourceState, parseStateFile, serializeStateFile } = require('../../scripts/freshness-monitor/state');
const { runCheck } = require('../../scripts/freshness-monitor/monitor');

const LABEL = 'zrodlo-1';
const NOW = at('2026-11-18 10:00:00'); // środa, w oknie pracy
const OK_MARKER = '2026-11-18 09:00:00';
const STALE_MARKER = '2026-11-17 08:00:00'; // 26 h wieku, 12 h pracy: ALERT_STALE z progu godzin pracy

const CONFIG_RAW = Object.freeze({
  label: LABEL,
  timeZone: 'Europe/Warsaw',
  rawThresholdHours: 2,
  workingHoursThresholdHours: 6,
  window: { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }
});

const makeConfig = (extra = {}) => normalizeConfig({ ...CONFIG_RAW, ...extra });

/** Błąd, który wygląda jak wyciek: komunikat z adresem, identyfikatorem pliku i adresem e-mail. */
const LEAKY_MESSAGE = 'GET https://sheets.example.invalid/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg/values/A1 ' +
  'odpowiedź: jan.kowalski@example.invalid';

function leakyError(status) {
  const error = new Error(LEAKY_MESSAGE);
  if (status !== undefined) error.status = status;
  return error;
}

/** Magazyn w pamięci: `write` odrzuca zapis na starej wersji (non-fast-forward). */
function createStore(initialSource = null) {
  const store = {
    text: initialSource === null ? null : serializeStateFile({ sources: { [LABEL]: initialSource } }),
    version: initialSource === null ? null : 'v0',
    counter: 0,
    commits: [],
    reads: 0,
    writes: 0,
    failReads: false,
    failNextWrites: 0,
    beforeWrite: null,
    gate: null,
    async read() {
      store.reads++;
      if (store.failReads) throw leakyError(500);
      const snapshot = { text: store.text, version: store.version };
      if (store.gate) await store.gate();
      return snapshot;
    },
    async write(text, version) {
      store.writes++;
      if (store.beforeWrite) await store.beforeWrite(store.writes);
      if (store.failNextWrites > 0) {
        store.failNextWrites--;
        throw leakyError();
      }
      if (version !== store.version) return { ok: false, conflict: true };
      store.counter++;
      store.version = `v${store.counter}`;
      store.text = text;
      store.commits.push(text);
      return { ok: true, version: store.version };
    },
    /** Commit „innego przebiegu”: zmienia wersję i stan źródła o podane pola. */
    external(patch) {
      const doc = parseStateFile(store.text);
      const current = doc.sources[LABEL] || initialSourceState();
      store.counter++;
      store.version = `v${store.counter}`;
      store.text = serializeStateFile({ sources: { ...doc.sources, [LABEL]: { ...current, ...patch } } });
      store.commits.push(store.text);
    },
    source() {
      return parseStateFile(store.text).sources[LABEL];
    }
  };
  return store;
}

/** Bariera: `parties` pierwszych wywołań czeka, aż dotrą wszystkie. */
function barrier(parties) {
  let arrived = 0;
  let release;
  const all = new Promise(resolve => { release = resolve; });
  return () => {
    arrived++;
    if (arrived >= parties) release();
    return all;
  };
}

/** Nadawca: kolejne wyniki z `plan` ('ok' | 'unconfirmed' | 'throw'); po wyczerpaniu planu ostatni się powtarza. */
function createSender(plan = ['ok']) {
  const sender = {
    sent: [],
    calls: 0,
    async send(message) {
      const outcome = plan[Math.min(sender.calls, plan.length - 1)];
      sender.calls++;
      sender.sent.push(message);
      if (outcome === 'throw') throw leakyError(503);
      return { confirmed: outcome === 'ok' };
    },
    keys() {
      return sender.sent.map(m => m.key);
    }
  };
  return sender;
}

/** Czytnik: wartości (albo błędy) po kolei; ostatnia się powtarza. */
function createReader(...results) {
  const reader = {
    calls: 0,
    async read() {
      const result = results[Math.min(reader.calls, results.length - 1)];
      reader.calls++;
      if (result instanceof Error) throw result;
      return result;
    }
  };
  return reader;
}

/** Atrapy zebrane w jedną całość dla `runCheck`. */
function createDeps(overrides = {}) {
  const sleeps = [];
  const lines = [];
  const deps = {
    config: makeConfig(),
    clock: () => NOW,
    reader: createReader(OK_MARKER),
    store: createStore(null),
    sender: createSender(),
    sleep: async ms => { sleeps.push(ms); },
    log: line => { lines.push(line); },
    ...overrides
  };
  deps.sleeps = sleeps;
  deps.lines = lines;
  return deps;
}

async function run(overrides) {
  const deps = createDeps(overrides);
  const result = await runCheck(deps);
  return { result, deps };
}

/** Stan źródła po ostatniej potwierdzonej wiadomości danego rodzaju. */
function notifiedState(level, patch = {}) {
  const seq = 3;
  const keys = { OK: 'zrodlo-1#3:RECOVERY', ALERT_STALE: 'zrodlo-1#3:ALERT_STALE', ALERT_ERROR: 'zrodlo-1#3:ALERT_ERROR' };
  return {
    ...initialSourceState(),
    lastObservedState: level,
    lastObservedAt: '2026-11-18T08:30:00.000Z',
    lastNotifiedState: level,
    lastNotifiedAt: '2026-11-18T08:30:00.000Z',
    lastNotifiedKey: keys[level],
    messageSeq: seq,
    eventId: level === 'OK' ? null : 'zrodlo-1#3',
    lastSuccessfulCheckAt: '2026-11-18T08:30:00.000Z',
    ...patch
  };
}

module.exports = {
  CONFIG_RAW, LABEL, LEAKY_MESSAGE, NOW, OK_MARKER, STALE_MARKER,
  barrier, createDeps, createReader, createSender, createStore, leakyError, makeConfig, notifiedState, run
};
