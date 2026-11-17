'use strict';

/**
 * Treść wiadomości sprawdzacza (#295).
 *
 * Wiadomość zawiera WYŁĄCZNIE: neutralną etykietę źródła z konfiguracji, stan, wiek w pełnych
 * godzinach, próg, chwilę przebiegu i `eventId`. Żadnej treści wierszy, danych osobowych, nazw
 * klientów, identyfikatorów plików, adresów ani tekstu wyjątków. Kod HTTP wchodzi jako sama liczba.
 *
 * `ALERT_STALE` mówi „brak nowych wpisów od N godzin”, nigdy „przepływ uszkodzony”: stary rekord
 * nie jest dowodem awarii. `ALERT_ERROR` ma odmienną treść („nie udało się sprawdzić”).
 */

const hours = seconds => Math.floor(seconds / 3600);

const ERROR_REASONS = {
  READ_FAILED: 'odczyt znacznika nie powiódł się',
  MARKER_INVALID: 'znacznik jest pusty, niepoprawny albo z przyszłości'
};

function staleSentence(label, assessment, config) {
  const age = hours(assessment.ageSeconds);
  if (assessment.reason === 'HARD_LIMIT') {
    return `Źródło ${label}: brak nowych wpisów od ${age} godz. Alarm wynika z limitu bezwzględnego ${config.hardLimitHours} godz.` +
      ' (liczonego razem z weekendami i świętami). Stan: ALERT_STALE.';
  }
  return `Źródło ${label}: brak nowych wpisów od ${age} godz. (w godzinach pracy: ${hours(assessment.workingSeconds)} godz.,` +
    ` próg: ${config.workingHoursThresholdHours} godz.). Stan: ALERT_STALE.`;
}

function errorSentence(label, assessment) {
  const code = assessment.httpStatus === null ? '' : ` (kod HTTP ${assessment.httpStatus})`;
  return `Źródło ${label}: nie udało się sprawdzić świeżości, ${ERROR_REASONS[assessment.reason]}${code}. Stan: ALERT_ERROR.`;
}

function subjectFor(kind, label, assessment) {
  if (kind === 'RECOVERY') return `[${label}] powrót do normy`;
  const base = assessment.alertLevel === 'ALERT_ERROR'
    ? `[${label}] nie udało się sprawdzić świeżości źródła`
    : `[${label}] brak nowych wpisów od ${hours(assessment.ageSeconds)} godz.`;
  return kind === 'REMINDER' ? `${base} (przypomnienie)` : base;
}

function bodyFor(kind, label, assessment, config) {
  if (kind === 'RECOVERY') {
    return `Źródło ${label}: powrót do normy, ostatni wpis ma ${hours(assessment.ageSeconds)} godz. Stan: OK.`;
  }
  const sentence = assessment.alertLevel === 'ALERT_ERROR'
    ? errorSentence(label, assessment)
    : staleSentence(label, assessment, config);
  return kind === 'REMINDER' ? `Przypomnienie. ${sentence}` : sentence;
}

/**
 * @param {object} input
 * @param {string} input.kind ALERT_STALE, ALERT_ERROR, REMINDER albo RECOVERY
 * @param {string} input.label etykieta źródła
 * @param {string} input.messageId `<etykieta>#<numer>`
 * @param {string} input.key `<messageId>:<rodzaj>`
 * @param {string|null} input.eventId zdarzenie, którego dotyczy wiadomość (puste, gdy brak)
 * @param {object} input.assessment wynik `assess()`
 * @param {object} input.config
 * @param {Date} input.now chwila przebiegu
 * @return {{messageId: string, key: string, kind: string, subject: string, text: string}}
 */
function buildMessage({ kind, label, messageId, key, eventId, assessment, config, now }) {
  const tail = `Zdarzenie: ${eventId === null ? '-' : eventId}. Przebieg: ${now.toISOString()}.`;
  return {
    messageId,
    key,
    kind,
    subject: subjectFor(kind, label, assessment),
    text: `${bodyFor(kind, label, assessment, config)} ${tail}`
  };
}

module.exports = { buildMessage };
