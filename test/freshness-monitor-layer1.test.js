'use strict';

/**
 * #295, warstwa 1: świeżość surowa zgodna z `sourceFreshness_()` z #197 (przypadki 1–3 specyfikacji).
 * Sprawdzacz liczy to samo drugi raz, niezależnie od formuły w arkuszu, więc ten test porównuje go
 * z funkcją z `src/SourceFreshness.gs` na całej tabeli przypadków z #197, a nie z własnym oczekiwaniem.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/gas');
const { freshnessCases } = require('./helpers/freshness-cases');
const { at } = require('./helpers/zone');
const { rawFreshness, ACTIVE, STALE, ERROR } = require('../scripts/freshness-monitor/freshness');
const { wallSeconds, parseWallText, roundHalfAwayFromZero, isValidDate } = require('../scripts/freshness-monitor/wall-time');

const TZ = 'Europe/Warsaw';

/** Funkcja z #197 z prawdziwą strefą arkusza (stub harnessu formatuje w strefie maszyny). */
function gasWithZone() {
  const gas = loadProject({ properties: {} });
  gas.Utilities.formatDate = (date, tz, pattern) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).map(x => [x.type, x.value]));
    return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
      .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
  };
  return gas;
}

/** Wrzesień 2026 w Warszawie to CEST (UTC+2): ta sama chwila rzeczywista dla obu implementacji. */
const makeUtcDate = (y, m, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(Date.UTC(y, m, d, h - 2, mi, s, ms));

/** Funkcja z `.gs` odróżnia typy przez `Object.prototype.toString`, więc chwilę przenosimy do kontekstu VM wprost. */
function copyForGas(gas, value) {
  return value instanceof Date ? new gas.$Date(value.getTime()) : value;
}

describe('#295 warstwa 1: zgodność 1:1 z sourceFreshness_()', () => {
  test('1: tabela przypadków 1–10 z #197 daje te same stany co funkcja z arkusza i co oczekiwano w #197', () => {
    const gas = gasWithZone();
    const now = makeUtcDate(2026, 8, 29, 12);
    const table = freshnessCases(makeUtcDate);
    assert.ok(table.length >= 40, 'tabela nie może się skurczyć po cichu');
    for (const c of table) {
      const fromGas = gas.sourceFreshness_(copyForGas(gas, c.ts), copyForGas(gas, c.thr), copyForGas(gas, now), TZ);
      const mine = rawFreshness(c.ts, c.thr, now, TZ).state;
      assert.equal(mine, fromGas, c.n);
      assert.equal(mine, c.want, c.n);
    }
  });

  test('1: niepoprawny obiekt daty jako znacznik albo „teraz”, zły typ „teraz” i próg NaN/Infinity to ERROR', () => {
    const now = makeUtcDate(2026, 8, 29, 12);
    const ts = makeUtcDate(2026, 8, 29, 11);
    assert.equal(rawFreshness(new Date('x'), 2, now, TZ).state, ERROR);
    assert.equal(rawFreshness(ts, 2, new Date('x'), TZ).state, ERROR);
    assert.equal(rawFreshness(ts, 2, '2026-09-29 12:00:00', TZ).state, ERROR);
    assert.equal(rawFreshness(ts, NaN, now, TZ).state, ERROR);
    assert.equal(rawFreshness(ts, Infinity, now, TZ).state, ERROR);
  });

  test('1: ERROR nie ma wieku, a stany poprawne mają wiek w pełnych sekundach', () => {
    const now = makeUtcDate(2026, 8, 29, 12);
    assert.deepEqual(rawFreshness('', 2, now, TZ), { state: ERROR, ageSeconds: null });
    assert.deepEqual(rawFreshness(makeUtcDate(2026, 8, 29, 10), 2, now, TZ), { state: ACTIVE, ageSeconds: 7200 });
    assert.deepEqual(rawFreshness(makeUtcDate(2026, 8, 29, 9, 59, 59), 2, now, TZ), { state: STALE, ageSeconds: 7201 });
    assert.deepEqual(rawFreshness(makeUtcDate(2026, 8, 29, 12, 0, 1), 2, now, TZ), { state: ERROR, ageSeconds: null });
  });

  test('1: nazwy stanów to dokładnie słownik #197', () => {
    const gas = loadProject({ properties: {} });
    assert.equal(ACTIVE, gas.$get('SOURCE_FRESHNESS_ACTIVE'));
    assert.equal(STALE, gas.$get('SOURCE_FRESHNESS_STALE'));
    assert.equal(ERROR, gas.$get('SOURCE_FRESHNESS_ERROR'));
  });

  test('2: zaokrąglenie jak ROUND: połówki od zera, także ujemne', () => {
    assert.equal(roundHalfAwayFromZero(0.5), 1);
    assert.equal(roundHalfAwayFromZero(1.4), 1);
    assert.equal(roundHalfAwayFromZero(-0.5), -1);
    assert.equal(roundHalfAwayFromZero(-1.4), -1);
    assert.equal(roundHalfAwayFromZero(-1.6), -2);
    assert.ok(roundHalfAwayFromZero(-0.4) === 0);
    const now = makeUtcDate(2026, 8, 29, 12);
    assert.equal(rawFreshness(makeUtcDate(2026, 8, 29, 12, 0, 0, 500), 2, now, TZ).state, ERROR);
    assert.equal(rawFreshness(makeUtcDate(2026, 8, 29, 12, 0, 0, 400), 2, now, TZ).state, ACTIVE);
  });

  test('2: tekst jest czytany w strefie arkusza, tak samo jak data pokazująca ten sam czas ścienny', () => {
    const now = makeUtcDate(2026, 8, 29, 12);
    assert.equal(rawFreshness('2026-09-29 10:00:00', 2, now, TZ).state, rawFreshness(makeUtcDate(2026, 8, 29, 10), 2, now, TZ).state);
    assert.equal(rawFreshness('2026-09-29 09:59:59', 2, now, TZ).state, rawFreshness(makeUtcDate(2026, 8, 29, 9, 59, 59), 2, now, TZ).state);
  });

  for (const [name, stamp, nowInstant, text, thresholds] of [
    ['wiosna 2026-03-29 (01:30 → 04:30 to 2 h rzeczywiste, 3 h na zegarze)',
      at('2026-03-29 01:30'), at('2026-03-29 04:30'), '2026-03-29 01:30:00', [2.5, 3]],
    // 02:30 jesienią jest dwuznaczne (CEST i CET); bierzemy drugie, czyli czas zimowy.
    ['jesień 2026-10-25 (01:30 CEST → 02:30 CET to 2 h rzeczywiste, 1 h na zegarze)',
      at('2026-10-25 01:30'), new Date(Date.UTC(2026, 9, 25, 1, 30)), '2026-10-25 01:30:00', [0.5, 1]]
  ]) {
    test(`2: zmiana czasu, ${name}: wiek w czasie ściennym jak w arkuszu (odchylenie ±1 h z README)`, () => {
      const gas = gasWithZone();
      for (const thr of thresholds) {
        const want = gas.sourceFreshness_(copyForGas(gas, stamp), thr, copyForGas(gas, nowInstant), TZ);
        assert.equal(rawFreshness(stamp, thr, nowInstant, TZ).state, want, `próg ${thr}`);
      }
      assert.equal(rawFreshness(text, thresholds[1], nowInstant, TZ).state, ACTIVE);
      assert.equal(rawFreshness(text, thresholds[0], nowInstant, TZ).state, STALE);
    });
  }

  test('3: zła strefa to ERROR, a nie wyjątek (fail-closed)', () => {
    assert.deepEqual(rawFreshness(new Date(0), 2, new Date(1000), 'Nie/Ma'), { state: ERROR, ageSeconds: null });
  });
});

describe('#295 czas ścienny: wallSeconds i parseWallText', () => {
  test('tekst: struktura bez parsera regionalnego, data nieistniejąca to null', () => {
    assert.equal(parseWallText('2026-09-29 10:00:00'), Date.UTC(2026, 8, 29, 10) / 1000);
    assert.equal(parseWallText('2024-02-29 10:00:00'), Date.UTC(2024, 1, 29, 10) / 1000);
    for (const bad of ['2026-02-30 10:00:00', '2025-02-29 10:00:00', '2026-13-01 10:00:00', '2026-00-10 10:00:00',
      '2026-09-00 10:00:00', '2026-09-29 24:00:00', '2026-09-29 10:60:00', '2026-09-29 10:00:60', '1899-12-31 10:00:00',
      '2026-09-29T10:00:00', '29.09.2026 10:00:00', '2026-09-29 10:00', ' 2026-09-29 10:00:00', '2026-09-29 10:00:00 ',
      '2026-09-29 10:00:00\n', 'x2026-09-29 10:00:00', '']) {
      assert.equal(parseWallText(bad), null, JSON.stringify(bad));
    }
    assert.equal(parseWallText('1900-01-01 00:00:00'), Date.UTC(1900, 0, 1) / 1000);
    assert.equal(parseWallText('2026-12-31 23:59:59'), Date.UTC(2026, 11, 31, 23, 59, 59) / 1000);
    assert.equal(parseWallText('2026-04-30 10:00:00'), Date.UTC(2026, 3, 30, 10) / 1000);
    assert.equal(parseWallText('2026-04-31 10:00:00'), null);
  });

  test('data: czas ścienny w strefie z ułamkiem sekundy; inne typy poza kontraktem', () => {
    assert.equal(wallSeconds(at('2026-09-29 12:00:00'), TZ), Date.UTC(2026, 8, 29, 12) / 1000);
    assert.equal(wallSeconds(new Date(at('2026-09-29 12:00:00').getTime() + 250), TZ), Date.UTC(2026, 8, 29, 12) / 1000 + 0.25);
    assert.equal(wallSeconds('2026-09-29 12:00:00', 'Nie/Ma'), Date.UTC(2026, 8, 29, 12) / 1000);
    assert.equal(wallSeconds(46294.5, TZ), null);
    assert.equal(wallSeconds(true, TZ), null);
    assert.equal(wallSeconds(null, TZ), null);
    assert.equal(wallSeconds(undefined, TZ), null);
    assert.equal(wallSeconds({}, TZ), null);
    assert.equal(wallSeconds(new Date('x'), TZ), null);
    assert.throws(() => wallSeconds(new Date(0), 'Nie/Ma'), RangeError);
  });

  test('północ w strefie to godzina 00, nie 24', () => {
    assert.equal(wallSeconds(at('2026-09-29 00:00:00'), TZ), Date.UTC(2026, 8, 29) / 1000);
  });

  test('isValidDate rozpoznaje datę także z innego kontekstu VM', () => {
    const gas = loadProject({ properties: {} });
    assert.equal(isValidDate(new gas.$Date(0)), true);
    assert.equal(isValidDate(new Date(0)), true);
    assert.equal(isValidDate(new Date('x')), false);
    assert.equal(isValidDate('2026-09-29'), false);
    assert.equal(isValidDate(0), false);
    assert.equal(isValidDate(null), false);
  });
});
