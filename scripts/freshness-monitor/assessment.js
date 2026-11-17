'use strict';

/**
 * Warstwa 2 (#295): polityka alarmowania nad surową świeżością z warstwy 1.
 *
 * `alertLevel` to `OK`, `ALERT_STALE` albo `ALERT_ERROR`. Nie jest to część słownika #197:
 * `rawState` zostaje `ACTIVE` / `STALE` / `ERROR` z `freshness.js`.
 *
 * - `ALERT_ERROR`: odczyt się nie powiódł (`READ_FAILED`) albo warstwa 1 zwróciła `ERROR`
 *   (`MARKER_INVALID`: znacznik pusty, niepoprawny albo z przyszłości);
 * - `ALERT_STALE` z powodu `HARD_LIMIT`: `rawAge` (z weekendami i świętami) przekracza limit
 *   bezwzględny; alarmuje zawsze, niezależnie od okna pracy i listy dni wolnych;
 * - `ALERT_STALE` z powodu `WORKING_HOURS`: wiek w godzinach okna pracy przekracza próg. Alarm
 *   poza oknem jest odroczony (`deferred`) do jego otwarcia.
 *
 * `STALE` znaczy wyłącznie, że od progu nie pojawił się nowszy rekord; nie dowodzi awarii transportu.
 */

const { ERROR, rawFreshness } = require('./freshness');
const { isWorkingInstant, wallSeconds, workingSecondsBetween } = require('./wall-time');

/** Zwraca pierwszą komórkę, gdy czytnik oddał tablicę (dodatkowe kolumny nigdy nie wchodzą dalej). */
function firstCell(raw) {
  return Array.isArray(raw) ? firstCell(raw[0]) : raw;
}

/** Kod HTTP tylko jako liczba całkowita 100–599; wszystko inne (w tym tekst z adresem) to null. */
function safeStatus(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function base(fields) {
  return {
    rawState: ERROR, reason: null, ageSeconds: null, workingSeconds: null,
    deferred: false, readOk: true, httpStatus: null, ...fields
  };
}

function staleVerdict(ageSeconds, marker, now, config) {
  if (ageSeconds > config.hardLimitHours * 3600) {
    return { alertLevel: 'ALERT_STALE', reason: 'HARD_LIMIT', workingSeconds: null, deferred: false };
  }
  const workingSeconds = workingSecondsBetween(wallSeconds(marker, config.timeZone), wallSeconds(now, config.timeZone),
    config.window, config.holidays);
  if (workingSeconds <= config.workingHoursThresholdHours * 3600) {
    return { alertLevel: 'OK', reason: null, workingSeconds, deferred: false };
  }
  const inWindow = isWorkingInstant(wallSeconds(now, config.timeZone), config.window, config.holidays);
  return { alertLevel: 'ALERT_STALE', reason: 'WORKING_HOURS', workingSeconds, deferred: !inWindow };
}

/**
 * @param {{read: ({ok: true, value: *}|{ok: false, status: *}), now: Date, config: object}} input
 *   `read` to wynik odczytu znacznika (po ponowieniach), `config` z `normalizeConfig`
 */
function assess({ read, now, config }) {
  if (!read.ok) {
    return base({ alertLevel: 'ALERT_ERROR', reason: 'READ_FAILED', readOk: false, httpStatus: safeStatus(read.status) });
  }
  const marker = firstCell(read.value);
  const raw = rawFreshness(marker, config.rawThresholdHours, now, config.timeZone);
  if (raw.state === ERROR) return base({ alertLevel: 'ALERT_ERROR', reason: 'MARKER_INVALID' });
  return base({ rawState: raw.state, ageSeconds: raw.ageSeconds, ...staleVerdict(raw.ageSeconds, marker, now, config) });
}

module.exports = { assess, firstCell, safeStatus };
