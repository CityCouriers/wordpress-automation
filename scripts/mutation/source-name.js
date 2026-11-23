'use strict';

// Nazwa pliku z src/ podawana narzędziom (np. Payloads.gs): tylko litery i cyfry plus rozszerzenie .gs.
// Jedno miejsce sprawdza nazwę i wyznacza rdzeń (nazwa bez .gs), więc nie ma osobnego zamieniania rozszerzenia.
const SOURCE_NAME = /^([A-Za-z0-9]+)\.gs$/;

/** Rdzeń nazwy (np. Payloads) albo null, gdy nazwa jest nieprawidłowa. */
function stemOf(name) {
  const match = SOURCE_NAME.exec(name);
  return match ? match[1] : null;
}

module.exports = { stemOf };
