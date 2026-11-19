'use strict';

/**
 * Czas ścienny strefy instalacji (#295), liczony tak samo jak `src/SourceFreshness.gs` (#197).
 *
 * Arkusz trzyma daty jako numer seryjny czasu lokalnego, więc wiek to różnica czasów ściennych,
 * a nie rzeczywista: w noc zmiany czasu jest o godzinę większy albo mniejszy (README, sekcja
 * „Świeżość zewnętrznego źródła”). Ten moduł zachowuje to odchylenie świadomie, żeby sprawdzacz
 * zgadzał się z formułą w arkuszu 1:1. Godziny pracy (warstwa 2) liczą się w tym samym czasie
 * ściennym, więc godzina pominięta wiosną liczy się jako godzina okna, a powtórzona jesienią raz.
 */

/** Jedyny obsługiwany format tekstowego znacznika: `YYYY-MM-DD HH:MM:SS`. */
const TEXT_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

const SECONDS_PER_DAY = 86400;

/** `Object.prototype.toString`, bo data z innego kontekstu VM nie jest `instanceof Date`. */
function isValidDate(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

/** `ROUND` z arkusza: połówki od zera, także dla liczb ujemnych (Math.round idzie w górę). */
function roundHalfAwayFromZero(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * Tekst `YYYY-MM-DD HH:MM:SS` czytany strukturalnie, bez parsera zależnego od ustawień
 * regionalnych. Data nieistniejąca (31 kwietnia, 13. miesiąc, 24:00) i rok poniżej 1900 to null.
 *
 * @param {string} text
 * @return {number|null} sekundy czasu ściennego (jak liczby „UTC”) albo null
 */
function parseWallText(text) {
  const m = TEXT_PATTERN.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysInMonth ||
      hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
}

/**
 * Sekundy czasu ściennego w strefie albo null dla wartości spoza kontraktu (data, tekst
 * `YYYY-MM-DD HH:MM:SS`; liczba bez formatu daty jest poza kontraktem). Zła strefa rzuca RangeError.
 */
function wallSeconds(value, timeZone) {
  if (isValidDate(value)) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(value).map(p => [p.type, p.value]));
    const wall = parseWallText(`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`);
    return wall + value.getMilliseconds() / 1000;
  }
  return typeof value === 'string' ? parseWallText(value) : null;
}

/** `HH:MM` → sekundy od północy (24:00 dozwolone jako koniec okna) albo null. */
function parseClock(text) {
  const m = /^(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute > 59 || hour > 24 || (hour === 24 && minute !== 0)) return null;
  return hour * 3600 + minute * 60;
}

/** Dzień tygodnia 1 (poniedziałek) … 7 (niedziela) i klucz `RRRR-MM-DD` dla doby o numerze `dayIndex` od 1970. */
function dayInfo(dayIndex) {
  const date = new Date(dayIndex * SECONDS_PER_DAY * 1000);
  const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  return { weekday, key: date.toISOString().slice(0, 10) };
}

function isWorkingDay(dayIndex, window, holidays) {
  const { weekday, key } = dayInfo(dayIndex);
  return window.days.includes(weekday) && !holidays.includes(key);
}

/** Czy chwila (sekundy czasu ściennego) leży w oknie pracy: początek włącznie, koniec wyłącznie. */
function isWorkingInstant(wall, window, holidays) {
  const dayIndex = Math.floor(wall / SECONDS_PER_DAY);
  if (!isWorkingDay(dayIndex, window, holidays)) return false;
  const second = wall - dayIndex * SECONDS_PER_DAY;
  return second >= window.startSeconds && second < window.endSeconds;
}

/**
 * Sekundy okna pracy między dwiema chwilami czasu ściennego (obie w sekundach, jak z `wallSeconds`).
 * Dni wolne i dni spoza okna nie liczą się; nowsza chwila przed starszą daje 0 (każdy dzień wnosi `max(0, …)`).
 */
function workingSecondsBetween(fromWall, toWall, window, holidays) {
  let total = 0;
  for (let day = Math.floor(fromWall / SECONDS_PER_DAY); day <= Math.floor(toWall / SECONDS_PER_DAY); day++) {
    if (!isWorkingDay(day, window, holidays)) continue;
    const open = day * SECONDS_PER_DAY + window.startSeconds;
    const close = day * SECONDS_PER_DAY + window.endSeconds;
    total += Math.max(0, Math.min(close, toWall) - Math.max(open, fromWall));
  }
  return total;
}

module.exports = {
  SECONDS_PER_DAY,
  isValidDate,
  isWorkingInstant,
  parseClock,
  parseWallText,
  roundHalfAwayFromZero,
  wallSeconds,
  workingSecondsBetween
};
