'use strict';

// Baza mutantów równoważnych (#253): .quality/mutation-baseline.json. Wolno tu wpisać WYŁĄCZNIE mutanta, który
// dowiedziono, że nie da się zabić (zmiana nie zmienia zachowania), po niezależnym audycie. Klucz wpisu to
// funkcja oraz dokładna linia źródła przed i po mutacji; wpis bez uzasadnienia i odsyłacza do zatwierdzenia
// w PR jest nieważny. Ocalały mutant spoza bazy jest niezabity i nie ma wyjątku.
// Użycie: node scripts/mutation/baseline.js   (waliduje plik; kod 1 przy błędach)
const fs = require('node:fs');
const path = require('node:path');

const ROOT = require('./repo-root.js');
/** Plik bazy w drzewie o korzeniu `root`. */
const fileOf = root => path.join(root, '.quality', 'mutation-baseline.json');
const APPROVAL = /^https:\/\/github\.com\/CityCouriers\/wordpress-automation\/(pull|issues)\/\d+(#[\w-]+)?$/;
const FIELDS = ['file', 'function', 'before', 'after', 'reason', 'approval'];

/** Lista błędów schematu bazy; pusta = poprawna. */
function validateBaseline(baseline) {
  const errors = [];
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return ['baza nie jest obiektem'];
  if (baseline.version !== 1) errors.push('version musi wynosić 1');
  if (!Array.isArray(baseline.equivalent)) return [...errors, 'equivalent musi być tablicą'];
  const seen = new Set();
  baseline.equivalent.forEach((entry, i) => {
    const where = `equivalent[${i}]`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${where}: wpis nie jest obiektem`);
      return;
    }
    for (const field of FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') errors.push(`${where}: brak pola ${field}`);
    }
    for (const extra of Object.keys(entry).filter(k => !FIELDS.includes(k))) errors.push(`${where}: nieznane pole ${extra}`);
    if (typeof entry.file === 'string' && !/^[A-Za-z0-9]+\.gs$/.test(entry.file)) errors.push(`${where}: file musi być nazwą pliku z src/`);
    if (typeof entry.approval === 'string' && !APPROVAL.test(entry.approval)) errors.push(`${where}: approval musi wskazywać PR lub zgłoszenie tego repozytorium`);
    if (entry.before === entry.after && typeof entry.before === 'string') errors.push(`${where}: before i after są takie same (to nie jest mutacja)`);
    const key = [entry.file, entry.function, entry.before, entry.after].join('\u0000');
    if (seen.has(key)) errors.push(`${where}: duplikat klucza`);
    seen.add(key);
  });
  return errors;
}

/** `root` podmienia korzeń repozytorium (testy używają drzewa tymczasowego), `error` i `exit` wyjścia. */
function main({ root = ROOT, error = console.error, exit = process.exit } = {}) {
  const errors = validateBaseline(JSON.parse(fs.readFileSync(fileOf(root))));
  for (const e of errors) error(e);
  exit(errors.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { validateBaseline, main, FIELDS };
