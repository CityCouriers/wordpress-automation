'use strict';

/**
 * Tabela przypadków 1–10 z #197 (świeżość źródła), wspólna dla testów funkcji
 * `sourceFreshness_()`, natywnej formuły i niezależnego sprawdzacza z #295.
 *
 * Czas „teraz” w tabeli to 2026-09-29 12:00:00 czasu ściennego strefy arkusza,
 * a `makeDate(rok, miesiąc0, dzień, godz, min, s, ms)` zwraca obiekt daty
 * pokazujący ten czas ścienny w strefie testu. Wywołujący decyduje, jak go zbudować
 * (konstruktor lokalny dla harnessu VM, `Date.UTC` z przesunięciem dla testów
 * niezależnych od strefy maszyny).
 *
 * @param {function(...number): Date} makeDate
 */
function freshnessCases(makeDate) {
  const at = (h, mi = 0, s = 0, ms = 0) => makeDate(2026, 8, 29, h, mi, s, ms);
  return [
    { n: '1. młodszy niż próg', ts: at(11), thr: 2, want: 'ACTIVE' },
    { n: '2. dokładnie na granicy', ts: at(10), thr: 2, want: 'ACTIVE' },
    { n: '2. sekundę za granicą', ts: at(9, 59, 59), thr: 2, want: 'STALE' },
    { n: '2. granica, ułamek sekundy poniżej połowy', ts: at(9, 59, 59, 600), thr: 2, want: 'ACTIVE' },
    { n: '2. granica, ułamek sekundy powyżej połowy', ts: at(9, 59, 59, 400), thr: 2, want: 'STALE' },
    { n: '2. próg ułamkowy 1,5 h na granicy', ts: at(10, 30), thr: 1.5, want: 'ACTIVE' },
    { n: '3. starszy niż próg', ts: at(9), thr: 2, want: 'STALE' },
    { n: '3. starszy o dni', ts: makeDate(2026, 8, 20, 12), thr: 48, want: 'STALE' },
    { n: '4. pusta komórka', ts: '', thr: 2, want: 'ERROR' },
    { n: '5. 30 lutego', ts: '2026-02-30 10:00:00', thr: 2, want: 'ERROR' },
    { n: '5. 13. miesiąc', ts: '2026-13-01 10:00:00', thr: 2, want: 'ERROR' },
    { n: '5. miesiąc 00', ts: '2026-00-10 10:00:00', thr: 2, want: 'ERROR' },
    { n: '5. dzień 00', ts: '2026-09-00 10:00:00', thr: 2, want: 'ERROR' },
    { n: '5. godzina 24', ts: '2026-09-29 24:00:00', thr: 2, want: 'ERROR' },
    { n: '5. minuta 60', ts: '2026-09-29 10:60:00', thr: 2, want: 'ERROR' },
    { n: '5. sekunda 60', ts: '2026-09-29 10:00:60', thr: 2, want: 'ERROR' },
    { n: '5. rok przed 1900', ts: '1899-12-31 10:00:00', thr: 2, want: 'ERROR' },
    { n: '5. 29 lutego w roku nieprzestępnym', ts: '2025-02-29 10:00:00', thr: 100000, want: 'ERROR' },
    { n: '5. 29 lutego w roku przestępnym', ts: '2024-02-29 10:00:00', thr: 100000, want: 'ACTIVE' },
    { n: '5. liczba bez formatu daty', ts: 46294.5, thr: 2, want: 'ERROR' },
    { n: '5. wartość logiczna', ts: true, thr: 2, want: 'ERROR' },
    { n: '6. próg 0', ts: at(11), thr: 0, want: 'ERROR' },
    { n: '6. próg ujemny', ts: at(11), thr: -1, want: 'ERROR' },
    { n: '6. próg jako tekst', ts: at(11), thr: '2', want: 'ERROR' },
    { n: '6. próg pusty', ts: at(11), thr: '', want: 'ERROR' },
    { n: '6. próg logiczny', ts: at(11), thr: true, want: 'ERROR' },
    { n: '6. próg będący datą', ts: at(11), thr: at(2), want: 'ERROR' },
    { n: '7. znacznik z przyszłości', ts: at(12, 0, 1), thr: 2, want: 'ERROR' },
    { n: '7. przyszłość poniżej pół sekundy to ta sama sekunda', ts: at(12, 0, 0, 400), thr: 2, want: 'ACTIVE' },
    { n: '8. tekst młodszy niż próg', ts: '2026-09-29 11:30:00', thr: 1, want: 'ACTIVE' },
    { n: '8. tekst na granicy', ts: '2026-09-29 11:00:00', thr: 1, want: 'ACTIVE' },
    { n: '8. tekst starszy niż próg', ts: '2026-09-29 10:59:59', thr: 1, want: 'STALE' },
    { n: '8. tekst z przyszłości', ts: '2026-09-29 12:00:01', thr: 1, want: 'ERROR' },
    { n: '9. format ISO z T', ts: '2026-09-29T11:00:00', thr: 2, want: 'ERROR' },
    { n: '9. format polski', ts: '29.09.2026 11:00:00', thr: 2, want: 'ERROR' },
    { n: '9. bez sekund', ts: '2026-09-29 11:00', thr: 2, want: 'ERROR' },
    { n: '9. spacja na końcu', ts: '2026-09-29 11:00:00 ', thr: 2, want: 'ERROR' },
    { n: '9. tekst, który ISDATE uznałby za datę', ts: 'July 20 1969', thr: 2, want: 'ERROR' },
    { n: '10. źródło A, próg 3 h', ts: at(8), thr: 3, want: 'STALE' },
    { n: '10. źródło B, ten sam znacznik, próg 6 h', ts: at(8), thr: 6, want: 'ACTIVE' }
  ];
}

module.exports = { freshnessCases };
