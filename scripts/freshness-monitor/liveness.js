'use strict';

/**
 * Niezależna kontrola życia sprawdzacza (#295, wariant W1, decyzja właściciela z 17.11.2026).
 *
 * Wyłączony harmonogram sprawdzacza nie wyda ani przebiegu, ani czerwonego statusu, więc sprawdzacz nie
 * może sam zgłosić własnej śmierci. Tę kontrolę uruchamia INNY proces instalacji, niezależny od GitHuba
 * i Google, co godzinę: czyta plik stanu i alarmuje własnym, potwierdzanym kanałem. Ten moduł jest
 * jej czystą oceną: dostaje tekst pliku stanu, etykietę, chwilę i konfigurację, zwraca werdykt.
 * Dostarczenie alarmu i jego deduplikacja należą do procesu instalacji (poza tym repozytorium).
 *
 * Alarm, gdy: brak stanu źródła albo brak pulsu (`NO_STATE`, `NO_HEARTBEAT`), plik stanu nie do odczytu
 * (`STATE_INVALID`), puls z przyszłości (`HEARTBEAT_INVALID`), `lastSuccessfulCheckAt` starsze niż termin
 * (`HEARTBEAT_STALE`) albo `undeliveredSince` starsze niż termin (`UNDELIVERED_STALE`: alarm czeka na
 * dostarczenie, a sprawdzacz nie umie go wysłać). Termin to godziny pracy ALBO godziny bezwzględne.
 */

const { parseStateFile } = require('./state');
const { wallSeconds, workingSecondsBetween } = require('./wall-time');

/** Wiek momentu `iso` względem `now`: sekundy czasu ściennego i sekundy okna pracy (null przy chwili z przyszłości). */
function ageOf(iso, now, config) {
  const from = wallSeconds(new Date(iso), config.timeZone);
  const to = wallSeconds(now, config.timeZone);
  if (to < from) return null;
  return {
    rawSeconds: to - from,
    workingSeconds: workingSecondsBetween(from, to, config.window, config.holidays)
  };
}

const overDeadline = (age, config) => age.workingSeconds > config.deadWorkingHours * 3600 ||
  age.rawSeconds > config.deadHardHours * 3600;

function checkHeartbeat(source, now, config) {
  if (source.lastSuccessfulCheckAt === null) return { reason: 'NO_HEARTBEAT', hours: null };
  const age = ageOf(source.lastSuccessfulCheckAt, now, config);
  if (age === null) return { reason: 'HEARTBEAT_INVALID', hours: null };
  return { reason: overDeadline(age, config) ? 'HEARTBEAT_STALE' : null, hours: Math.floor(age.rawSeconds / 3600) };
}

function checkUndelivered(source, now, config) {
  if (source.undeliveredSince === null) return { reason: null, hours: null };
  const age = ageOf(source.undeliveredSince, now, config);
  const stale = age === null || overDeadline(age, config);
  return { reason: stale ? 'UNDELIVERED_STALE' : null, hours: age === null ? null : Math.floor(age.rawSeconds / 3600) };
}

/**
 * @param {{text: (string|null), now: Date, config: object}} input `config` z `normalizeLivenessConfig`
 * @return {{level: string, reasons: string[], heartbeatAgeHours: (number|null), undeliveredAgeHours: (number|null)}}
 */
function evaluateLiveness({ text, now, config }) {
  const verdict = (reasons, heartbeatAgeHours, undeliveredAgeHours) =>
    ({ level: reasons.length === 0 ? 'OK' : 'ALERT', reasons, heartbeatAgeHours, undeliveredAgeHours });
  let doc;
  try {
    doc = parseStateFile(text);
  } catch {
    return verdict(['STATE_INVALID'], null, null);
  }
  if (!Object.prototype.hasOwnProperty.call(doc.sources, config.label)) return verdict(['NO_STATE'], null, null);
  const source = doc.sources[config.label];
  const heartbeat = checkHeartbeat(source, now, config);
  const undelivered = checkUndelivered(source, now, config);
  return verdict([heartbeat.reason, undelivered.reason].filter(Boolean), heartbeat.hours, undelivered.hours);
}

module.exports = { evaluateLiveness };
