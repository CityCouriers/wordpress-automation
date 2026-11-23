'use strict';

// Klasyfikacja wyników Strykera (mutacje .gs). Runner `command` uznaje KAŻDY niezerowy kod
// wyjścia za zabicie mutanta, także awarię preludium, loadera czy VM. Ten skrypt czyta surowy
// raport JSON i dzieli zabite na:
//   killed-assert  w wyjściu testów jest nieudana asercja (AssertionError) i brak błędu programu,
//   killed-other   inny niezerowy wynik bez AssertionError (np. TypeError rzucony przez zmutowany kod,
//                  ReferenceError z preludium, awaria loadera): NIE liczy się do zabitych. Trzeba obejrzeć
//                  ślad stosu: błąd z src/ to prawdziwa zmiana zachowania, błąd z preludium to awaria pomiaru.
// Przekroczenia czasu (Timeout), błędy (RuntimeError, CompileError) i ocalałe (Survived) zostają osobnymi
// kategoriami niezabitymi.
// Użycie: node scripts/mutation/classify.js [reports/mutation/mutation.json] [--list]
// Kod wyjścia 3: pomiar nieważny (brak zabitych z asercją, czyli nic nie zostało zmierzone).
const fs = require('node:fs');
const path = require('node:path');

const PROGRAM_ERROR = /\b(ReferenceError|SyntaxError|RangeError)\b|Cannot find module|stryker.*is not defined/;
const FAILING_TEST = /^\s*✖ (.+?) \([\d.]+ms\)/gm;

/** Status mutanta w klasyfikacji: `Killed` dzieli się na killed-assert i killed-other, reszta bez zmian. */
function classifyMutant(mutant) {
  if (mutant.status !== 'Killed') return { status: mutant.status, failing: [] };
  const out = String(mutant.statusReason);
  const failing = [...new Set([...out.matchAll(FAILING_TEST)].map(x => x[1]))];
  const status = /AssertionError/.test(out) && !PROGRAM_ERROR.test(out) ? 'killed-assert' : 'killed-other';
  return { status, failing };
}

/** Liczby per status i wiersze (plik, linia, id, mutator, status, padające testy) z raportu Strykera. */
function classifyReport(report) {
  const counts = {};
  const rows = [];
  for (const [name, entry] of Object.entries(report.files)) {
    for (const mutant of entry.mutants) {
      const { status, failing } = classifyMutant(mutant);
      counts[status] = (counts[status] || 0) + 1;
      rows.push({ file: name, line: mutant.location.start.line, id: mutant.id, mutator: mutant.mutatorName, status, failing });
    }
  }
  return { counts, rows };
}

/** `deps` podmienia odczyt pliku, wyjścia i zakończenie procesu w testach. */
function main(argv, deps = {}) {
  const { read = f => fs.readFileSync(f), log = console.log, error = console.error, exit = process.exit } = deps;
  const file = argv.find((a, i) => i > 1 && !a.startsWith('--')) || path.join('reports', 'mutation', 'mutation.json');
  const { counts, rows } = classifyReport(JSON.parse(read(file)));
  log(JSON.stringify(counts));
  if (argv.includes('--list')) {
    for (const r of rows) log(`${r.status}\t${r.file}:${r.line}\tid=${r.id}\t${r.mutator}\t${r.failing.join(' ; ').slice(0, 100)}`);
  }
  const assertKilled = counts['killed-assert'] || 0;
  log(`wynik wg killed-assert: ${assertKilled}/${rows.length} = ${(100 * assertKilled / rows.length).toFixed(1)} %`);
  if (!(assertKilled > 0)) {
    error('POMIAR NIEWAŻNY: brak zabitych z asercją (killed-assert).');
    exit(3);
    return;
  }
  if (counts['killed-other']) error(`Uwaga: ${counts['killed-other']} zabitych bez asercji (killed-other) poza wynikiem; sprawdź ślad stosu.`);
}

if (require.main === module) main(process.argv);
module.exports = { classifyMutant, classifyReport, main, PROGRAM_ERROR };
