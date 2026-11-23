// Kanarek mutacyjny: maleńkie źródło, którego KAŻDY mutant da się zabić testem canary.test.js.
// Kontrola dodatnia w każdym przebiegu: jeśli łańcuch (kopia cienia, instrumentacja Strykera, vm-preload,
// komenda testowa, klasyfikacja) nie zabija mutantów tego pliku z asercją, pomiar prawdziwych plików
// jest nieważny. Plik NIE jest częścią projektu Apps Script: leży poza src/ i nigdy nie trafia do clasp.
function canaryTotal_(price, quantity) {
  return price * quantity;
}

function canaryLabel_(flag) {
  return flag ? 'tak' : 'nie';
}

function canaryJoin_(left, right) {
  return left + '-' + right;
}
