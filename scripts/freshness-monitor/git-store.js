'use strict';

/**
 * Magazyn stanu (#295): jeden plik JSON na osobnej, sierocej gałęzi `monitor-state` w prywatnym
 * repozytorium instalacji.
 *
 * - trwałość: gałąź nie wygasa jak artefakt i nie jest wypychana jak cache;
 * - spójność: zapis to commit na wersji (SHA) z odczytu, wypchnięty BEZ siły; odrzucenie jako
 *   non-fast-forward to konflikt (inny przebieg był pierwszy), a nie błąd;
 * - audytowalność: historia gałęzi jest dziennikiem zdarzeń alarmowych.
 *
 * Commit powstaje poleceniami niskiego poziomu (`hash-object`, `mktree`, `commit-tree`), bez przełączania
 * gałęzi i bez dotykania katalogu roboczego. Błędy niosą stały kod: wyjście gita może zawierać adresy.
 */

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'freshness-monitor',
  GIT_AUTHOR_EMAIL: 'freshness-monitor@localhost',
  GIT_COMMITTER_NAME: 'freshness-monitor',
  GIT_COMMITTER_EMAIL: 'freshness-monitor@localhost'
};

const SHA_PATTERN = /^[0-9a-f]{40}$/;
/** Odrzucenie wypchnięcia z powodu konfliktu wersji; inne odrzucenia (np. ochrona gałęzi) to błąd. */
const CONFLICT_PATTERN = /\((?:non-fast-forward|fetch first)\)/;

class StoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'StoreError';
    this.code = code;
  }
}

async function git(exec, args, options, code) {
  const out = await exec(args, options);
  if (out.status !== 0) throw new StoreError(code);
  return out.stdout.trim();
}

/**
 * @param {{exec: function(string[], {input?: string, env?: object}): Promise<{status: number, stdout: string, stderr: string}>,
 *   branch?: string, file?: string, remote?: string}} options
 */
function createGitStore({ exec, branch = 'monitor-state', file = 'state.json', remote = 'origin' }) {
  return {
    /** @return {Promise<{text: (string|null), version: (string|null)}>} brak gałęzi to brak stanu (null, null) */
    async read() {
      const listing = await exec(['ls-remote', '--exit-code', '--heads', remote, branch]);
      if (listing.status === 2) return { text: null, version: null };
      if (listing.status !== 0) throw new StoreError('GIT_LS_REMOTE_FAILED');
      await git(exec, ['fetch', '--quiet', '--no-tags', remote, branch], undefined, 'GIT_FETCH_FAILED');
      const version = await git(exec, ['rev-parse', 'FETCH_HEAD'], undefined, 'GIT_REV_PARSE_FAILED');
      if (!SHA_PATTERN.test(version)) throw new StoreError('GIT_REV_PARSE_FAILED');
      const shown = await exec(['show', `${version}:${file}`]);
      if (shown.status !== 0) throw new StoreError('GIT_SHOW_FAILED');
      return { text: shown.stdout, version };
    },

    /** @return {Promise<{ok: boolean, version?: string, conflict?: boolean}>} */
    async write(text, version) {
      const blob = await git(exec, ['hash-object', '-w', '--stdin'], { input: text }, 'GIT_HASH_OBJECT_FAILED');
      const tree = await git(exec, ['mktree'], { input: `100644 blob ${blob}\t${file}\n` }, 'GIT_MKTREE_FAILED');
      const parent = version === null ? [] : ['-p', version];
      const commit = await git(exec, ['commit-tree', tree, ...parent, '-m', 'monitor: stan sprawdzacza'],
        { env: IDENTITY_ENV }, 'GIT_COMMIT_TREE_FAILED');
      const pushed = await exec(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`]);
      if (pushed.status === 0) return { ok: true, version: commit };
      if (CONFLICT_PATTERN.test(pushed.stderr)) return { ok: false, conflict: true };
      throw new StoreError('GIT_PUSH_FAILED');
    }
  };
}

module.exports = { IDENTITY_ENV, StoreError, createGitStore };
