'use strict';

// Straż przedwczesnego wyjścia (#253). Testy narzędzi potoku mutacji wczytują moduły z warunkiem
// `if (require.main === module) main()`. Zmutowany warunek (`require.main !== module`) uruchamia wtedy narzędzie
// w procesie samego testu, a ono kończy go przez `process.exit(0)` zanim przejdzie choć jeden test: plik testowy
// wygląda na zielony, choć nic nie sprawdził. Ta straż zamienia takie wyjście w porażkę (kod 1).
// Wystarczy wczytać ją na początku pliku testowego: `require('./helpers/exit-guard.js')`.
const { after } = require('node:test');

let finished = false;
process.on('exit', () => {
  if (!finished) process.exitCode = 1;
});
after(() => {
  finished = true;
});
