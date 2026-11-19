'use strict';

/**
 * #295: adaptery sprawdzacza — czytnik jednej komórki (Sheets API v4), nadawca webhookowy, magazyn stanu
 * na gałęzi gita. Sieć i git są atrapami, a magazyn dodatkowo sprawdzony na prawdziwym gicie w katalogu tymczasowym.
 * Wszystkie identyfikatory i adresy w tym pliku są syntetyczne.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { CELL_PATTERN, ReadError, ReaderConfigError, createSheetsReader } = require('../scripts/freshness-monitor/sheets-reader');
const { SendError, SenderConfigError, createWebhookSender } = require('../scripts/freshness-monitor/webhook-sender');
const { IDENTITY_ENV, StoreError, createGitStore } = require('../scripts/freshness-monitor/git-store');
const { gitExec } = require('../scripts/freshness-monitor/cli');

const FILE_ID = 'SYNTH0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SYNTH_URL = 'https://hooks.example.invalid/synthetic-channel';

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('#295 czytnik jednej komórki (20)', () => {
  const make = (extra = {}, respond = () => jsonResponse(200, { values: [['2026-11-18 09:00:00']] })) => {
    const fetchFn = fakeFetch(respond);
    return { reader: createSheetsReader({ fileId: FILE_ID, range: 'Znacznik!B2', token: 'tok-synth', fetchFn, ...extra }), fetchFn };
  };

  test('prosi o dokładnie jedną skonfigurowaną komórkę, GET z tokenem, bez przekierowań, z limitem czasu', async () => {
    const { reader, fetchFn } = make();
    assert.equal(await reader.read(), '2026-11-18 09:00:00');
    assert.equal(fetchFn.calls.length, 1);
    const { url, init } = fetchFn.calls[0];
    assert.equal(url, `https://sheets.googleapis.com/v4/spreadsheets/${FILE_ID}/values/Znacznik!B2` +
      '?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS');
    assert.equal(init.method, 'GET');
    assert.deepEqual(init.headers, { Authorization: 'Bearer tok-synth', Accept: 'application/json' });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  });

  test('read() nie przyjmuje zakresu: próba odczytu innego zakresu nadal prosi tylko o skonfigurowaną komórkę', async () => {
    const { reader, fetchFn } = make();
    await reader.read('Inna!A1:Z9999');
    assert.equal(fetchFn.calls.length, 1);
    assert.ok(fetchFn.calls[0].url.includes('/values/Znacznik!B2?'));
    assert.ok(!fetchFn.calls[0].url.includes('Inna'));
    assert.equal(reader.read.length, 0);
  });

  test('zakres szerszy niż jedna komórka jest odrzucany przy tworzeniu', () => {
    for (const range of ['A1:B2', 'A:A', 'Arkusz!A1:A2', '1:1', 'A', '', 'Arkusz!A0', "'Nazwa'!A1:B1", 'A1,B2', 'A1\nB2', 'Znacznik!', 5, null, undefined]) {
      assert.throws(() => createSheetsReader({ fileId: FILE_ID, range, token: 't' }),
        err => err instanceof ReaderConfigError && err.message === 'READER_CONFIG_INVALID:range', String(range));
    }
    for (const range of ['A1', 'B2', 'Znacznik!B2', "'Nazwa ze spacją'!B2", '$A$1', 'AAA9999999', 'Arkusz_1.2!C3']) {
      assert.ok(CELL_PATTERN.test(range), range);
      createSheetsReader({ fileId: FILE_ID, range, token: 't' });
    }
  });

  test('identyfikator pliku i token są wymagane i sprawdzane; błąd nazywa pole, nie wartość', () => {
    for (const fileId of ['', 'x', 'a b'.repeat(5), 'id/with/slash0123456789', 5, undefined, FILE_ID + 'x'.repeat(70)]) {
      assert.throws(() => createSheetsReader({ fileId, range: 'A1', token: 't' }),
        err => err instanceof ReaderConfigError && err.message === 'READER_CONFIG_INVALID:fileId', String(fileId));
    }
    for (const token of ['', undefined, null, 5]) {
      assert.throws(() => createSheetsReader({ fileId: FILE_ID, range: 'A1', token }),
        err => err instanceof ReaderConfigError && err.message === 'READER_CONFIG_INVALID:token', String(token));
    }
    createSheetsReader({ fileId: 'ABCDEFGHIJ', range: 'A1', token: 't' });
    createSheetsReader({ fileId: 'A'.repeat(100), range: 'A1', token: 't' });
    assert.throws(() => createSheetsReader({ fileId: 'ABCDEFGHI', range: 'A1', token: 't' }));
    assert.throws(() => createSheetsReader({ fileId: 'A'.repeat(101), range: 'A1', token: 't' }));
  });

  test('pierwsza komórka: pusta odpowiedź, brak wartości i dziwne kształty dają pusty tekst', async () => {
    for (const body of [{}, { values: [] }, { values: [[]] }, { values: 'x' }, { values: [5] }, null, 'tekst', []]) {
      const { reader } = make({}, () => jsonResponse(200, body));
      assert.equal(await reader.read(), '', JSON.stringify(body));
    }
    const { reader } = make({}, () => jsonResponse(200, { values: [['pierwsza', 'druga'], ['trzecia']] }));
    assert.equal(await reader.read(), 'pierwsza');
  });

  test('błąd HTTP to sam kod: komunikat i pola błędu nie niosą adresu ani treści odpowiedzi', async () => {
    const body = { error: { message: `nie wolno: https://sheets.example.invalid/${FILE_ID}`, status: 'PERMISSION_DENIED' } };
    const { reader } = make({}, () => jsonResponse(403, body));
    await assert.rejects(reader.read(), err => {
      assert.ok(err instanceof ReadError);
      assert.equal(err.status, 403);
      assert.equal(err.message, 'HTTP 403');
      assert.ok(!JSON.stringify(Object.getOwnPropertyNames(err).map(k => err[k])).includes(FILE_ID));
      assert.ok(!String(err.stack).includes(FILE_ID));
      return true;
    });
  });

  test('błąd sieci i błąd odczytu ciała to READ_FAILED bez kodu i bez przyczyny z adresem', async () => {
    const network = make({}, () => { throw new Error(`ECONNRESET ${FILE_ID}`); });
    await assert.rejects(network.reader.read(), err => {
      assert.ok(err instanceof ReadError);
      assert.equal(err.message, 'READ_FAILED');
      assert.equal(err.status, undefined);
      assert.ok(!('status' in err));
      assert.equal(err.cause, undefined);
      assert.ok(!String(err.stack).includes(FILE_ID));
      return true;
    });
    const broken = make({}, () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(FILE_ID); } }));
    await assert.rejects(broken.reader.read(), err => err instanceof ReadError && err.message === 'READ_FAILED' && !String(err.stack).includes(FILE_ID));
  });

  test('domyślnie używa globalnego fetch', async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async url => { calls.push(url); return jsonResponse(200, { values: [['x']] }); };
    try {
      const reader = createSheetsReader({ fileId: FILE_ID, range: 'A1', token: 't' });
      assert.equal(await reader.read(), 'x');
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('#295 nadawca webhookowy', () => {
  const message = { messageId: 'zrodlo-1#1', key: 'zrodlo-1#1:ALERT_STALE', kind: 'ALERT_STALE', subject: 'temat', text: 'treść', extra: 'sekret' };

  test('wysyła JSON z kluczem idempotencji i tylko pięcioma polami wiadomości; 2xx potwierdza', async () => {
    for (const status of [200, 201, 204, 299]) {
      const fetchFn = fakeFetch(() => ({ status }));
      const sender = createWebhookSender({ url: SYNTH_URL, fetchFn });
      assert.deepEqual(await sender.send(message), { confirmed: true }, String(status));
      const { url, init } = fetchFn.calls[0];
      assert.equal(url, SYNTH_URL);
      assert.equal(init.method, 'POST');
      assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'Idempotency-Key': 'zrodlo-1#1:ALERT_STALE' });
      assert.deepEqual(JSON.parse(init.body), {
        messageId: 'zrodlo-1#1', key: 'zrodlo-1#1:ALERT_STALE', kind: 'ALERT_STALE', subject: 'temat', text: 'treść'
      });
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
    }
  });

  test('odpowiedź spoza 2xx to błąd z samym kodem; granice 199 i 300 nie potwierdzają', async () => {
    for (const status of [199, 300, 301, 400, 429, 500]) {
      const sender = createWebhookSender({ url: SYNTH_URL, fetchFn: fakeFetch(() => ({ status })) });
      await assert.rejects(sender.send(message), err => err instanceof SendError && err.status === status && err.message === `HTTP ${status}`, String(status));
    }
  });

  test('błąd sieci to SEND_FAILED bez kodu i bez adresu w treści błędu', async () => {
    const sender = createWebhookSender({ url: SYNTH_URL, fetchFn: fakeFetch(() => { throw new Error(`ECONNRESET ${SYNTH_URL}`); }) });
    await assert.rejects(sender.send(message), err => {
      assert.ok(err instanceof SendError);
      assert.equal(err.message, 'SEND_FAILED');
      assert.ok(!('status' in err));
      assert.equal(err.cause, undefined);
      assert.ok(!String(err.stack).includes('example.invalid'));
      return true;
    });
  });

  test('adres musi być https; błąd nie ujawnia wartości', () => {
    for (const url of ['http://hooks.example.invalid/x', 'ftp://x', 'nie adres', '', undefined, null, 5]) {
      assert.throws(() => createWebhookSender({ url }), err => err instanceof SenderConfigError && err.message === 'SENDER_CONFIG_INVALID:url', String(url));
    }
  });

  test('domyślnie używa globalnego fetch', async () => {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async url => { calls.push(url); return { status: 200 }; };
    try {
      assert.deepEqual(await createWebhookSender({ url: SYNTH_URL }).send(message), { confirmed: true });
      assert.deepEqual(calls, [SYNTH_URL]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/** Wykonawca z nagraniem wywołań i skryptem odpowiedzi. */
function scriptedExec(replies) {
  const calls = [];
  const exec = async (args, options) => {
    calls.push({ args, options });
    const reply = replies.shift();
    if (!reply) throw new Error('nieoczekiwane wywołanie gita: ' + args.join(' '));
    return { status: 0, stdout: '', stderr: '', ...reply };
  };
  exec.calls = calls;
  return exec;
}

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);

describe('#295 magazyn stanu: gałąź gita (atrapa wykonawcy)', () => {
  test('read: brak gałęzi (ls-remote 2) to brak stanu', async () => {
    const exec = scriptedExec([{ status: 2 }]);
    assert.deepEqual(await createGitStore({ exec }).read(), { text: null, version: null });
    assert.deepEqual(exec.calls.map(c => c.args), [['ls-remote', '--exit-code', '--heads', 'origin', 'monitor-state']]);
  });

  test('read: pobiera gałąź, ustala wersję z FETCH_HEAD i czyta plik z tego commitu', async () => {
    const exec = scriptedExec([{}, {}, { stdout: SHA + '\n' }, { stdout: '{"sources":{}}\n' }]);
    assert.deepEqual(await createGitStore({ exec, remote: 'zdalne', branch: 'gałąź', file: 'plik.json' }).read(), { text: '{"sources":{}}\n', version: SHA });
    assert.deepEqual(exec.calls.map(c => c.args), [
      ['ls-remote', '--exit-code', '--heads', 'zdalne', 'gałąź'],
      ['fetch', '--quiet', '--no-tags', 'zdalne', 'gałąź'],
      ['rev-parse', 'FETCH_HEAD'],
      ['show', `${SHA}:plik.json`]
    ]);
  });

  test('read: każdy nieudany krok to StoreError ze stałym kodem (bez wyjścia gita)', async () => {
    const cases = [
      [[{ status: 128, stderr: 'fatal: https://x.example.invalid' }], 'GIT_LS_REMOTE_FAILED'],
      [[{}, { status: 1, stderr: 'https://x.example.invalid' }], 'GIT_FETCH_FAILED'],
      [[{}, {}, { status: 1 }], 'GIT_REV_PARSE_FAILED'],
      [[{}, {}, { stdout: 'nie-sha' }], 'GIT_REV_PARSE_FAILED'],
      [[{}, {}, { stdout: SHA }, { status: 128, stderr: 'https://x.example.invalid' }], 'GIT_SHOW_FAILED']
    ];
    for (const [replies, code] of cases) {
      await assert.rejects(createGitStore({ exec: scriptedExec(replies) }).read(), err => {
        assert.ok(err instanceof StoreError);
        assert.equal(err.code, code);
        assert.equal(err.message, code);
        return true;
      }, code);
    }
  });

  test('write: blob, drzewo i commit na wersji z odczytu, wypchnięcie bez siły; tożsamość tylko przy commit-tree', async () => {
    const exec = scriptedExec([{ stdout: SHA + '\n' }, { stdout: SHA2 + '\n' }, { stdout: SHA3 + '\n' }, {}]);
    const out = await createGitStore({ exec }).write('treść\n', SHA);
    assert.deepEqual(out, { ok: true, version: SHA3 });
    assert.deepEqual(exec.calls.map(c => c.args), [
      ['hash-object', '-w', '--stdin'],
      ['mktree'],
      ['commit-tree', SHA2, '-p', SHA, '-m', 'monitor: stan sprawdzacza'],
      ['push', '--quiet', 'origin', `${SHA3}:refs/heads/monitor-state`]
    ]);
    assert.deepEqual(exec.calls[0].options, { input: 'treść\n' });
    assert.deepEqual(exec.calls[1].options, { input: `100644 blob ${SHA}\tstate.json\n` });
    assert.deepEqual(exec.calls[2].options, { env: IDENTITY_ENV });
    assert.equal(exec.calls[3].options, undefined);
    assert.ok(!exec.calls[3].args.includes('--force'));
  });

  test('write: pierwszy zapis (brak wersji) tworzy sierocy commit bez rodzica', async () => {
    const exec = scriptedExec([{ stdout: SHA }, { stdout: SHA2 }, { stdout: SHA3 }, {}]);
    await createGitStore({ exec, file: 'plik.json', branch: 'gałąź', remote: 'zdalne' }).write('x', null);
    assert.deepEqual(exec.calls[2].args, ['commit-tree', SHA2, '-m', 'monitor: stan sprawdzacza']);
    assert.deepEqual(exec.calls[1].options, { input: `100644 blob ${SHA}\tplik.json\n` });
    assert.deepEqual(exec.calls[3].args, ['push', '--quiet', 'zdalne', `${SHA3}:refs/heads/gałąź`]);
  });

  test('write: odrzucenie non-fast-forward i fetch first to konflikt, inne odrzucenia to błąd', async () => {
    for (const stderr of [' ! [rejected]        x -> monitor-state (non-fast-forward)', ' ! [rejected]  x -> monitor-state (fetch first)']) {
      const exec = scriptedExec([{ stdout: SHA }, { stdout: SHA2 }, { stdout: SHA3 }, { status: 1, stderr }]);
      assert.deepEqual(await createGitStore({ exec }).write('x', SHA), { ok: false, conflict: true });
    }
    for (const stderr of [' ! [remote rejected] x -> monitor-state (protected branch hook declined)', 'fatal: Authentication failed for https://x.example.invalid', 'rejected']) {
      const exec = scriptedExec([{ stdout: SHA }, { stdout: SHA2 }, { stdout: SHA3 }, { status: 1, stderr }]);
      await assert.rejects(createGitStore({ exec }).write('x', SHA), err => err instanceof StoreError && err.code === 'GIT_PUSH_FAILED' && !err.message.includes('example'));
    }
  });

  test('write: nieudane kroki pośrednie to StoreError ze stałym kodem i bez wypchnięcia', async () => {
    const cases = [
      [[{ status: 1 }], 'GIT_HASH_OBJECT_FAILED'],
      [[{ stdout: SHA }, { status: 1 }], 'GIT_MKTREE_FAILED'],
      [[{ stdout: SHA }, { stdout: SHA2 }, { status: 1 }], 'GIT_COMMIT_TREE_FAILED']
    ];
    for (const [replies, code] of cases) {
      const exec = scriptedExec(replies);
      await assert.rejects(createGitStore({ exec }).write('x', SHA), err => err instanceof StoreError && err.code === code, code);
      assert.ok(exec.calls.every(c => c.args[0] !== 'push'));
    }
  });

  test('tożsamość commitów to neutralna etykieta bez prawdziwego adresu', () => {
    assert.deepEqual(Object.keys(IDENTITY_ENV).sort(), ['GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME']);
    assert.ok(Object.values(IDENTITY_ENV).every(v => v.startsWith('freshness-monitor')));
    assert.ok(IDENTITY_ENV.GIT_AUTHOR_EMAIL.endsWith('@localhost'));
  });
});

describe('#295 wykonawca gita', () => {
  test('gitExec: status null (zabity proces) to 1, a wyjścia bez tekstu to puste napisy; środowisko i katalog są przekazywane', async () => {
    const seen = [];
    const spawn = (command, args, options) => { seen.push({ command, args, options }); return { status: null }; };
    const out = await gitExec('katalog', spawn)(['status'], { input: 'in', env: { X_SYNTH: '1' } });
    assert.deepEqual(out, { status: 1, stdout: '', stderr: '' });
    assert.equal(seen[0].command, 'git');
    assert.deepEqual(seen[0].args, ['status']);
    assert.equal(seen[0].options.cwd, 'katalog');
    assert.equal(seen[0].options.input, 'in');
    assert.equal(seen[0].options.env.X_SYNTH, '1');
    assert.equal(seen[0].options.encoding, 'utf8');
    const ok = await gitExec('katalog', () => ({ status: 0, stdout: 'o', stderr: 'e' }))(['x']);
    assert.deepEqual(ok, { status: 0, stdout: 'o', stderr: 'e' });
  });
});
