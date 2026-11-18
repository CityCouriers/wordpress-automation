'use strict';

/**
 * Minimalny serwer udający API GitHub Deployments (i `releases/latest`) na
 * 127.0.0.1, do testów rekordu wdrożenia (#297). Daje prawdziwy HTTP, więc test
 * sprawdza faktyczne żądania (ścieżka, nagłówki, treść), a nie atrapę funkcji.
 *
 * Opcje:
 *   order: 'desc' (domyślnie, jak GitHub) | 'asc' | 'shuffled' - kolejność list
 *   ignoreEnvFilter: true - lista deploymentów ignoruje parametr environment (jak źle zachowujące się API)
 *   failOn: { 'POST /deployments': 500 } - wymuszony kod odpowiedzi dla trasy
 */

const http = require('node:http');

const OWNER_REPO = 'acme/repo';

function ordered(items, order) {
  const copy = items.slice().sort((a, b) => b.id - a.id);
  if (order === 'asc') return copy.reverse();
  if (order === 'shuffled') return copy.slice(1).concat(copy.slice(0, 1)).reverse();
  return copy;
}

async function startFakeGithub(options = {}) {
  const state = {
    deployments: [],
    requests: [],
    release: options.release === undefined ? { tag_name: 'v1.0.0' } : options.release,
    nextId: 1000,
    nextStatusId: 5000
  };
  const failOn = options.failOn || {};
  const order = options.order || 'desc';

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const body = raw ? JSON.parse(raw) : undefined;
      const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
      state.requests.push(entry);
      const send = (code, data) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      const prefix = `/repos/${OWNER_REPO}`;
      if (req.headers.authorization !== 'Bearer test-token') return send(401, { message: 'Bad credentials' });
      if (!url.pathname.startsWith(prefix)) return send(404, { message: 'Not Found' });
      const route = url.pathname.slice(prefix.length);
      const forced = failOn[`${req.method} ${route.replace(/\/[0-9]+/g, '/:id')}`];
      if (forced) return send(forced, { message: 'wymuszony błąd' });

      if (req.method === 'POST' && route === '/deployments') {
        const d = {
          id: state.nextId++,
          ref: body.ref,
          sha: /^[0-9a-f]{40}$/.test(body.ref) ? body.ref : 'f'.repeat(40),
          environment: body.environment,
          payload: body.payload,
          description: body.description,
          statuses: []
        };
        state.deployments.push(d);
        return send(201, { id: d.id, ref: d.ref, sha: d.sha, environment: d.environment, payload: d.payload });
      }
      let m = route.match(/^\/deployments\/([0-9]+)\/statuses$/);
      if (m) {
        const d = state.deployments.find(x => x.id === Number(m[1]));
        if (!d) return send(404, { message: 'Not Found' });
        if (req.method === 'POST') {
          const s = { id: state.nextStatusId++, state: body.state, description: body.description, environment: body.environment };
          d.statuses.push(s);
          return send(201, s);
        }
        return send(200, ordered(d.statuses, order).slice(0, Number(url.searchParams.get('per_page') || 30)));
      }
      if (req.method === 'GET' && route === '/deployments') {
        const env = url.searchParams.get('environment');
        const list = state.deployments.filter(d => options.ignoreEnvFilter || !env || d.environment === env);
        return send(200, ordered(list, order).slice(0, Number(url.searchParams.get('per_page') || 30)).map(d => ({ id: d.id, ref: d.ref, sha: d.sha, environment: d.environment, payload: d.payload })));
      }
      if (req.method === 'GET' && route === '/releases/latest') {
        return state.release ? send(200, state.release) : send(404, { message: 'Not Found' });
      }
      return send(404, { message: 'Not Found' });
    });
  });

  // Bez utrzymywania połączeń: testy blokują pętlę zdarzeń (git przez spawnSync), a utrzymane gniazdo bywało zrywane.
  server.keepAliveTimeout = 1;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ctx = { apiUrl: `http://127.0.0.1:${server.address().port}`, repo: OWNER_REPO, token: 'test-token' };
  const env = { GITHUB_API_URL: ctx.apiUrl, GITHUB_REPOSITORY: OWNER_REPO, GH_TOKEN: 'test-token' };

  /** Dopisuje rekord bez udziału kodu testowanego (zasiew stanu). */
  function seed({ ref, tag, environment = 'apps-script-live', statuses = ['in_progress', 'success'], sha = ref }) {
    const d = { id: state.nextId++, ref, sha, environment, payload: tag === undefined ? undefined : { tag }, statuses: [] };
    for (const st of statuses) d.statuses.push({ id: state.nextStatusId++, state: st });
    state.deployments.push(d);
    return d;
  }

  return { ctx, env, state, seed, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

module.exports = { startFakeGithub, OWNER_REPO };
