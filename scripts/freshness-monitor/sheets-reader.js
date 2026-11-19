'use strict';

/**
 * Czytnik znacznika (#295): jedna komórka pliku sygnałowego przez Sheets API v4 (`values.get`).
 *
 * Zasada minimalnych uprawnień: tożsamość sprawdzacza ma dostęp tylko do małego pliku sygnałowego,
 * nie do arkusza z wierszami zgłoszeń, a czytnik prosi wyłącznie o skonfigurowaną komórkę. Zakres
 * szerszy niż jedna komórka jest odrzucany przy tworzeniu, a `read()` nie przyjmuje żadnego argumentu.
 *
 * Błędy nie niosą adresu żądania ani tekstu odpowiedzi: adres zawiera identyfikator pliku, a maskowanie
 * sekretów w logach nie obejmuje jego pochodnych (np. po zakodowaniu URL). Błąd HTTP to sam kod.
 *
 * Komórka sygnałowa powinna zawierać znacznik jako tekst `RRRR-MM-DD GG:MM:SS` w strefie instalacji
 * (np. `TEXT(MAX(IMPORTRANGE(...));"yyyy-mm-dd hh:mm:ss")`); odczyt używa `FORMATTED_VALUE`.
 */

const BASE_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;
/** Jedna komórka, opcjonalnie z nazwą arkusza: `A1`, `Znacznik!B2`, `'Nazwa z spacją'!B2`. */
const CELL_PATTERN = /^(?:(?:'[^'!:]{1,100}'|[A-Za-z0-9_.]{1,100})!)?\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}$/;
const TIMEOUT_MS = 15000;

/** Błąd odczytu: tylko kod HTTP (liczba) albo nic; komunikat jest stały. */
class ReadError extends Error {
  constructor(status) {
    super(status === undefined ? 'READ_FAILED' : `HTTP ${status}`);
    this.name = 'ReadError';
    if (status !== undefined) this.status = status;
  }
}

class ReaderConfigError extends Error {
  constructor(field) {
    super(`READER_CONFIG_INVALID:${field}`);
    this.name = 'ReaderConfigError';
    this.field = field;
  }
}

/**
 * @param {{fileId: string, range: string, token: string, fetchFn?: function}} options
 * @return {{read: function(): Promise<string>}}
 */
function createSheetsReader({ fileId, range, token, fetchFn = fetch }) {
  if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) throw new ReaderConfigError('fileId');
  if (typeof range !== 'string' || !CELL_PATTERN.test(range)) throw new ReaderConfigError('range');
  if (typeof token !== 'string' || token.length === 0) throw new ReaderConfigError('token');
  const url = `${BASE_URL}/${encodeURIComponent(fileId)}/values/${encodeURIComponent(range)}` +
    '?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS';

  return {
    async read() {
      let response;
      try {
        response = await fetchFn(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS)
        });
      } catch {
        throw new ReadError();
      }
      if (!response.ok) throw new ReadError(response.status);
      let body;
      try {
        body = await response.json();
      } catch {
        throw new ReadError();
      }
      const row = body && Array.isArray(body.values) ? body.values[0] : undefined;
      return Array.isArray(row) && row.length > 0 ? row[0] : '';
    }
  };
}

module.exports = { CELL_PATTERN, ReadError, ReaderConfigError, createSheetsReader };
