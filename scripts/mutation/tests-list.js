'use strict';

// Lista plików testów dla mutacji .gs: wszystkie test/*.test.js poza testami, które skanują samo
// repozytorium (git ls-files, wordpress/, .git) i poza testami samego potoku mutacji (test/mutation-*.test.js).
// W kopii roboczej Strykera pierwsze nie mają czego skanować i padają niezależnie od mutacji; drugie sprawdzają
// narzędzia i granicę izolacji (np. odmowę na maszynie bez izolatora), więc w kontenerze z izolacją nie mają
// racji bytu, a nie oceniają kodu src/*.gs. Jedno źródło listy dla run-tests.js, coverage-map.js i run-file.js.
const fs = require('node:fs');
const path = require('node:path');

const SKIP = new Set(['repo-identity.test.js', 'source-control-chars.test.js']);
const PIPELINE_TEST = /^mutation-.+\.test\.js$/;

/** Czy plik testu nie bierze udziału w ocenie mutantów src/*.gs. */
function isExcluded(name) {
  return SKIP.has(name) || PIPELINE_TEST.test(name);
}

/** Nazwy plików testów z katalogu `test/` pod `root`, posortowane, bez SKIP. */
function listTests(root) {
  return fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.js') && !isExcluded(f)).sort();
}

module.exports = { SKIP, isExcluded, listTests };
