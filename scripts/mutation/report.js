'use strict';

// Zestawienie pilota mutacji z pokryciem (pilot mutacji). Czyta reports/mutation/result-<Plik>.json
// (raport Strykera), selection-<Plik>.json (wybór testów) i coverage/lcov.info (npm run test:coverage),
// a progi z .quality/coverage-policy.json. Pisze:
//   reports/mutation/summary.json  liczby per plik
//   reports/mutation/LISTY.md      jawne listy: niepokryte linie, ocalałe, bez pokrycia, przekroczenia czasu
// Użycie: node scripts/mutation/report.js [Plik.gs ...]   (bez argumentów: wszystkie z result-*.json)
const fs = require('node:fs');
const path = require('node:path');
const { parseLcov, ranges } = require('./lcov.js');

const ROOT = require('./repo-root.js');

/** Linie z mutantami w zakresach i liczba mutantów, np. "10-12 15 [4 mutantów]". */
function lineList(lines) {
  return `${ranges(new Set(lines))} [${lines.length} mutantów]`;
}

const PROGRAM_ERROR = /\b(ReferenceError|SyntaxError)\b|Cannot find module|stryker.*is not defined/;

/** Lista pliku albo „brak”. */
const listOrNone = lines => (lines.length ? lineList(lines) : 'brak');

/** `deps` podmienia korzeń repozytorium i wyjście (testy; produkcyjnie domyślne). */
function main(argv, { root = ROOT, log = console.log } = {}) {
  const out = path.join(root, 'reports', 'mutation');
  const lcov = parseLcov(path.join(root, 'coverage', 'lcov.info'));
  const policy = JSON.parse(fs.readFileSync(path.join(root, '.quality', 'coverage-policy.json')));
  const threshold = name => {
    const rule = policy.rules.find(r => r.pattern === `src/${name}`);
    return rule ? rule.threshold : policy.defaultThreshold;
  };
  const requested = argv.slice(2);
  const names = requested.length
    ? requested
    : fs.readdirSync(out).filter(f => /^result-.*\.json$/.test(f)).map(f => `${f.replace(/^result-|\.json$/g, '')}.gs`).sort();

  const summary = {};
  const md = ['# Listy: pokrycie i mutacje (pilot)', ''];
  for (const name of names) {
    const stem = name.replace(/\.gs$/, '');
    const readJson = file => JSON.parse(fs.readFileSync(path.join(out, file)));
    const report = readJson(`result-${stem}.json`);
    const sel = readJson(`selection-${stem}.json`);
    const time = fs.existsSync(path.join(out, `time-${stem}.json`)) ? readJson(`time-${stem}.json`) : {};
    const mutants = Object.values(report.files)[0].mutants;

    const cov = lcov[name];
    const lineHits = cov ? [...cov.lines] : [];
    const uncovered = lineHits.filter(([, h]) => h === 0).map(([l]) => l);
    const branchTotal = cov ? cov.branches.size : 0;
    const branchMissed = cov ? [...cov.branches.values()].filter(h => h === 0).length : 0;
    const linePct = lineHits.length ? 100 * (lineHits.length - uncovered.length) / lineHits.length : 100;
    const thr = threshold(name);

    const by = { 'killed-assert': 0, 'killed-other': 0, Survived: 0, NoCoverage: 0, Timeout: 0, Error: 0, Ignored: 0 };
    const lists = { survived: [], noCoverage: [], timeout: [], killedOther: [], error: [] };
    const uncoveredSet = new Set(uncovered);
    let mutantsOnUncovered = 0;
    let survivedOnCovered = 0;
    for (const m of mutants) {
      const line = m.location.start.line;
      const noTests = Array.isArray(sel.mutants[m.id]) && sel.mutants[m.id].length === 0;
      let status = m.status;
      if (status === 'Killed') {
        const reason = String(m.statusReason);
        status = /AssertionError/.test(reason) && !PROGRAM_ERROR.test(reason) ? 'killed-assert' : 'killed-other';
      } else if (status === 'Survived' && noTests) {
        status = 'NoCoverage';
      }
      by[status] = (by[status] || 0) + 1;
      if (uncoveredSet.has(line)) mutantsOnUncovered++;
      if (status === 'Survived') { lists.survived.push(line); if (!uncoveredSet.has(line)) survivedOnCovered++; }
      if (status === 'NoCoverage') lists.noCoverage.push(line);
      if (status === 'Timeout') lists.timeout.push(line);
      if (status === 'killed-other') lists.killedOther.push(line);
      if (status === 'RuntimeError' || status === 'CompileError') lists.error.push(line);
    }
    const total = mutants.length;
    const covered = total - by.NoCoverage;
    summary[name] = {
      mutants: total, ...by, scoreAll: +(100 * by['killed-assert'] / total).toFixed(1),
      scoreCovered: covered ? +(100 * by['killed-assert'] / covered).toFixed(1) : null,
      lcov: { lines: lineHits.length, uncoveredLines: uncovered.length, linePct: +linePct.toFixed(2), threshold: thr, gate: linePct >= thr ? 'OK' : 'FAIL', branchTotal, branchMissed },
      mutantsOnUncoveredLines: mutantsOnUncovered, survivedOnCoveredLines: survivedOnCovered,
      seconds: time.runSeconds, indexSeconds: time.indexSeconds
    };
    md.push(`## ${name}`, '',
      `- Niepokryte linie (LCOV, ${uncovered.length} z ${lineHits.length}): ${uncovered.length ? ranges(uncovered) : 'brak'}`,
      `- Ocalałe na liniach pokrytych (asercja nie łapie): ${listOrNone(lists.survived)}`,
      `- Bez pokrycia (żaden test nie wykonuje linii): ${listOrNone(lists.noCoverage)}`,
      `- Przekroczenia czasu: ${listOrNone(lists.timeout)}`,
      `- Zabite bez asercji (nie liczone): ${listOrNone(lists.killedOther)}`,
      `- Błędy kompilacji/uruchomienia mutanta: ${listOrNone(lists.error)}`, '');
  }
  const rowsMd = ['| Plik | Mutantów | Zabite z asercją | Zabite bez asercji | Ocalałe | Bez pokrycia | Przekroczenia czasu | Wynik (asercja) | Linie LCOV (próg) | Niepokryte linie |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  const tot = { m: 0, k: 0, ko: 0, sv: 0, nc: 0, to: 0 };
  for (const [f, v] of Object.entries(summary)) {
    tot.m += v.mutants; tot.k += v['killed-assert']; tot.ko += v['killed-other']; tot.sv += v.Survived; tot.nc += v.NoCoverage; tot.to += v.Timeout;
    rowsMd.push(`| ${f} | ${v.mutants} | ${v['killed-assert']} | ${v['killed-other']} | ${v.Survived} | ${v.NoCoverage} | ${v.Timeout} | ${v.scoreAll} % | ${v.lcov.linePct} % (${v.lcov.threshold} %) | ${v.lcov.uncoveredLines} |`);
  }
  rowsMd.push(`| **Razem** | **${tot.m}** | **${tot.k}** | **${tot.ko}** | **${tot.sv}** | **${tot.nc}** | **${tot.to}** | **${(100 * tot.k / tot.m).toFixed(1)} %** |  |  |`);
  fs.writeFileSync(path.join(out, 'TABELA.md'), `${rowsMd.join('\n')}\n`);
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(out, 'LISTY.md'), md.join('\n'));
  log(JSON.stringify(summary, null, 1));
}

if (require.main === module) main(process.argv);
module.exports = { main, lineList, PROGRAM_ERROR };
