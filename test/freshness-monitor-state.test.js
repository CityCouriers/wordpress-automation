'use strict';

/**
 * Bezpośrednie testy modułów stanu i treści wiadomości sprawdzacza świeżości (#295): schemat stanu jest
 * ścisły (dziewięć pól, ścisłe typy i zakresy), a treść wiadomości zawiera tylko dozwolone dane.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LEVELS, STATE_FIELDS, StateError,
  initialSourceState, keyFor, messageIdFor, parseStateFile, serializeStateFile, sourceState, withSourceState
} = require('../scripts/freshness-monitor/state');
const { buildMessage } = require('../scripts/freshness-monitor/messages');
const { makeConfig } = require('./helpers/monitor-fakes');
const { at } = require('./helpers/zone');

const ISO = '2026-11-18T09:00:00.000Z';

const valid = (extra = {}) => ({ ...initialSourceState(), ...extra });
const docText = source => JSON.stringify({ sources: { a: source } });
const rejects = text => assert.throws(() => parseStateFile(text), error => {
  assert.ok(error instanceof StateError);
  assert.equal(error.message, 'STATE_INVALID');
  assert.equal(error.name, 'StateError');
  assert.equal(error.code, 'STATE_INVALID');
  return true;
});

test('stan: stałe schematu to dokładnie poziomy i dziewięć pól', () => {
  assert.deepEqual(LEVELS, ['OK', 'ALERT_STALE', 'ALERT_ERROR']);
  assert.deepEqual(STATE_FIELDS, [
    'lastObservedState', 'lastObservedAt', 'lastNotifiedState', 'lastNotifiedAt', 'lastNotifiedKey',
    'messageSeq', 'eventId', 'undeliveredSince', 'lastSuccessfulCheckAt'
  ]);
});

test('stan: początkowy stan źródła nie wysłał nic', () => {
  assert.deepEqual(initialSourceState(), {
    lastObservedState: null, lastObservedAt: null, lastNotifiedState: 'OK', lastNotifiedAt: null,
    lastNotifiedKey: null, messageSeq: 0, eventId: null, undeliveredSince: null, lastSuccessfulCheckAt: null
  });
});

test('stan: brak pliku i pusty tekst to brak stanu', () => {
  assert.deepEqual(parseStateFile(null), { sources: {} });
  assert.deepEqual(parseStateFile(''), { sources: {} });
});

test('stan: poprawny dokument przechodzi, także z wypełnionymi polami', () => {
  const full = valid({
    lastObservedState: 'ALERT_STALE', lastObservedAt: ISO, lastNotifiedState: 'ALERT_ERROR', lastNotifiedAt: ISO,
    lastNotifiedKey: 'a#1:ALERT_STALE', messageSeq: 1, eventId: 'a#1', undeliveredSince: ISO, lastSuccessfulCheckAt: ISO
  });
  assert.deepEqual(parseStateFile(docText(full)), { sources: { a: full } });
  assert.deepEqual(parseStateFile(JSON.stringify({ sources: {} })), { sources: {} });
});

test('stan: zły JSON i zły kształt dokumentu to StateError', () => {
  rejects('{');
  rejects('null');
  rejects('[]');
  rejects('1');
  rejects('{}');
  rejects(JSON.stringify({ sources: {}, extra: 1 }));
  rejects(JSON.stringify({ other: {} }));
  rejects(JSON.stringify({ sources: null }));
  rejects(JSON.stringify({ sources: [] }));
  rejects(JSON.stringify({ sources: 'x' }));
  rejects(JSON.stringify({ sources: 5 }));
  rejects(JSON.stringify({ sources: true }));
});

test('stan: źródło musi być obiektem z dokładnie dziewięcioma polami', () => {
  rejects(JSON.stringify({ sources: { a: null } }));
  rejects(JSON.stringify({ sources: { a: [] } }));
  rejects(JSON.stringify({ sources: { a: 'x' } }));
  const missing = valid();
  delete missing.eventId;
  rejects(docText(missing));
  rejects(docText({ ...valid(), obce: null }));
  const renamed = valid();
  delete renamed.eventId;
  renamed.inne = null; // tyle samo pól, ale nie te
  rejects(docText(renamed));
});

test('stan: poziomy akceptują tylko wartości słownika', () => {
  for (const level of LEVELS) {
    parseStateFile(docText(valid({ lastObservedState: level, lastNotifiedState: level })));
  }
  rejects(docText(valid({ lastObservedState: 'STALE' })));
  rejects(docText(valid({ lastObservedState: '' })));
  rejects(docText(valid({ lastNotifiedState: null })));
  rejects(docText(valid({ lastNotifiedState: 'ACTIVE' })));
});

test('stan: każdy znacznik czasu to dokładny ISO z milisekundami albo null', () => {
  for (const field of ['lastObservedAt', 'lastNotifiedAt', 'undeliveredSince', 'lastSuccessfulCheckAt']) {
    parseStateFile(docText(valid({ [field]: ISO })));
    for (const bad of ['2026-11-18', '2026-11-18T09:00:00Z', 'wczoraj', '', 5, true, {}, '2026-13-18T09:00:00.000Z']) {
      rejects(docText(valid({ [field]: bad })));
    }
  }
});

test('stan: klucz i zdarzenie to niepusty tekst do 120 znaków albo null', () => {
  for (const field of ['lastNotifiedKey', 'eventId']) {
    parseStateFile(docText(valid({ [field]: 'x' })));
    parseStateFile(docText(valid({ [field]: 'x'.repeat(120) })));
    rejects(docText(valid({ [field]: '' })));
    rejects(docText(valid({ [field]: 'x'.repeat(121) })));
    rejects(docText(valid({ [field]: 5 })));
    rejects(docText(valid({ [field]: {} })));
  }
});

test('stan: messageSeq to nieujemna liczba całkowita', () => {
  parseStateFile(docText(valid({ messageSeq: 0 })));
  parseStateFile(docText(valid({ messageSeq: 7 })));
  for (const bad of [-1, 1.5, '1', null, true, 'x']) rejects(docText(valid({ messageSeq: bad })));
});

test('stan: jedno złe źródło unieważnia cały dokument', () => {
  rejects(JSON.stringify({ sources: { a: valid(), b: valid({ messageSeq: -1 }) } }));
  parseStateFile(JSON.stringify({ sources: { a: valid(), b: valid() } }));
});

test('stan: serializacja ma ustaloną kolejność pól, wcięcie dwóch spacji i końcowy znak nowej linii', () => {
  const shuffled = {};
  for (const field of [...STATE_FIELDS].reverse()) shuffled[field] = initialSourceState()[field];
  const text = serializeStateFile({ sources: { b: shuffled, a: valid() } });
  assert.ok(text.endsWith('}\n'));
  assert.ok(!text.endsWith('\n\n'));
  assert.ok(text.startsWith('{\n  "sources": {\n    "b": {\n      "lastObservedState": null,'));
  assert.deepEqual(Object.keys(JSON.parse(text).sources), ['b', 'a']);
  assert.deepEqual(Object.keys(JSON.parse(text).sources.b), STATE_FIELDS);
  assert.deepEqual(parseStateFile(text).sources.a, valid());
});

test('stan: serializacja pomija pola spoza schematu', () => {
  const text = serializeStateFile({ sources: { a: { ...valid(), obce: 1 } } });
  assert.deepEqual(Object.keys(JSON.parse(text).sources.a), STATE_FIELDS);
});

test('stan: sourceState zwraca kopię istniejącego źródła albo stan początkowy', () => {
  const doc = { sources: { a: valid({ messageSeq: 4 }) } };
  const copy = sourceState(doc, 'a');
  assert.deepEqual(copy, doc.sources.a);
  copy.messageSeq = 9;
  assert.equal(doc.sources.a.messageSeq, 4);
  assert.deepEqual(sourceState(doc, 'b'), initialSourceState());
  assert.deepEqual(sourceState({ sources: {} }, 'toString'), initialSourceState());
});

test('stan: withSourceState podmienia jedno źródło i nie zmienia wejścia', () => {
  const doc = { sources: { a: valid(), b: valid({ messageSeq: 2 }) } };
  const next = withSourceState(doc, 'a', valid({ messageSeq: 5 }));
  assert.equal(next.sources.a.messageSeq, 5);
  assert.equal(next.sources.b.messageSeq, 2);
  assert.equal(doc.sources.a.messageSeq, 0);
  assert.deepEqual(Object.keys(withSourceState({ sources: {} }, 'c', valid()).sources), ['c']);
});

test('stan: messageId i klucz wynikają z zatwierdzonego numeru i rodzaju', () => {
  assert.equal(messageIdFor('zrodlo-1', 0), 'zrodlo-1#1');
  assert.equal(messageIdFor('zrodlo-1', 41), 'zrodlo-1#42');
  assert.equal(keyFor('zrodlo-1#3', 'REMINDER'), 'zrodlo-1#3:REMINDER');
});

// --- treść wiadomości ---

const config = makeConfig();
const now = at('2026-11-18 10:00:00');
const stale = { alertLevel: 'ALERT_STALE', reason: 'WORKING_HOURS', ageSeconds: 26 * 3600 + 59, workingSeconds: 12 * 3600 + 59, httpStatus: null };
const hard = { alertLevel: 'ALERT_STALE', reason: 'HARD_LIMIT', ageSeconds: 100 * 3600 + 5, workingSeconds: null, httpStatus: null };
const errorRead = { alertLevel: 'ALERT_ERROR', reason: 'READ_FAILED', ageSeconds: null, workingSeconds: null, httpStatus: 503 };
const errorMarker = { alertLevel: 'ALERT_ERROR', reason: 'MARKER_INVALID', ageSeconds: null, workingSeconds: null, httpStatus: null };
const ok = { alertLevel: 'OK', reason: null, ageSeconds: 3 * 3600 + 30, workingSeconds: 3 * 3600 + 30, httpStatus: null };

const build = (kind, assessment, eventId = 'zrodlo-1#2') => buildMessage({
  kind, label: 'zrodlo-1', messageId: 'zrodlo-1#3', key: `zrodlo-1#3:${kind}`, eventId, assessment, config, now
});

const TAIL = 'Zdarzenie: zrodlo-1#2. Przebieg: 2026-11-18T09:00:00.000Z.';

test('wiadomość: ALERT_STALE z progu godzin pracy', () => {
  const message = build('ALERT_STALE', stale);
  assert.deepEqual(message, {
    messageId: 'zrodlo-1#3',
    key: 'zrodlo-1#3:ALERT_STALE',
    kind: 'ALERT_STALE',
    subject: '[zrodlo-1] brak nowych wpisów od 26 godz.',
    text: 'Źródło zrodlo-1: brak nowych wpisów od 26 godz. (w godzinach pracy: 12 godz., próg: 6 godz.). Stan: ALERT_STALE. ' + TAIL
  });
});

test('wiadomość: ALERT_STALE z limitu bezwzględnego mówi o weekendach i świętach', () => {
  const message = build('ALERT_STALE', hard);
  assert.equal(message.subject, '[zrodlo-1] brak nowych wpisów od 100 godz.');
  assert.equal(message.text,
    'Źródło zrodlo-1: brak nowych wpisów od 100 godz. Alarm wynika z limitu bezwzględnego 96 godz.' +
    ' (liczonego razem z weekendami i świętami). Stan: ALERT_STALE. ' + TAIL);
});

test('wiadomość: ALERT_ERROR ma odmienną treść i kod HTTP tylko, gdy jest', () => {
  const read = build('ALERT_ERROR', errorRead);
  assert.equal(read.subject, '[zrodlo-1] nie udało się sprawdzić świeżości źródła');
  assert.equal(read.text,
    'Źródło zrodlo-1: nie udało się sprawdzić świeżości, odczyt znacznika nie powiódł się (kod HTTP 503). Stan: ALERT_ERROR. ' + TAIL);
  const marker = build('ALERT_ERROR', errorMarker);
  assert.equal(marker.text,
    'Źródło zrodlo-1: nie udało się sprawdzić świeżości, znacznik jest pusty, niepoprawny albo z przyszłości. Stan: ALERT_ERROR. ' + TAIL);
});

test('wiadomość: przypomnienie dopisuje prefiks i sufiks, zarówno dla braku wpisów, jak i błędu', () => {
  const stale2 = build('REMINDER', stale);
  assert.equal(stale2.subject, '[zrodlo-1] brak nowych wpisów od 26 godz. (przypomnienie)');
  assert.ok(stale2.text.startsWith('Przypomnienie. Źródło zrodlo-1: brak nowych wpisów od 26 godz.'));
  const error = build('REMINDER', errorRead);
  assert.equal(error.subject, '[zrodlo-1] nie udało się sprawdzić świeżości źródła (przypomnienie)');
  assert.ok(error.text.startsWith('Przypomnienie. Źródło zrodlo-1: nie udało się sprawdzić świeżości,'));
});

test('wiadomość: powrót do normy podaje wiek w pełnych godzinach i nie zależy od rodzaju alarmu', () => {
  const message = build('RECOVERY', ok);
  assert.equal(message.subject, '[zrodlo-1] powrót do normy');
  assert.equal(message.text, 'Źródło zrodlo-1: powrót do normy, ostatni wpis ma 3 godz. Stan: OK. ' + TAIL);
});

test('wiadomość: brak zdarzenia to kreska, a chwila przebiegu to ISO', () => {
  const message = build('ALERT_STALE', stale, null);
  assert.ok(message.text.endsWith('Zdarzenie: -. Przebieg: 2026-11-18T09:00:00.000Z.'));
});
