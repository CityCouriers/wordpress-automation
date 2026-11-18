'use strict';

/**
 * Testy, które uruchamiają prawdziwego gita w katalogach tymczasowych, nie mogą dziedziczyć zmiennych `GIT_*`
 * po procesie, który je uruchomił (hook pre-commit ustawia m.in. `GIT_INDEX_FILE`, a w drzewie roboczym także
 * `GIT_DIR`): `git init --bare` albo `git add` w katalogu tymczasowym pisałby wtedy do prawdziwego repozytorium.
 * Każdy plik testowy działa w osobnym procesie, więc usunięcie zmiennych z `process.env` nie wycieka na inne testy.
 */
function stripGitEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

module.exports = { stripGitEnv };
