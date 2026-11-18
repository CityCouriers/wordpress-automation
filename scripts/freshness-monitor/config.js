'use strict';

/**
 * Konfiguracja instalacji sprawdzacza świeżości (#295).
 *
 * Konfiguracja jest sekretem instalacji (próg, okno pracy, lista dni wolnych, etykieta źródła)
 * i NIE leży w repozytorium: sprawdzacz dostaje ją z zewnątrz (zob. docs/freshness-monitor.md).
 * Walidacja jest fail-closed: nieznane pole, zły typ albo wartość spoza zakresu to `ConfigError`,
 * a błąd nazywa tylko pole ze stałej listy, nigdy wartość.
 */

const { parseClock, parseWallText } = require('./wall-time');

const KNOWN_FIELDS = [
  'label', 'timeZone', 'rawThresholdHours', 'workingHoursThresholdHours', 'hardLimitHours',
  'window', 'holidays', 'reminderWorkingHours', 'retryDelayMs'
];

const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Odstęp między dwiema próbami odczytu w jednym przebiegu: co najmniej 60 s (specyfikacja). */
const MIN_RETRY_DELAY_MS = 60000;

class ConfigError extends Error {
  /** @param {string} field nazwa pola ze stałej listy (nigdy wartość) */
  constructor(field) {
    super(`CONFIG_INVALID:${field}`);
    this.name = 'ConfigError';
    this.code = 'CONFIG_INVALID';
    this.field = field;
  }
}

function fail(field) {
  throw new ConfigError(field);
}

function positiveNumber(value, field) {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) fail(field);
  return value;
}

function validTimeZone(value) {
  if (typeof value !== 'string') fail('timeZone');
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
  } catch {
    fail('timeZone');
  }
  return value;
}

function normalizeWindow(window) {
  if (!window) fail('window');
  const { days } = window;
  const startSeconds = parseClock(window.start);
  const endSeconds = parseClock(window.end);
  const dayOk = d => Number.isInteger(d) && d >= 1 && d <= 7;
  if (!Array.isArray(days) || days.length === 0 || !days.every(dayOk) || new Set(days).size !== days.length) fail('window');
  // Koniec nieczytelny (null) nie przechodzi porównania: null > początek jest zawsze fałszem.
  if (startSeconds === null || !(endSeconds > startSeconds)) fail('window');
  return Object.freeze({ days: Object.freeze([...days]), startSeconds, endSeconds });
}

function normalizeHolidays(holidays) {
  if (!Array.isArray(holidays)) fail('holidays');
  const real = day => typeof day === 'string' && parseWallText(`${day} 00:00:00`) !== null;
  if (!holidays.every(real)) fail('holidays');
  return Object.freeze([...holidays]);
}

/**
 * @param {object} raw konfiguracja instalacji
 * @return {Readonly<object>} konfiguracja ze znormalizowanym oknem i wartościami domyślnymi
 * @throws {ConfigError}
 */
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('config');
  if (Object.keys(raw).some(key => !KNOWN_FIELDS.includes(key))) fail('unknown');
  if (typeof raw.label !== 'string' || !LABEL_PATTERN.test(raw.label)) fail('label');
  const retryDelayMs = raw.retryDelayMs === undefined ? MIN_RETRY_DELAY_MS : raw.retryDelayMs;
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < MIN_RETRY_DELAY_MS) fail('retryDelayMs');
  return Object.freeze({
    label: raw.label,
    timeZone: validTimeZone(raw.timeZone),
    rawThresholdHours: positiveNumber(raw.rawThresholdHours, 'rawThresholdHours'),
    workingHoursThresholdHours: positiveNumber(raw.workingHoursThresholdHours, 'workingHoursThresholdHours'),
    hardLimitHours: positiveNumber(raw.hardLimitHours === undefined ? 96 : raw.hardLimitHours, 'hardLimitHours'),
    window: normalizeWindow(raw.window),
    holidays: normalizeHolidays(raw.holidays === undefined ? [] : raw.holidays),
    reminderWorkingHours: positiveNumber(raw.reminderWorkingHours === undefined ? 24 : raw.reminderWorkingHours, 'reminderWorkingHours'),
    retryDelayMs
  });
}

const LIVENESS_FIELDS = ['label', 'timeZone', 'window', 'holidays', 'deadWorkingHours', 'deadHardHours'];

/**
 * Konfiguracja niezależnej kontroli życia sprawdzacza (W1): ta sama strefa, okno i lista dni wolnych
 * co sprawdzacz, a termin to godziny pracy (domyślnie 6) albo godziny bezwzględne (domyślnie 26).
 *
 * @param {object} raw
 * @return {Readonly<object>}
 * @throws {ConfigError}
 */
function normalizeLivenessConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('config');
  if (Object.keys(raw).some(key => !LIVENESS_FIELDS.includes(key))) fail('unknown');
  if (typeof raw.label !== 'string' || !LABEL_PATTERN.test(raw.label)) fail('label');
  return Object.freeze({
    label: raw.label,
    timeZone: validTimeZone(raw.timeZone),
    window: normalizeWindow(raw.window),
    holidays: normalizeHolidays(raw.holidays === undefined ? [] : raw.holidays),
    deadWorkingHours: positiveNumber(raw.deadWorkingHours === undefined ? 6 : raw.deadWorkingHours, 'deadWorkingHours'),
    deadHardHours: positiveNumber(raw.deadHardHours === undefined ? 26 : raw.deadHardHours, 'deadHardHours')
  });
}

module.exports = { ConfigError, MIN_RETRY_DELAY_MS, normalizeConfig, normalizeLivenessConfig };
