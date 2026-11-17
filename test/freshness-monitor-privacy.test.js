'use strict';

/**
 * #295: prywatność (przypadki 18–21 specyfikacji) i kalibracja progu.
 * Repo jest publiczne: sprawdzacz nie może wypuścić ani zapisać niczego poza polami z listy dozwolonych.
 * Wszystkie „dane osobowe”, identyfikatory i adresy w tym pliku są syntetyczne (domena `.invalid`).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { at } = require('./helpers/zone');
const {
  CONFIG_RAW, LEAKY_MESSAGE, NOW, OK_MARKER, STALE_MARKER,
  createDeps, createReader, createSender, createStore, leakyError, makeConfig, notifiedState, run
} = require('./helpers/monitor-fakes');
const { createSheetsReader } = require('../scripts/freshness-monitor/sheets-reader');
const { createWebhookSender } = require('../scripts/freshness-monitor/webhook-sender');
const { runCheck } = require('../scripts/freshness-monitor/monitor');
const { STATE_FIELDS } = require('../scripts/freshness-monitor/state');
const { calibrateThreshold } = require('../scripts/freshness-monitor/calibration');
const { normalizeConfig } = require('../scripts/freshness-monitor/config');

const FILE_ID = 'SYNTH0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PERSONAL = ['jan.kowalski@example.invalid', 'Kowalski', '+48 600 100 200', 'ul. Przykładowa 1', 'zlecenie-777'];
const FORBIDDEN = [FILE_ID, 'example.invalid', 'googleapis', 'spreadsheets', ...PERSONAL, 'Bearer', 'tok-synth'];

/** Wszystko, co przebieg wypuszcza na zewnątrz albo zapisuje: wiadomości, log, stan, wynik, teksty wyjątków. */
function everythingOf({ deps, result, store }) {
  return JSON.stringify({
    messages: deps.sender.sent, lines: deps.lines, state: store.commits.concat(store.text || ''), result: result.problems
  });
}

function assertClean(text, label) {
  for (const fragment of FORBIDDEN) assert.ok(!text.includes(fragment), `${label}: wyciekło „${fragment}”`);
  assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/, `${label}: wygląda jak adres e-mail`);
  assert.doesNotMatch(text, /https?:\/\//, `${label}: wygląda jak adres URL`);
}

describe('#295 prywatność: nic poza polami z listy dozwolonych (18)', () => {
  test('18: czytnik zwraca dodatkowe kolumny z danymi osobowymi i identyfikatorem pliku — ani log, ani wiadomość, ani stan, ani wynik ich nie zawierają', async () => {
    const wideRow = [[STALE_MARKER, 'jan.kowalski@example.invalid', 'Kowalski', '+48 600 100 200', `https://x.example.invalid/${FILE_ID}`, 'zlecenie-777']];
    for (const [value, store] of [[wideRow, createStore(notifiedState('OK'))], [wideRow.map(r => r.slice(1)), createStore(notifiedState('OK'))]]) {
      const outcome = await run({ store, reader: createReader(value) });
      assert.equal(outcome.deps.sender.sent.length, 1);
      assertClean(everythingOf({ ...outcome, store }), 'ALERT');
    }
    const recovery = await run({ store: createStore(notifiedState('ALERT_STALE')), reader: createReader([[OK_MARKER, ...PERSONAL, FILE_ID]]) });
    assertClean(everythingOf({ ...recovery, store: recovery.deps.store }), 'RECOVERY');
  });

  test('18: wyjątek czytnika, nadawcy i magazynu z komunikatem pełnym wycieków nie trafia do logu, wiadomości, stanu ani wyniku', async () => {
    const failingStore = createStore(notifiedState('OK'));
    failingStore.failNextWrites = 1;
    const outcome = await run({
      store: failingStore, reader: createReader(leakyError(403), leakyError(403)), sender: createSender(['throw'])
    });
    assert.deepEqual(outcome.result.problems.sort(), ['SEND_FAILED', 'STATE_WRITE_FAILED']);
    assertClean(everythingOf({ ...outcome, store: failingStore }), 'wyjątki');
    assert.ok(LEAKY_MESSAGE.includes('example.invalid'), 'sama atrapa musi zawierać to, czego szukamy');
    const stateFail = createStore(notifiedState('OK'));
    stateFail.failReads = true;
    assertClean(everythingOf({ ...(await run({ store: stateFail })), store: stateFail }), 'odczyt stanu');
  });

  test('18: błąd HTTP z czytnika i z nadawcy (komunikat zawiera adres z identyfikatorem) trafia do wiadomości i logu jako sam kod', async () => {
    const fetchRead = async () => ({ ok: false, status: 403, json: async () => ({ error: `https://sheets.example.invalid/${FILE_ID}` }) });
    const fetchSend = async () => ({ status: 502 });
    const reader = createSheetsReader({ fileId: FILE_ID, range: 'A1', token: 'tok-synth', fetchFn: fetchRead });
    const sender = createWebhookSender({ url: 'https://hooks.example.invalid/synthetic-channel', fetchFn: fetchSend });
    const store = createStore(notifiedState('OK'));
    const deps = createDeps({ store, reader, sender: { sent: [], async send(m) { deps.sender.sent.push(m); return sender.send(m); } }, sleep: async () => {} });
    const result = await runCheck(deps);
    assert.deepEqual(result.problems, ['SEND_FAILED']);
    assert.match(deps.sender.sent[0].text, /odczyt znacznika nie powiódł się \(kod HTTP 403\)/);
    assert.ok(deps.lines.some(line => line.endsWith('potwierdzona=nie kod_http=502')));
    assertClean(JSON.stringify({ sent: deps.sender.sent, lines: deps.lines, commits: store.commits }), 'HTTP');
  });

  test('18: tekst błędu z kodem w postaci tekstu (adres) nie zostaje kodem HTTP', async () => {
    const error = new Error('x');
    error.status = `https://sheets.example.invalid/${FILE_ID}`;
    const outcome = await run({ reader: createReader(error, error), sender: createSender(['throw']) });
    assertClean(everythingOf({ ...outcome, store: outcome.deps.store }), 'kod tekstowy');
    assert.equal(outcome.result.assessment.httpStatus, null);
  });

  test('20: sprawdzacz nie czyta niczego poza skonfigurowaną komórką — przebieg to dokładnie jedno żądanie o jedną komórkę', async () => {
    const requested = [];
    const fetchFn = async url => { requested.push(url); return { ok: true, status: 200, json: async () => ({ values: [[OK_MARKER]] }) }; };
    const reader = createSheetsReader({ fileId: FILE_ID, range: 'Znacznik!B2', token: 'tok-synth', fetchFn });
    await run({ reader });
    assert.equal(requested.length, 1);
    assert.ok(requested[0].includes('/values/Znacznik!B2?'));
    assert.throws(() => createSheetsReader({ fileId: FILE_ID, range: 'Znacznik!A1:Z9999', token: 't', fetchFn }));
  });

  test('21: plik stanu po serii przebiegów (przejścia, awarie, konflikt, przypomnienie, odroczenie) zawiera wyłącznie pola ze schematu i żadnej wartości ze źródła', async () => {
    const store = createStore(null);
    const sender = createSender(['ok', 'unconfirmed', 'ok']);
    const secretMarker = '2026-11-17 08:00:00';
    const steps = [
      { reader: createReader(OK_MARKER), clock: () => at('2026-11-18 09:00:00') },
      { reader: createReader([[secretMarker, ...PERSONAL]]), clock: () => at('2026-11-18 10:00:00') },
      { reader: createReader(secretMarker), clock: () => at('2026-11-18 10:30:00') },
      { reader: createReader(leakyError(403), leakyError(403)), clock: () => at('2026-11-18 11:00:00') },
      { reader: createReader(OK_MARKER), clock: () => at('2026-11-18 12:00:00') },
      { reader: createReader(secretMarker), clock: () => at('2026-11-22 03:00:00') }
    ];
    for (const step of steps) await runCheck(createDeps({ store, sender, ...step }));
    store.beforeWrite = async call => { if (call === 1) store.external({ lastObservedAt: '2026-11-22T02:00:00.000Z' }); };
    await runCheck(createDeps({ store, sender, reader: createReader(secretMarker), clock: () => at('2026-11-23 10:00:00') }));
    assert.ok(store.commits.length >= 6);
    for (const text of store.commits) {
      const doc = JSON.parse(text);
      assert.deepEqual(Object.keys(doc), ['sources']);
      assert.deepEqual(Object.keys(doc.sources), ['zrodlo-1']);
      assert.deepEqual(Object.keys(doc.sources['zrodlo-1']), STATE_FIELDS);
      assertClean(text, 'stan');
      assert.ok(!text.includes(secretMarker), 'stan nie zawiera znacznika źródła');
      assert.ok(!text.includes('godz'), 'stan nie zawiera treści wiadomości');
    }
  });

  test('21: lista dozwolonych pól to dokładnie dziewięć pól ze specyfikacji', () => {
    assert.deepEqual(STATE_FIELDS, ['lastObservedState', 'lastObservedAt', 'lastNotifiedState', 'lastNotifiedAt', 'lastNotifiedKey',
      'messageSeq', 'eventId', 'undeliveredSince', 'lastSuccessfulCheckAt']);
  });

  test('wiadomości zawierają tylko pola z listy: etykieta, stan, wiek w pełnych godzinach, próg, chwilę przebiegu i eventId', async () => {
    const outcomes = [
      await run({ reader: createReader(STALE_MARKER) }),
      await run({ reader: createReader(leakyError(403), leakyError(403)) }),
      await run({ store: createStore(notifiedState('ALERT_STALE')) }),
      await run({ reader: createReader('2026-11-10 10:00:00'), clock: () => at('2026-11-22 03:00:00') })
    ];
    for (const { deps } of outcomes) {
      const message = deps.sender.sent[0];
      assert.deepEqual(Object.keys(message).sort(), ['key', 'kind', 'messageId', 'subject', 'text']);
      // Po zdjęciu znanych pól zostaje tylko słownictwo stałe, liczby i etykieta.
      assertClean(message.subject + message.text, message.kind);
      assert.doesNotMatch(message.text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?!\.\d{3}Z)/, 'nie wypisuje znacznika źródła');
    }
    assert.ok(NOW instanceof Date);
  });
});

describe('#295 prywatność: statyczny skan plików dostarczanych w repo (19)', () => {
  const ROOT = path.resolve(__dirname, '..');
  const DELIVERED = [
    ...fs.readdirSync(path.join(ROOT, 'scripts', 'freshness-monitor')).map(f => path.join('scripts', 'freshness-monitor', f)),
    'docs/freshness-monitor.md',
    'docs/freshness-monitor/workflow.template.yml'
  ];
  /** Publiczne punkty końcowe i strony produktu; adres instalacji nie jest na tej liście i nie może być. */
  const ALLOWED_URL_HOSTS = ['sheets.googleapis.com', 'github.com'];

  test('lista plików dostarczanych jest niepusta i obejmuje kod, dokumentację i szablon', () => {
    assert.ok(DELIVERED.length >= 12);
    assert.ok(DELIVERED.includes('docs/freshness-monitor.md'));
    for (const file of DELIVERED) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  });

  test('brak ciągów wyglądających jak identyfikator pliku Google, adres e-mail albo adres URL instalacji', () => {
    for (const file of DELIVERED) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const ids = (text.match(/[A-Za-z0-9_-]{25,}/g) || [])
        .filter(token => /\d/.test(token) && /[A-Za-z]/.test(token) && !/^[0-9a-f]{40}$/.test(token));
      assert.deepEqual(ids, [], `${file}: ciąg jak identyfikator pliku`);
      assert.deepEqual(text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [], [], `${file}: adres e-mail`);
      const hosts = (text.match(/https?:\/\/[^\s/'")`>]+/g) || []).map(url => url.replace(/^https?:\/\//, ''));
      assert.deepEqual(hosts.filter(host => !ALLOWED_URL_HOSTS.includes(host)), [], `${file}: adres URL spoza listy`);
    }
  });

  test('skan sam umie paść: wykrywa identyfikator, e-mail i obcy adres w podsuniętym tekście', () => {
    const bad = `id ${FILE_ID} mail a@b.example url https://moja.example.invalid/x`;
    assert.ok((bad.match(/[A-Za-z0-9_-]{25,}/g) || []).some(t => /\d/.test(t) && /[A-Za-z]/.test(t)));
    assert.ok((bad.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).length === 1);
    assert.ok((bad.match(/https?:\/\/[^\s/'")`>]+/g) || []).length === 1);
  });

  test('dokumentacja i szablon nie ujawniają tożsamości instalacji (prefiks pól REST i nazwy domen)', () => {
    for (const file of DELIVERED) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.doesNotMatch(text, /(?:^|[^A-Za-z0-9])cc[_-][a-z]/i, file);
    }
  });
});

describe('#295 kalibracja progu', () => {
  const config = normalizeConfig(CONFIG_RAW);
  const stamps = [
    '2026-11-02 09:00:00', '2026-11-02 10:30:00', '2026-11-02 16:00:00', // przerwy 1,5 h i 5,5 h
    '2026-11-03 09:00:00', // z poprzedniego dnia: 16:00→18:00 = 2 h + 09:00-08:00 = 1 h = 3 h
    '2026-11-06 17:00:00', // 3 dni robocze (Wt, Śr, Cz = 2+... ) liczone w godzinach okna
    '2026-11-09 09:00:00' // piątek 17:00 → poniedziałek 09:00 = 1 h + 1 h = 2 h
  ];
  const now = at('2026-11-10 10:00:00');

  test('najdłuższa przerwa w godzinach pracy i próg ×1,5 zaokrąglony w górę do pełnej godziny', () => {
    const out = calibrateThreshold({ stamps, now, config });
    // 03.11 09:00 → 06.11 17:00: wt 9 h (09–18) + śr 10 + czw 10 + pt 9 (08–17) = 38 h pracy.
    assert.equal(out.samples, 6);
    assert.equal(out.longestGapHours, 38);
    assert.equal(out.recommendedThresholdHours, 57);
  });

  test('współczynnik i okno miesięcy są parametrami, a zaokrąglenie idzie w górę', () => {
    const out = calibrateThreshold({ stamps: ['2026-11-02 09:00:00', '2026-11-02 10:30:00'], now, config, factor: 2 });
    assert.deepEqual([out.longestGapHours, out.recommendedThresholdHours], [1.5, 3]);
    const odd = calibrateThreshold({ stamps: ['2026-11-02 09:00:00', '2026-11-02 10:20:00'], now, config });
    assert.equal(odd.recommendedThresholdHours, 2);
    const half = calibrateThreshold({ stamps: ['2026-11-02 09:00:00', '2026-11-02 10:00:00'], now, config });
    assert.deepEqual([half.longestGapHours, half.recommendedThresholdHours], [1, 2]);
  });

  test('tylko ostatnie 3 miesiące: starsze i przyszłe znaczniki oraz śmieci są pomijane', () => {
    const out = calibrateThreshold({
      stamps: ['2026-07-01 09:00:00', '2026-08-10 09:59:59', '2026-08-10 10:00:00', '2026-08-10 11:00:00', '2026-11-10 10:00:01', 'x', '', null, 5],
      now, config
    });
    assert.equal(out.samples, 2, 'granica 10.08 10:00 jest włącznie, wcześniejsze odpadają');
    assert.equal(out.longestGapHours, 1);
    const custom = calibrateThreshold({ stamps: ['2026-10-01 09:00:00', '2026-10-01 10:00:00', '2026-11-02 09:00:00'], now, config, months: 1 });
    assert.equal(custom.samples, 1);
  });

  test('znaczniki mogą być datami, kolejność wejścia nie ma znaczenia, za mało znaczników to brak wyniku', () => {
    const shuffled = calibrateThreshold({ stamps: [at('2026-11-02 10:30:00'), at('2026-11-02 09:00:00')], now, config });
    assert.equal(shuffled.longestGapHours, 1.5);
    for (const list of [[], ['2026-11-02 09:00:00']]) {
      assert.deepEqual(calibrateThreshold({ stamps: list, now, config }), { samples: list.length, longestGapHours: null, recommendedThresholdHours: null });
    }
  });

  test('święta z konfiguracji skracają przerwy, a wynik jest zgodny z progiem używanym w ocenie', () => {
    const holidayConfig = makeConfig({ holidays: ['2026-11-03'] });
    const out = calibrateThreshold({ stamps: ['2026-11-02 16:00:00', '2026-11-04 09:00:00'], now, config: holidayConfig });
    assert.equal(out.longestGapHours, 3);
  });
});
