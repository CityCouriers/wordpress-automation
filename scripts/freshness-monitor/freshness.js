'use strict';

/**
 * Warstwa 1 (#295): świeżość surowa, stany identyczne z `sourceFreshness_()` z #197
 * (`src/SourceFreshness.gs`). Słownik `ACTIVE` / `STALE` / `ERROR` zostaje bez zmian i obejmuje
 * wyłącznie surowy wiek; polityka alarmowania jest osobną warstwą nad nim (`assessment.js`).
 *
 * Jedyne rozszerzenie względem #197: stan `ERROR` zwraca także sprawdzacz, gdy nie udał się
 * odczyt (to rozstrzyga warstwa wywołująca; sama ocena dostaje już odczytaną wartość).
 */

const { isValidDate, roundHalfAwayFromZero, wallSeconds } = require('./wall-time');

const ACTIVE = 'ACTIVE';
const STALE = 'STALE';
const ERROR = 'ERROR';

const ERROR_RESULT = Object.freeze({ state: ERROR, ageSeconds: null });

/**
 * @param {*} lastTimestamp data albo tekst `YYYY-MM-DD HH:MM:SS` w strefie instalacji
 * @param {*} maxAgeHours próg w godzinach, liczba > 0
 * @param {Date} now bieżąca chwila
 * @param {string} timeZone strefa instalacji
 * @return {{state: string, ageSeconds: (number|null)}} wiek w pełnych sekundach tylko dla stanów poprawnych
 */
function rawFreshness(lastTimestamp, maxAgeHours, now, timeZone) {
  if (typeof maxAgeHours !== 'number' || !isFinite(maxAgeHours) || maxAgeHours <= 0) return ERROR_RESULT;
  try {
    if (!isValidDate(now)) return ERROR_RESULT;
    const last = wallSeconds(lastTimestamp, timeZone);
    if (last === null) return ERROR_RESULT;
    const ageSeconds = roundHalfAwayFromZero(wallSeconds(now, timeZone) - last);
    // Znacznik z przyszłości to niespójność zegara albo danych, a nie świeże źródło.
    if (ageSeconds < 0) return ERROR_RESULT;
    return { state: ageSeconds <= maxAgeHours * 3600 ? ACTIVE : STALE, ageSeconds };
  } catch {
    // Zła strefa albo inny wyjątek formatowania: fail-closed, nigdy cisza.
    return ERROR_RESULT;
  }
}

module.exports = { ACTIVE, ERROR, STALE, rawFreshness };
