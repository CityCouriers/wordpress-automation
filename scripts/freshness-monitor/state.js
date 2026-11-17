'use strict';

/**
 * Trwały stan sprawdzacza świeżości (#295): jeden plik JSON, per źródło, pod neutralną etykietą.
 *
 * Schemat to dokładnie dziewięć pól z listy `STATE_FIELDS` i nic ponadto. Stan nie zawiera znacznika
 * źródła, treści, adresów ani identyfikatorów plików. Plik niepoprawny (zły JSON, brakujące albo
 * obce pole, zły typ) to `StateError`: sprawdzacz nie nadpisuje stanu, którego nie rozumie.
 */

const LEVELS = ['OK', 'ALERT_STALE', 'ALERT_ERROR'];

const STATE_FIELDS = [
  'lastObservedState', 'lastObservedAt', 'lastNotifiedState', 'lastNotifiedAt', 'lastNotifiedKey',
  'messageSeq', 'eventId', 'undeliveredSince', 'lastSuccessfulCheckAt'
];

class StateError extends Error {
  constructor() {
    super('STATE_INVALID');
    this.name = 'StateError';
    this.code = 'STATE_INVALID';
  }
}

/** Stan źródła, które nigdy nie wysłało wiadomości: `lastNotifiedState=OK`, `messageSeq=0`. */
function initialSourceState() {
  return {
    lastObservedState: null, lastObservedAt: null, lastNotifiedState: 'OK', lastNotifiedAt: null,
    lastNotifiedKey: null, messageSeq: 0, eventId: null, undeliveredSince: null, lastSuccessfulCheckAt: null
  };
}

const isNullOr = (value, test) => value === null || test(value);
// Równość z `toISOString()` wyklucza także wartości niebędące tekstem; sprawdzenie NaN chroni przed RangeError.
const isIso = value => !isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const isText = value => typeof value === 'string' && value.length > 0 && value.length <= 120;

function validSource(source) {
  if (!source) return false;
  // Dziewięć kluczy i walidatory każdego z dziewięciu pól: brakujące pole to `undefined`, którego żaden walidator
  // nie przepuszcza, więc nie trzeba osobno porównywać nazw. Wartość niebędąca obiektem ma inną liczbę kluczy.
  if (Object.keys(source).length !== STATE_FIELDS.length) return false;
  return isNullOr(source.lastObservedState, v => LEVELS.includes(v)) &&
    LEVELS.includes(source.lastNotifiedState) &&
    isNullOr(source.lastObservedAt, isIso) && isNullOr(source.lastNotifiedAt, isIso) &&
    isNullOr(source.undeliveredSince, isIso) && isNullOr(source.lastSuccessfulCheckAt, isIso) &&
    isNullOr(source.lastNotifiedKey, isText) && isNullOr(source.eventId, isText) &&
    Number.isInteger(source.messageSeq) && source.messageSeq >= 0;
}

/**
 * @param {string|null} text zawartość pliku stanu; null albo pusty tekst to brak stanu
 * @return {{sources: Object<string, object>}}
 * @throws {StateError}
 */
function parseStateFile(text) {
  if (text === null || text === '') return { sources: {} };
  let doc = null;
  try {
    doc = JSON.parse(text);
  } catch {
    // Niepoprawny JSON to to samo, co brak dokumentu: odrzuca go sprawdzenie niżej.
  }
  if (!doc || Object.keys(doc).join() !== 'sources') throw new StateError();
  const { sources } = doc;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw new StateError();
  if (!Object.values(sources).every(validSource)) throw new StateError();
  return { sources };
}

/** Serializacja z ustaloną kolejnością pól (dziennik zmian w gitcie nie szumi). */
function serializeStateFile(doc) {
  const sources = {};
  for (const label of Object.keys(doc.sources)) {
    sources[label] = Object.fromEntries(STATE_FIELDS.map(field => [field, doc.sources[label][field]]));
  }
  return JSON.stringify({ sources }, null, 2) + '\n';
}

/** Kopia stanu źródła z dokumentu albo stan początkowy. */
function sourceState(doc, label) {
  return Object.prototype.hasOwnProperty.call(doc.sources, label) ? { ...doc.sources[label] } : initialSourceState();
}

/** Dokument z podmienionym stanem jednego źródła; inne źródła zostają bez zmian. */
function withSourceState(doc, label, source) {
  return { sources: { ...doc.sources, [label]: source } };
}

/** `messageId` to funkcja wyłącznie zatwierdzonego `messageSeq`: `<etykieta>#<messageSeq + 1>`. */
function messageIdFor(label, messageSeq) {
  return `${label}#${messageSeq + 1}`;
}

/** Klucz idempotencji: `<messageId>:<rodzaj>`; tożsamość wiadomości to klucz, nie numer. */
function keyFor(messageId, kind) {
  return `${messageId}:${kind}`;
}

module.exports = {
  LEVELS, STATE_FIELDS, StateError,
  initialSourceState, keyFor, messageIdFor, parseStateFile, serializeStateFile, sourceState, withSourceState
};
