'use strict';

/**
 * Kalibracja progu w godzinach pracy (#295): co najmniej 1,5 raza najdłuższa zaobserwowana prawidłowa
 * przerwa między rekordami, liczona w godzinach okna pracy, z ostatnich 3 miesięcy.
 *
 * Kalibracja używa WYŁĄCZNIE znaczników czasu rekordów (bez treści). Wynik trafia do konfiguracji
 * instalacji (`workingHoursThresholdHours`), nie do repozytorium. Uruchamia ją człowiek raz, na liście
 * znaczników wyeksportowanej ze źródła; sprawdzacz nigdy jej nie woła.
 */

const { wallSeconds, workingSecondsBetween } = require('./wall-time');

/** Początek okna kalibracji: `months` miesięcy kalendarzowych przed `nowWall` (sekundy czasu ściennego). */
function cutoffWall(nowWall, months) {
  const date = new Date(nowWall * 1000);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.getTime() / 1000;
}

/**
 * @param {{stamps: Array<Date|string>, now: Date, config: object, months?: number, factor?: number}} input
 *   `config` z `normalizeConfig` (strefa, okno, święta); znaczniki spoza kontraktu są pomijane
 * @return {{samples: number, longestGapHours: (number|null), recommendedThresholdHours: (number|null)}}
 */
function calibrateThreshold({ stamps, now, config, months = 3, factor = 1.5 }) {
  const nowWall = wallSeconds(now, config.timeZone);
  const from = cutoffWall(nowWall, months);
  const walls = stamps
    .map(stamp => wallSeconds(stamp, config.timeZone))
    // Znacznik spoza kontraktu (null) nie przechodzi porównania z `from`: null >= from jest fałszem.
    .filter(wall => wall >= from && wall <= nowWall)
    .sort((a, b) => a - b);
  if (walls.length < 2) return { samples: walls.length, longestGapHours: null, recommendedThresholdHours: null };
  const gaps = walls.slice(1).map((wall, i) => workingSecondsBetween(walls[i], wall, config.window, config.holidays));
  const longest = Math.max(...gaps);
  return {
    samples: walls.length,
    longestGapHours: longest / 3600,
    recommendedThresholdHours: Math.ceil((longest * factor) / 3600)
  };
}

module.exports = { calibrateThreshold };
