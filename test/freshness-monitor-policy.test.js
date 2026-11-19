'use strict';

/**
 * #295, warstwa 2: polityka alarmowania (przypadki 4–9 specyfikacji) i konfiguracja instalacji.
 * Dane są syntetyczne: neutralna etykieta, strefa Warszawy, święto 11.11.2026 jako przykład listy dni wolnych.
 * Warstwa 2 nie zmienia słownika #197: testy warstwy 1 są w `freshness-monitor-layer1.test.js`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { at } = require('./helpers/zone');
const { normalizeConfig, ConfigError } = require('../scripts/freshness-monitor/config');
const { assess } = require('../scripts/freshness-monitor/assessment');
const { isWorkingInstant, workingSecondsBetween, parseClock, wallSeconds } = require('../scripts/freshness-monitor/wall-time');

const TZ = 'Europe/Warsaw';

const RAW = Object.freeze({
  label: 'zrodlo-1',
  timeZone: TZ,
  rawThresholdHours: 2,
  workingHoursThresholdHours: 6,
  window: { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' }
});

const cfg = (extra = {}) => normalizeConfig({ ...RAW, ...extra });
const ok = value => ({ ok: true, value });
const wall = text => wallSeconds(at(text), TZ);

describe('#295 konfiguracja instalacji', () => {
  test('wartości domyślne: limit 96 h, przypomnienie 24 h pracy, ponowienie odczytu po 60 s, brak świąt', () => {
    const c = cfg();
    assert.equal(c.hardLimitHours, 96);
    assert.equal(c.reminderWorkingHours, 24);
    assert.equal(c.retryDelayMs, 60000);
    assert.deepEqual(c.holidays, []);
    assert.deepEqual(c.window, { days: [1, 2, 3, 4, 5], startSeconds: 8 * 3600, endSeconds: 18 * 3600 });
    assert.equal(c.label, 'zrodlo-1');
    assert.equal(c.timeZone, TZ);
    assert.equal(c.rawThresholdHours, 2);
    assert.equal(c.workingHoursThresholdHours, 6);
  });

  test('wartości jawne zastępują domyślne', () => {
    const c = cfg({ hardLimitHours: 72, reminderWorkingHours: 12, retryDelayMs: 90000, holidays: ['2026-11-11'] });
    assert.deepEqual([c.hardLimitHours, c.reminderWorkingHours, c.retryDelayMs, c.holidays], [72, 12, 90000, ['2026-11-11']]);
  });

  const bad = (name, patch, field) => test(`zła wartość: ${name} → CONFIG_INVALID:${field}`, () => {
    assert.throws(() => cfg(patch), err => err instanceof ConfigError && err.field === field && err.code === 'CONFIG_INVALID' &&
      err.message === `CONFIG_INVALID:${field}`);
  });
  bad('etykieta z wielkimi literami', { label: 'Zrodlo' }, 'label');
  bad('etykieta z adresem', { label: 'a@b.pl' }, 'label');
  bad('etykieta pusta', { label: '' }, 'label');
  bad('etykieta nie tekst', { label: 5 }, 'label');
  bad('etykieta zaczynająca się myślnikiem', { label: '-a' }, 'label');
  bad('etykieta za długa', { label: 'a'.repeat(41) }, 'label');
  bad('strefa nieznana', { timeZone: 'Nie/Ma' }, 'timeZone');
  bad('strefa nie tekst', { timeZone: 5 }, 'timeZone');
  bad('próg surowy 0', { rawThresholdHours: 0 }, 'rawThresholdHours');
  bad('próg surowy tekstem', { rawThresholdHours: '2' }, 'rawThresholdHours');
  bad('próg surowy Infinity', { rawThresholdHours: Infinity }, 'rawThresholdHours');
  bad('próg godzin pracy ujemny', { workingHoursThresholdHours: -1 }, 'workingHoursThresholdHours');
  bad('próg godzin pracy brak', { workingHoursThresholdHours: undefined }, 'workingHoursThresholdHours');
  bad('limit 0', { hardLimitHours: 0 }, 'hardLimitHours');
  bad('limit tekstem', { hardLimitHours: '96' }, 'hardLimitHours');
  bad('przypomnienie 0', { reminderWorkingHours: 0 }, 'reminderWorkingHours');
  bad('ponowienie poniżej 60 s', { retryDelayMs: 59999 }, 'retryDelayMs');
  bad('ponowienie ułamkowe', { retryDelayMs: 60000.5 }, 'retryDelayMs');
  bad('okno brak', { window: undefined }, 'window');
  bad('okno bez dni', { window: { days: [], start: '08:00', end: '18:00' } }, 'window');
  bad('okno dzień 0', { window: { days: [0], start: '08:00', end: '18:00' } }, 'window');
  bad('okno dzień 8', { window: { days: [8], start: '08:00', end: '18:00' } }, 'window');
  bad('okno dni powtórzone', { window: { days: [1, 1], start: '08:00', end: '18:00' } }, 'window');
  bad('okno dni nie liczby', { window: { days: ['1'], start: '08:00', end: '18:00' } }, 'window');
  bad('okno dni nie tablica', { window: { days: 1, start: '08:00', end: '18:00' } }, 'window');
  bad('okno koniec przed początkiem', { window: { days: [1], start: '18:00', end: '08:00' } }, 'window');
  bad('okno koniec równy początkowi', { window: { days: [1], start: '08:00', end: '08:00' } }, 'window');
  bad('okno zły format', { window: { days: [1], start: '8:00', end: '18:00' } }, 'window');
  bad('okno godzina 25', { window: { days: [1], start: '08:00', end: '25:00' } }, 'window');
  bad('święta nie tablica', { holidays: '2026-11-11' }, 'holidays');
  bad('święto nieistniejące', { holidays: ['2026-02-30'] }, 'holidays');
  bad('święto w złym formacie', { holidays: ['11.11.2026'] }, 'holidays');
  bad('pole spoza schematu (literówka nie może przejść cicho)', { hardLimitHour: 96 }, 'unknown');
  bad('liczba godzin pracy zamiast okna', { workHours: 10 }, 'unknown');

  test('konfiguracja nie-obiektowa to CONFIG_INVALID:config', () => {
    for (const input of [null, undefined, 'x', 5, []]) {
      assert.throws(() => normalizeConfig(input), err => err instanceof ConfigError && err.field === 'config', String(input));
    }
  });

  test('okno do 24:00 jest dozwolone, a wynik jest zamrożony', () => {
    const c = cfg({ window: { days: [7], start: '00:00', end: '24:00' } });
    assert.equal(c.window.endSeconds, 86400);
    assert.ok(Object.isFrozen(c));
    assert.ok(Object.isFrozen(c.window));
  });

  test('parseClock: poprawne i błędne zapisy', () => {
    assert.equal(parseClock('00:00'), 0);
    assert.equal(parseClock('23:59'), 23 * 3600 + 59 * 60);
    assert.equal(parseClock('24:00'), 86400);
    for (const badText of ['24:01', '25:00', '12:60', '1:00', '12:5', '12-00', '', ' 12:00', '12:00 ']) {
      assert.equal(parseClock(badText), null, badText);
    }
  });
});

describe('#295 warstwa 2: godziny pracy', () => {
  const window = cfg().window;

  test('isWorkingInstant: początek okna włącznie, koniec wyłącznie, weekend i święto poza oknem', () => {
    assert.equal(isWorkingInstant(wall('2026-11-16 08:00:00'), window, []), true);
    assert.equal(isWorkingInstant(wall('2026-11-16 07:59:59'), window, []), false);
    assert.equal(isWorkingInstant(wall('2026-11-16 17:59:59'), window, []), true);
    assert.equal(isWorkingInstant(wall('2026-11-16 18:00:00'), window, []), false);
    assert.equal(isWorkingInstant(wall('2026-11-14 10:00:00'), window, []), false);
    assert.equal(isWorkingInstant(wall('2026-11-15 10:00:00'), window, []), false);
    assert.equal(isWorkingInstant(wall('2026-11-11 10:00:00'), window, []), true);
    assert.equal(isWorkingInstant(wall('2026-11-11 10:00:00'), window, ['2026-11-11']), false);
    assert.equal(isWorkingInstant(wall('2026-11-12 10:00:00'), window, ['2026-11-11']), true);
  });

  test('workingSecondsBetween: noc, weekend, granice okna, kolejność chwil', () => {
    const w = (a, b, holidays = []) => workingSecondsBetween(wall(a), wall(b), window, holidays);
    assert.equal(w('2026-11-17 17:00:00', '2026-11-18 07:00:00'), 3600);
    assert.equal(w('2026-11-13 16:00:00', '2026-11-16 09:00:00'), 3 * 3600);
    assert.equal(w('2026-11-16 08:00:00', '2026-11-16 18:00:00'), 10 * 3600);
    assert.equal(w('2026-11-16 07:00:00', '2026-11-16 19:00:00'), 10 * 3600);
    assert.equal(w('2026-11-16 09:00:00', '2026-11-16 09:00:00'), 0);
    assert.equal(w('2026-11-16 10:00:00', '2026-11-16 09:00:00'), 0);
    assert.equal(w('2026-11-14 09:00:00', '2026-11-15 17:00:00'), 0);
    assert.equal(w('2026-11-10 16:00:00', '2026-11-12 09:00:00'), (2 + 10 + 1) * 3600);
    assert.equal(w('2026-11-10 16:00:00', '2026-11-12 09:00:00', ['2026-11-11']), 3 * 3600);
    assert.equal(w('2026-11-09 08:00:00', '2026-11-16 08:00:00'), 50 * 3600);
  });

  test('6: zmiana czasu przy oknie 01:00–04:00 w niedzielę 29.03.2026 liczy czas ścienny: godzina pominięta wiosną jest godziną okna', () => {
    const sunday = { days: [7], startSeconds: 3600, endSeconds: 4 * 3600 };
    // Na zegarze 01:30 → 04:30 to 2,5 h okna (01:30–04:00), choć rzeczywiście minęło 1,5 h, bo 02:00–03:00 nie istnieje.
    assert.equal(workingSecondsBetween(wall('2026-03-29 01:30:00'), wall('2026-03-29 04:30:00'), sunday, []), 9000);
    // Jesienią, 25.10.2026, 02:00–03:00 zdarza się dwa razy, a w czasie ściennym liczy się raz.
    assert.equal(workingSecondsBetween(wall('2026-10-25 01:30:00'), wall('2026-10-25 04:30:00'), sunday, []), 9000);
  });
});

describe('#295 warstwa 2: assess() i alertLevel', () => {
  const NOW = at('2026-11-18 10:00:00'); // środa, w oknie pracy
  const run = (value, extra = {}, now = NOW) => assess({ read: ok(value), now, config: cfg(extra) });

  test('4: noc — znacznik z 17:00, ocena o 07:00 następnego dnia: godziny pracy poniżej progu, brak alarmu mimo stanu STALE warstwy 1', () => {
    const r = assess({ read: ok('2026-11-17 17:00:00'), now: at('2026-11-18 07:00:00'), config: cfg() });
    assert.equal(r.alertLevel, 'OK');
    assert.equal(r.rawState, 'STALE');
    assert.equal(r.reason, null);
    assert.equal(r.workingSeconds, 3600);
    assert.equal(r.ageSeconds, 14 * 3600);
    assert.equal(r.deferred, false);
    assert.equal(r.readOk, true);
  });

  test('5: weekend — piątek 16:00 oceniany w poniedziałek 09:00 ma 3 h pracy i 65 h wieku, więc OK', () => {
    const r = assess({ read: ok('2026-11-13 16:00:00'), now: at('2026-11-16 09:00:00'), config: cfg() });
    assert.equal(r.alertLevel, 'OK');
    assert.equal(r.workingSeconds, 3 * 3600);
    assert.equal(r.ageSeconds, 65 * 3600);
  });

  test('5: po przekroczeniu progu godzin pracy jest ALERT_STALE z powodem WORKING_HOURS', () => {
    const r = assess({ read: ok('2026-11-13 10:00:00'), now: at('2026-11-16 09:00:00'), config: cfg() });
    assert.equal(r.alertLevel, 'ALERT_STALE');
    assert.equal(r.reason, 'WORKING_HOURS');
    assert.equal(r.workingSeconds, 9 * 3600);
    assert.equal(r.deferred, false);
    assert.equal(r.rawState, 'STALE');
  });

  test('5: próg godzin pracy jest ostry: dokładnie na progu to jeszcze OK, sekunda więcej to alarm', () => {
    assert.equal(assess({ read: ok('2026-11-18 04:00:00'), now: at('2026-11-18 14:00:00'), config: cfg({ window: { days: [3], start: '04:00', end: '20:00' } }) }).alertLevel, 'ALERT_STALE');
    const onThreshold = assess({ read: ok('2026-11-18 08:00:00'), now: at('2026-11-18 14:00:00'), config: cfg() });
    assert.equal(onThreshold.workingSeconds, 6 * 3600);
    assert.equal(onThreshold.alertLevel, 'OK');
    const over = assess({ read: ok('2026-11-18 07:59:59'), now: at('2026-11-18 14:00:01'), config: cfg() });
    assert.equal(over.workingSeconds, 6 * 3600 + 1);
    assert.equal(over.alertLevel, 'ALERT_STALE');
  });

  test('5: stan ACTIVE warstwy 1 to OK', () => {
    const r = run('2026-11-18 09:30:00');
    assert.deepEqual([r.alertLevel, r.rawState, r.reason, r.ageSeconds, r.workingSeconds], ['OK', 'ACTIVE', null, 1800, 1800]);
  });

  test('6: granica okna — alarm z progu godzin pracy poza oknem czeka (deferred), w oknie nie czeka', () => {
    // Okno 08:00–12:00; znacznik 08:00 w środę, próg 3 h pracy: przekroczenie w oknie o 11:00:01.
    const config = cfg({ workingHoursThresholdHours: 3, window: { days: [3], start: '08:00', end: '12:00' } });
    const inside = assess({ read: ok('2026-11-18 08:00:00'), now: at('2026-11-18 11:00:01'), config });
    assert.deepEqual([inside.alertLevel, inside.deferred], ['ALERT_STALE', false]);
    // Po zamknięciu okna wiek godzin pracy stoi na 4 h (> 3 h), ale alarm czeka do otwarcia.
    const closed = assess({ read: ok('2026-11-18 08:00:00'), now: at('2026-11-18 12:00:00'), config });
    assert.deepEqual([closed.alertLevel, closed.reason, closed.deferred], ['ALERT_STALE', 'WORKING_HOURS', true]);
    const closedLater = assess({ read: ok('2026-11-18 08:00:00'), now: at('2026-11-18 20:00:00'), config });
    assert.equal(closedLater.deferred, true);
    // Znacznik dokładnie w chwili otwarcia: wiek zaczyna się od 0.
    const open = assess({ read: ok('2026-11-18 08:00:00'), now: at('2026-11-18 08:00:00'), config });
    assert.deepEqual([open.alertLevel, open.workingSeconds, open.deferred], ['OK', 0, false]);
    // Znacznik dokładnie w chwili zamknięcia: nic z okna nie minęło do następnego dnia roboczego.
    const atClose = assess({ read: ok('2026-11-18 12:00:00'), now: at('2026-11-18 12:00:00'), config });
    assert.deepEqual([atClose.alertLevel, atClose.workingSeconds], ['OK', 0]);
  });

  test('6: zmiana czasu przy oknie obejmującym 02:00–03:00: godziny liczone w czasie ściennym', () => {
    const config = cfg({ workingHoursThresholdHours: 2, hardLimitHours: 24, window: { days: [7], start: '01:00', end: '04:00' } });
    // 01:30 → 04:00 to 2,5 h okna na zegarze (rzeczywiście 1,5 h): alarm z godzin pracy, wynik opisany w dokumentacji.
    const r = assess({ read: ok('2026-03-29 01:30:00'), now: at('2026-03-29 04:30:00'), config });
    assert.equal(r.workingSeconds, 9000);
    assert.equal(r.alertLevel, 'ALERT_STALE');
    assert.equal(r.reason, 'WORKING_HOURS');
    assert.equal(r.deferred, true);
  });

  test('7: święto z listy skraca wiek w godzinach pracy; święto spoza listy nie psuje oceny, bo działa twardy limit', () => {
    const now = at('2026-11-12 09:00:00');
    const withHoliday = assess({ read: ok('2026-11-10 16:00:00'), now, config: cfg({ holidays: ['2026-11-11'] }) });
    assert.equal(withHoliday.alertLevel, 'OK');
    assert.equal(withHoliday.workingSeconds, 3 * 3600);
    const withoutList = assess({ read: ok('2026-11-10 16:00:00'), now, config: cfg() });
    assert.equal(withoutList.alertLevel, 'ALERT_STALE');
    assert.equal(withoutList.workingSeconds, 13 * 3600);
    // Długi weekend z niewpisanym świętem: po 96 h bezwzględnych alarm i tak wchodzi.
    const long = assess({ read: ok('2026-11-10 16:00:00'), now: at('2026-11-14 16:00:01'), config: cfg({ workingHoursThresholdHours: 1000 }) });
    assert.equal(long.alertLevel, 'ALERT_STALE');
    assert.equal(long.reason, 'HARD_LIMIT');
  });

  test('8: twardy limit liczy rawAge z weekendami i alarmuje niezależnie od okna, także poza godzinami pracy i bez czekania', () => {
    const config = cfg({ workingHoursThresholdHours: 1000, hardLimitHours: 96 });
    const onLimit = assess({ read: ok('2026-11-13 12:00:00'), now: at('2026-11-17 12:00:00'), config });
    assert.deepEqual([onLimit.alertLevel, onLimit.ageSeconds], ['OK', 96 * 3600]);
    const over = assess({ read: ok('2026-11-13 12:00:00'), now: at('2026-11-17 12:00:01'), config });
    assert.deepEqual([over.alertLevel, over.reason, over.deferred], ['ALERT_STALE', 'HARD_LIMIT', false]);
    // Poza godzinami pracy (sobota 03:00) alarm z limitu nie czeka.
    const night = assess({ read: ok('2026-11-10 03:00:00'), now: at('2026-11-14 03:00:01'), config });
    assert.deepEqual([night.alertLevel, night.reason, night.deferred], ['ALERT_STALE', 'HARD_LIMIT', false]);
    // Lista dni wolnych obejmująca cały okres nie wyłącza limitu.
    const holidays = ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];
    const covered = assess({ read: ok('2026-11-10 03:00:00'), now: at('2026-11-14 03:00:01'), config: cfg({ workingHoursThresholdHours: 1000, holidays }) });
    assert.equal(covered.reason, 'HARD_LIMIT');
    assert.equal(covered.workingSeconds, null);
  });

  test('8: limit domyślny to 96 h, a jawny zmienia próg', () => {
    const r = assess({ read: ok('2026-11-13 12:00:00'), now: at('2026-11-17 12:00:01'), config: cfg({ workingHoursThresholdHours: 1000, hardLimitHours: 200 }) });
    assert.equal(r.alertLevel, 'OK');
  });

  test('9: źródło bez ruchu — alarm ciągły z powodem limitu bezwzględnego, także gdy próg godzin pracy nie jest przekroczony', () => {
    for (const now of ['2026-11-18 10:00:00', '2026-11-21 10:00:00', '2026-11-22 23:00:00']) {
      const r = assess({ read: ok('2026-11-01 10:00:00'), now: at(now), config: cfg({ workingHoursThresholdHours: 100000 }) });
      assert.equal(r.alertLevel, 'ALERT_STALE', now);
      assert.equal(r.reason, 'HARD_LIMIT', now);
    }
  });

  test('ERROR warstwy 1 (pusty, zły, z przyszłości) to ALERT_ERROR z powodem MARKER_INVALID, bez wieku', () => {
    for (const value of ['', 'x', '2026-02-30 10:00:00', '2026-11-18 10:00:01', 5, null, undefined, '2026-11-18T09:00:00']) {
      const r = run(value);
      assert.equal(r.alertLevel, 'ALERT_ERROR', String(value));
      assert.equal(r.reason, 'MARKER_INVALID', String(value));
      assert.equal(r.rawState, 'ERROR', String(value));
      assert.equal(r.readOk, true, String(value));
      assert.equal(r.ageSeconds, null, String(value));
      assert.equal(r.workingSeconds, null, String(value));
      assert.equal(r.deferred, false, String(value));
    }
  });

  test('nieudany odczyt to ALERT_ERROR z powodem READ_FAILED, z kodem HTTP tylko gdy jest liczbą całkowitą', () => {
    const a = assess({ read: { ok: false, status: 403 }, now: NOW, config: cfg() });
    assert.deepEqual([a.alertLevel, a.reason, a.rawState, a.readOk, a.httpStatus, a.ageSeconds, a.deferred], ['ALERT_ERROR', 'READ_FAILED', 'ERROR', false, 403, null, false]);
    for (const status of [undefined, null, 'https://x', 403.5, NaN, 99, 600, '403']) {
      const b = assess({ read: { ok: false, status }, now: NOW, config: cfg() });
      assert.equal(b.httpStatus, null, String(status));
      assert.equal(b.reason, 'READ_FAILED', String(status));
    }
    assert.equal(assess({ read: { ok: false, status: 100 }, now: NOW, config: cfg() }).httpStatus, 100);
    assert.equal(assess({ read: { ok: false, status: 599 }, now: NOW, config: cfg() }).httpStatus, 599);
  });

  test('wartość z odczytu w postaci tablicy (dodatkowe kolumny) jest sprowadzana do pierwszej komórki', () => {
    assert.equal(run([['2026-11-18 09:30:00', 'ktos@example.invalid', 'inna kolumna']]).alertLevel, 'OK');
    assert.equal(run(['2026-11-18 09:30:00', 'inna']).alertLevel, 'OK');
    assert.equal(run([[]]).reason, 'MARKER_INVALID');
    assert.equal(run([]).reason, 'MARKER_INVALID');
  });

  test('znacznik jako data jest czytany w strefie instalacji', () => {
    assert.equal(run(at('2026-11-18 09:30:00')).alertLevel, 'OK');
    assert.equal(run(at('2026-11-18 09:30:00')).ageSeconds, 1800);
  });

  test('warstwa 2 nie zmienia słownika #197: rawState to ACTIVE/STALE/ERROR niezależnie od alertLevel', () => {
    const states = new Set();
    for (const [value, now] of [['2026-11-18 09:30:00', NOW], ['2026-11-17 17:00:00', at('2026-11-18 07:00:00')], ['', NOW]]) {
      states.add(assess({ read: ok(value), now, config: cfg() }).rawState);
    }
    assert.deepEqual([...states].sort(), ['ACTIVE', 'ERROR', 'STALE']);
  });
});
