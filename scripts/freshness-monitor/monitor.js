'use strict';

/**
 * Przebieg sprawdzacza świeżości (#295): protokół sześciu kroków i kontrakt dostarczenia
 * „co najmniej raz”.
 *
 * Kolejność jest wymaganiem:
 *  1. odczyt stanu wraz z wersją (nieudany odczyt: czerwony przebieg, nic nie jest wysyłane);
 *  2. odczyt znacznika (dwie próby w odstępie co najmniej 60 s) i ocena obu warstw;
 *  3. wyznaczenie wiadomości WYŁĄCZNIE ze stanu z kroku 1 i oceny z kroku 2 (`messageId` to funkcja
 *     zatwierdzonego `messageSeq`, więc nie żyje w pamięci przebiegu);
 *  4. wysyłka z kluczem; zapis dotyczy tylko wiadomości POTWIERDZONEJ przez kanał;
 *  5. zapis stanu jednym commitem na wersji z kroku 1;
 *  6. po konflikcie: ponowny odczyt i rozliczenie wysłanej wiadomości po KLUCZU, nie po numerze.
 *
 * Duplikat jest dopuszczony w dwóch sytuacjach (wysyłka potwierdzona bez commitu; dwa równoległe
 * przebiegi), utrata alarmu nie jest dopuszczona. Wszystko, co przebieg wypisuje albo zapisuje,
 * pochodzi z pól o stałym kształcie: nigdy z treści wyjątków ani odpowiedzi.
 */

const { assess, safeStatus } = require('./assessment');
const { buildMessage } = require('./messages');
const {
  keyFor, messageIdFor, parseStateFile, serializeStateFile, sourceState, withSourceState
} = require('./state');
const { wallSeconds, workingSecondsBetween } = require('./wall-time');

const MAX_COMMIT_ATTEMPTS = 3;
const READ_ATTEMPTS = 2;

/** Odczyt stanu źródła: dokument, wersja i stan tego źródła. Wyjątek oznacza nieudany odczyt stanu. */
async function loadSnapshot(store, label) {
  const { text, version } = await store.read();
  const doc = parseStateFile(text);
  return { doc, version, source: sourceState(doc, label) };
}

/** Odczyt znacznika z jednym ponowieniem; zwraca tylko wartość albo kod HTTP, nigdy tekst błędu. */
async function readMarker(reader, config, sleep) {
  let status = null;
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try {
      return { ok: true, value: await reader.read() };
    } catch (error) {
      status = safeStatus(error && error.status);
    }
    if (attempt < READ_ATTEMPTS) await sleep(config.retryDelayMs);
  }
  return { ok: false, status };
}

function reminderDue(state, now, config) {
  if (state.lastNotifiedAt === null) return false;
  const from = wallSeconds(new Date(state.lastNotifiedAt), config.timeZone);
  const elapsed = workingSecondsBetween(from, wallSeconds(now, config.timeZone), config.window, config.holidays);
  return elapsed >= config.reminderWorkingHours * 3600;
}

/**
 * Krok 3: jaka wiadomość jest należna (albo null). Wynik zależy wyłącznie od stanu, oceny, chwili
 * i konfiguracji. Alarm z progu godzin pracy poza oknem czeka do jego otwarcia (`deferred`).
 *
 * @return {null|{kind: string, notifiedState: string, seq: number, messageId: string, key: string, eventId: (string|null)}}
 */
function determineMessage(state, assessment, now, config) {
  const level = assessment.alertLevel;
  if (assessment.deferred) return null;
  let kind;
  if (level !== state.lastNotifiedState) kind = level === 'OK' ? 'RECOVERY' : level;
  else if (level !== 'OK' && reminderDue(state, now, config)) kind = 'REMINDER';
  else return null;
  const messageId = messageIdFor(config.label, state.messageSeq);
  const transitionToAlert = kind === 'ALERT_STALE' || kind === 'ALERT_ERROR';
  return {
    kind, notifiedState: level, seq: state.messageSeq + 1, messageId, key: keyFor(messageId, kind),
    eventId: transitionToAlert ? messageId : state.eventId
  };
}

/** Stan po zapisaniu potwierdzonej wiadomości: `messageSeq` nigdy nie maleje, `eventId` wg rodzaju. */
function recordMessage(state, message, sentAtIso) {
  let { eventId } = state;
  if (message.kind === 'ALERT_STALE' || message.kind === 'ALERT_ERROR') eventId = message.messageId;
  if (message.kind === 'RECOVERY') eventId = null;
  return {
    ...state,
    lastNotifiedState: message.notifiedState,
    lastNotifiedAt: sentAtIso,
    lastNotifiedKey: message.key,
    messageSeq: Math.max(state.messageSeq, message.seq),
    eventId,
    undeliveredSince: null
  };
}

/**
 * Krok 6: rozliczenie wysłanych, potwierdzonych wiadomości względem stanu (świeżego albo własnego).
 * Wysłane wiadomości są w kolejności wysyłki, czyli rosnącego `seq`. (a) ten sam klucz już zapisany: nic; (b) zapisana wiadomość późniejsza (większy `messageSeq`):
 * nic, ewidencja się nie cofa; (c) reszta, także INNA wiadomość pod tym samym numerem: zapis.
 */
function reconcile(state, sent) {
  let current = state;
  for (const message of sent) {
    if (current.lastNotifiedKey === message.key) continue;
    if (current.messageSeq > message.seq) continue;
    current = recordMessage(current, message, message.sentAt);
  }
  return current;
}

/**
 * `undeliveredSince`: ustawione od pierwszej nieudanej wysyłki, trwa przy odroczeniu (wiadomość nadal
 * czeka), a czyszczone, gdy niczego nie trzeba wysyłać albo wiadomość została zapisana.
 */
function pendingSince(state, assessment, nowIso, sendFailed) {
  if (sendFailed) return state.undeliveredSince || nowIso;
  return assessment.deferred ? state.undeliveredSince : null;
}

/** Pola obserwacji i `undeliveredSince` dla zapisu jednym commitem (krok 5). */
function withObservation(state, assessment, nowIso, sendFailed) {
  return {
    ...state,
    lastObservedState: assessment.alertLevel,
    lastObservedAt: nowIso,
    lastSuccessfulCheckAt: assessment.readOk ? nowIso : state.lastSuccessfulCheckAt,
    undeliveredSince: pendingSince(state, assessment, nowIso, sendFailed)
  };
}

/** Jedna linia logu z pól o stałym kształcie (etykieta, stan, liczby, chwila, zdarzenie). */
function statusLine(config, assessment, nowIso, eventId) {
  const hours = seconds => (seconds === null ? '-' : Math.floor(seconds / 3600));
  return `[${config.label}] stan=${assessment.alertLevel} surowy=${assessment.rawState} powod=${assessment.reason || '-'}` +
    ` wiek_h=${hours(assessment.ageSeconds)} praca_h=${hours(assessment.workingSeconds)}` +
    ` prog_h=${config.workingHoursThresholdHours} limit_h=${config.hardLimitHours}` +
    ` odroczony=${assessment.deferred ? 'tak' : 'nie'} zdarzenie=${eventId || '-'} przebieg=${nowIso}`;
}

async function deliver(sender, message, log, label) {
  let confirmed = false;
  let status = null;
  try {
    const reply = await sender.send(message);
    confirmed = Boolean(reply) && reply.confirmed === true;
  } catch (error) {
    status = safeStatus(error && error.status);
  }
  log(`[${label}] wiadomosc=${message.kind} klucz=${message.key} potwierdzona=${confirmed ? 'tak' : 'nie'}` +
    (confirmed || status === null ? '' : ` kod_http=${status}`));
  return confirmed;
}

function newResult() {
  return { alertLevel: null, assessment: null, sent: [], committed: false, problems: [] };
}

function finish(result) {
  result.green = result.alertLevel === 'OK' && result.problems.length === 0;
  return result;
}

/**
 * @param {object} deps
 * @param {object} deps.config wynik `normalizeConfig`
 * @param {function(): Date} deps.clock
 * @param {{read: function(): Promise<*>}} deps.reader odczyt jednej komórki znacznika (rzuca przy błędzie)
 * @param {{read: function(): Promise<{text: (string|null), version: *}>, write: function(string, *): Promise<{ok: boolean, version: *}>}} deps.store
 * @param {{send: function(object): Promise<{confirmed: boolean}>}} deps.sender
 * @param {function(number): Promise<void>} deps.sleep
 * @param {function(string): void} deps.log
 */
async function runCheck({ config, clock, reader, store, sender, sleep, log }) {
  const result = newResult();
  let snapshot;
  try {
    snapshot = await loadSnapshot(store, config.label);
  } catch {
    result.problems.push('STATE_READ_FAILED');
    log(`[${config.label}] problem=STATE_READ_FAILED`);
    return finish(result);
  }
  // Chwila oceny po odczycie: znacznik, który pojawił się podczas ponowienia, nie może wyglądać na pochodzący z przyszłości.
  const read = await readMarker(reader, config, sleep);
  const now = clock();
  const nowIso = now.toISOString();
  const assessment = assess({ read, now, config });
  result.alertLevel = assessment.alertLevel;
  result.assessment = assessment;
  log(statusLine(config, assessment, nowIso, snapshot.source.eventId));

  const sent = [];
  let sendFailed = false;
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    const state = reconcile(snapshot.source, sent);
    const due = sendFailed ? null : determineMessage(state, assessment, now, config);
    if (due) {
      const message = buildMessage({ ...due, label: config.label, assessment, config, now });
      if (await deliver(sender, message, log, config.label)) {
        sent.push({ ...due, sentAt: clock().toISOString() });
        result.sent.push({ messageId: due.messageId, key: due.key, kind: due.kind });
      } else {
        sendFailed = true;
      }
    }
    const next = withObservation(reconcile(snapshot.source, sent), assessment, nowIso, sendFailed);
    let written;
    try {
      written = await store.write(serializeStateFile(withSourceState(snapshot.doc, config.label, next)), snapshot.version);
    } catch {
      result.problems.push('STATE_WRITE_FAILED');
      log(`[${config.label}] problem=STATE_WRITE_FAILED`);
      break;
    }
    if (written.ok) {
      result.committed = true;
      break;
    }
    if (attempt === MAX_COMMIT_ATTEMPTS) break;
    try {
      snapshot = await loadSnapshot(store, config.label);
    } catch {
      result.problems.push('STATE_READ_FAILED');
      log(`[${config.label}] problem=STATE_READ_FAILED`);
      break;
    }
  }
  if (sendFailed) result.problems.push('SEND_FAILED');
  if (!result.committed && !result.problems.some(p => p.startsWith('STATE_'))) {
    result.problems.push('COMMIT_EXHAUSTED');
    log(`[${config.label}] problem=COMMIT_EXHAUSTED`);
  }
  return finish(result);
}

module.exports = { determineMessage, reconcile, recordMessage, runCheck };
