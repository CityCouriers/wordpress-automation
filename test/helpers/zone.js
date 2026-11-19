'use strict';

/**
 * Pomocnik testów #295: chwila rzeczywista dla podanego czasu ściennego w strefie.
 * Testy sprawdzacza muszą dawać ten sam wynik przy każdej strefie maszyny (`TZ=UTC npm test`),
 * więc nigdy nie budują dat konstruktorem lokalnym.
 */

const PARTS = {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
};

/** Czas ścienny strefy dla chwili `ms`, jako milisekundy „UTC” z tych samych liczb. */
function wallMillis(ms, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, ...PARTS })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/**
 * @param {string} text `RRRR-MM-DD GG:MM[:SS]` czas ścienny w strefie
 * @param {string} [timeZone]
 * @return {Date}
 */
function at(text, timeZone = 'Europe/Warsaw') {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) throw new Error('zły czas ścienny w teście: ' + text);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let guess = asUtc;
  for (let i = 0; i < 3; i++) guess = asUtc - (wallMillis(guess, timeZone) - guess);
  return new Date(guess);
}

module.exports = { at, wallMillis };
