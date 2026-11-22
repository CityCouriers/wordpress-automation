'use strict';

// Korzeń repozytorium: dwa katalogi nad scripts/mutation. Jedno miejsce zamiast stałej w każdym narzędziu.
const path = require('node:path');

module.exports = path.resolve(__dirname, '..', '..');
