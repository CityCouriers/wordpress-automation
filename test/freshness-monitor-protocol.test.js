'use strict';

/**
 * #295: stan i dostarczanie wiadomości (przypadki 10–17 specyfikacji z wariantami 12a–e i 14a–c).
 * Kontrakt: co najmniej raz. Wszystkie dane syntetyczne, magazyn i nadawca to atrapy z `helpers/monitor-fakes.js`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { at } = require('./helpers/zone');
const {
  LABEL, NOW, OK_MARKER, STALE_MARKER,
  barrier, createDeps, createReader, createSender, createStore, leakyError, makeConfig, notifiedState, run
} = require('./helpers/monitor-fakes');
const { runCheck } = require('../scripts/freshness-monitor/monitor');
const { initialSourceState } = require('../scripts/freshness-monitor/state');

const FAILING_READ = [leakyError(403), leakyError(403)];

/** Czytnik dla oczekiwanej oceny: OK, ALERT_STALE albo ALERT_ERROR (dwa nieudane odczyty). */
function readerFor(level) {
  if (level === 'OK') return createReader(OK_MARKER);
  if (level === 'ALERT_STALE') return createReader(STALE_MARKER);
  return createReader(...FAILING_READ);
}

describe('#295 stan i protokół: przejścia (10)', () => {
  const table = [
    ['OK', 'ALERT_STALE', 'ALERT_STALE'],
    ['ALERT_STALE', 'OK', 'RECOVERY'],
    ['OK', 'ALERT_ERROR', 'ALERT_ERROR'],
    ['ALERT_ERROR', 'OK', 'RECOVERY'],
    ['ALERT_ERROR', 'ALERT_STALE', 'ALERT_STALE'],
    ['ALERT_STALE', 'ALERT_ERROR', 'ALERT_ERROR']
  ];
  for (const [from, to, kind] of table) {
    test(`10: ${from} → ${to}: dokładnie jedna wiadomość typu ${kind}, messageSeq + 1`, async () => {
      const store = createStore(notifiedState(from));
      const { result, deps } = await run({ store, reader: readerFor(to) });
      assert.equal(deps.sender.sent.length, 1);
      const message = deps.sender.sent[0];
      assert.equal(message.kind, kind);
      assert.equal(message.messageId, `${LABEL}#4`);
      assert.equal(message.key, `${LABEL}#4:${kind}`);
      const state = store.source();
      assert.equal(state.messageSeq, 4);
      assert.equal(state.lastNotifiedState, to);
      assert.equal(state.lastNotifiedKey, message.key);
      assert.equal(state.lastNotifiedAt, NOW.toISOString());
      assert.equal(state.eventId, to === 'OK' ? null : message.messageId);
      assert.equal(state.undeliveredSince, null);
      assert.equal(state.lastObservedState, to);
      assert.equal(result.green, to === 'OK');
      assert.equal(result.committed, true);
      assert.deepEqual(result.sent, [{ messageId: message.messageId, key: message.key, kind }]);
    });
  }

  test('10: pierwszy przebieg bez pliku stanu zaczyna od messageSeq 0 i wysyła #1', async () => {
    const store = createStore(null);
    const { deps } = await run({ store, reader: readerFor('ALERT_STALE') });
    assert.equal(deps.sender.sent[0].key, `${LABEL}#1:ALERT_STALE`);
    assert.equal(store.source().messageSeq, 1);
    assert.equal(store.source().eventId, `${LABEL}#1`);
  });

  test('10: źródło, które jest w porządku od początku, nie wysyła niczego, ale zostawia ślad obserwacji', async () => {
    const store = createStore(null);
    const { result, deps } = await run({ store });
    assert.equal(deps.sender.calls, 0);
    assert.equal(result.green, true);
    assert.deepEqual(store.source(), {
      ...initialSourceState(),
      lastObservedState: 'OK',
      lastObservedAt: NOW.toISOString(),
      lastSuccessfulCheckAt: NOW.toISOString()
    });
  });

  test('10: treść wiadomości: ALERT_STALE nie twierdzi awarii, ALERT_ERROR mówi, że nie udało się sprawdzić', async () => {
    const stale = (await run({ reader: readerFor('ALERT_STALE') })).deps.sender.sent[0];
    assert.match(stale.text, /brak nowych wpisów od 26 godz\./);
    assert.match(stale.text, /w godzinach pracy: 12 godz\., próg: 6 godz\./);
    assert.match(stale.text, /Stan: ALERT_STALE\. Zdarzenie: zrodlo-1#1\. Przebieg: 2026-11-18T09:00:00\.000Z\./);
    assert.doesNotMatch(stale.text + stale.subject, /uszkodz|awari|nie udało się/);
    const error = (await run({ reader: readerFor('ALERT_ERROR') })).deps.sender.sent[0];
    assert.match(error.text, /nie udało się sprawdzić świeżości/);
    assert.match(error.text, /odczyt znacznika nie powiódł się \(kod HTTP 403\)/);
    assert.doesNotMatch(error.text, /brak nowych wpisów/);
    const recovery = (await run({ store: createStore(notifiedState('ALERT_STALE')) })).deps.sender.sent[0];
    assert.match(recovery.text, /powrót do normy, ostatni wpis ma 1 godz\. Stan: OK\. Zdarzenie: zrodlo-1#3\./);
    assert.equal(recovery.subject, '[zrodlo-1] powrót do normy');
  });

  test('10: powrót z ALERT_ERROR do OK wysyła powrót, bo lastNotifiedState to pamięta', async () => {
    const store = createStore(notifiedState('ALERT_ERROR'));
    const { deps } = await run({ store });
    assert.equal(deps.sender.sent[0].kind, 'RECOVERY');
  });
});

describe('#295 stan i protokół: restart i równoległość (11, 12a–e)', () => {
  test('11: świeże uruchomienie czyta stan z magazynu, nie gubi wiadomości i nie dubluje zapisanej', async () => {
    const store = createStore(notifiedState('OK'));
    const first = await run({ store, reader: readerFor('ALERT_STALE') });
    assert.equal(first.deps.sender.sent.length, 1);
    // „Restart”: zupełnie nowe obiekty zależności, ten sam magazyn.
    const second = await run({ store, reader: readerFor('ALERT_STALE'), clock: () => at('2026-11-18 10:30:00') });
    assert.equal(second.deps.sender.sent.length, 0);
    assert.equal(store.source().messageSeq, 4);
    assert.equal(store.source().lastObservedAt, at('2026-11-18 10:30:00').toISOString());
    assert.equal(store.source().lastNotifiedAt, NOW.toISOString());
  });

  test('12a: dwa równoległe przebiegi czytają ten sam stan OK i oba oceniają ALERT_STALE: ten sam messageId i klucz, jeden wygrany commit z wiadomością, brak ponownej wysyłki', async () => {
    const store = createStore(notifiedState('OK'));
    store.gate = barrier(2);
    const sender = createSender();
    const mk = () => createDeps({ store, sender, reader: readerFor('ALERT_STALE') });
    const [a, b] = await Promise.all([runCheck(mk()), runCheck(mk())]);
    assert.equal(sender.sent.length, 2, 'obie wysyłki są dozwolone (G2 ii), ale nie więcej');
    assert.equal(new Set(sender.keys()).size, 1);
    assert.equal(sender.sent[0].key, `${LABEL}#4:ALERT_STALE`);
    assert.equal(sender.sent[0].messageId, sender.sent[1].messageId);
    const messageCommits = store.commits.filter(text => text.includes(`"lastNotifiedKey": "${LABEL}#4:ALERT_STALE"`));
    assert.equal(store.commits.length, 2, 'wygrany z wiadomością i przegrany z samą obserwacją');
    assert.equal(messageCommits.length, 2, 'drugi commit niesie ten sam, już zapisany klucz bez zmiany ewidencji');
    assert.equal(store.source().messageSeq, 4);
    assert.equal(store.source().lastNotifiedKey, `${LABEL}#4:ALERT_STALE`);
    assert.deepEqual([a.committed, b.committed], [true, true]);
    assert.equal(a.sent.length + b.sent.length, 2);
  });

  test('12b: przegrany wysłał, a wygrany zapisał tylko obserwację: przegrany zapisuje swoją wiadomość na świeżym stanie i następny przebieg jej nie powtarza', async () => {
    const store = createStore(notifiedState('OK'));
    // Zanim przegrany zdąży zapisać, inny przebieg zatwierdza same pola obserwacji.
    store.beforeWrite = async call => {
      if (call === 1) store.external({ lastObservedAt: '2026-11-18T08:59:00.000Z' });
    };
    const { result, deps } = await run({ store, reader: readerFor('ALERT_STALE') });
    assert.equal(deps.sender.sent.length, 1);
    assert.equal(result.committed, true);
    const state = store.source();
    assert.equal(state.lastNotifiedKey, `${LABEL}#4:ALERT_STALE`);
    assert.equal(state.messageSeq, 4);
    assert.equal(state.eventId, `${LABEL}#4`);
    const next = await run({ store, reader: readerFor('ALERT_STALE'), clock: () => at('2026-11-18 10:10:00') });
    assert.equal(next.deps.sender.sent.length, 0);
  });

  test('12c: przebiegi szeregowane (drugi po commicie pierwszego): dokładnie jedna wiadomość', async () => {
    const store = createStore(notifiedState('OK'));
    const sender = createSender();
    await runCheck(createDeps({ store, sender, reader: readerFor('ALERT_STALE') }));
    await runCheck(createDeps({ store, sender, reader: readerFor('ALERT_STALE') }));
    assert.equal(sender.sent.length, 1);
  });

  test('12d: konflikt różnych rodzajów — ALERT_STALE vs ALERT_ERROR przy tym samym messageSeq: dwa różne klucze, obie wiadomości rozliczone, stan końcowy ALERT_ERROR', async () => {
    const store = createStore(notifiedState('OK', { messageSeq: 0, lastNotifiedKey: null, lastNotifiedAt: null }));
    store.gate = barrier(2);
    const sender = createSender();
    const commitOfA = new Promise(resolve => { store.afterCommit = resolve; });
    const originalWrite = store.write;
    store.write = async (...args) => {
      const out = await originalWrite(...args);
      if (out.ok && store.afterCommit) { store.afterCommit(); store.afterCommit = null; }
      return out;
    };
    const a = createDeps({ store, sender, reader: readerFor('ALERT_STALE') });
    // B ocenia po zatwierdzeniu A (ponowienie odczytu czeka na commit A), ale jego migawka stanu jest z chwili przed nim.
    const b = createDeps({ store, sender, reader: readerFor('ALERT_ERROR'), sleep: async () => { await commitOfA; } });
    const [ra, rb] = await Promise.all([runCheck(a), runCheck(b)]);
    assert.deepEqual([...sender.keys()].sort(), [`${LABEL}#1:ALERT_ERROR`, `${LABEL}#1:ALERT_STALE`]);
    assert.equal(ra.sent[0].messageId, rb.sent[0].messageId);
    const state = store.source();
    assert.equal(state.lastNotifiedState, 'ALERT_ERROR');
    assert.equal(state.lastNotifiedKey, `${LABEL}#1:ALERT_ERROR`);
    assert.equal(state.messageSeq, 1);
    assert.equal(state.eventId, `${LABEL}#1`);
    const withMessages = store.commits.map(text => JSON.parse(text).sources[LABEL].lastNotifiedKey);
    assert.deepEqual(withMessages, [`${LABEL}#1:ALERT_STALE`, `${LABEL}#1:ALERT_ERROR`]);
    // (3) następny przebieg: trwały błąd odczytu nic nie wysyła…
    const persistent = await run({ store, reader: readerFor('ALERT_ERROR'), clock: () => at('2026-11-18 10:30:00') });
    assert.equal(persistent.deps.sender.sent.length, 0);
    // …a odczyt wracający do ALERT_STALE wysyła nowe przejście pod messageSeq + 1.
    const back = await run({ store, reader: readerFor('ALERT_STALE'), clock: () => at('2026-11-18 10:40:00') });
    assert.equal(back.deps.sender.sent[0].key, `${LABEL}#2:ALERT_STALE`);
    assert.equal(store.source().messageSeq, 2);
  });

  test('12e: starsza wiadomość przegranego — świeży stan ma już większy messageSeq: nie zapisuje się i ewidencja się nie cofa', async () => {
    const store = createStore(notifiedState('OK', { messageSeq: 0, lastNotifiedKey: null, lastNotifiedAt: null }));
    store.beforeWrite = async call => {
      if (call === 1) {
        store.external({
          lastNotifiedState: 'ALERT_STALE', lastNotifiedKey: `${LABEL}#2:ALERT_STALE`, messageSeq: 2, eventId: `${LABEL}#2`,
          lastNotifiedAt: '2026-11-18T08:58:00.000Z'
        });
      }
    };
    const { result, deps } = await run({ store, reader: readerFor('ALERT_STALE') });
    assert.equal(deps.sender.sent.length, 1);
    assert.equal(deps.sender.sent[0].key, `${LABEL}#1:ALERT_STALE`);
    const state = store.source();
    assert.equal(state.messageSeq, 2);
    assert.equal(state.lastNotifiedKey, `${LABEL}#2:ALERT_STALE`);
    assert.equal(state.lastNotifiedAt, '2026-11-18T08:58:00.000Z');
    assert.equal(state.eventId, `${LABEL}#2`);
    assert.equal(result.committed, true);
  });

  test('12e: świeży stan z późniejszą wiadomością, ale o innym stanie niż ocena: przebieg wysyła należną wiadomość pod kolejnym numerem', async () => {
    const store = createStore(notifiedState('OK', { messageSeq: 0, lastNotifiedKey: null, lastNotifiedAt: null }));
    store.beforeWrite = async call => {
      if (call === 1) {
        store.external({ lastNotifiedState: 'OK', lastNotifiedKey: `${LABEL}#2:RECOVERY`, messageSeq: 2, lastNotifiedAt: '2026-11-18T08:58:00.000Z' });
      }
    };
    const { deps } = await run({ store, reader: readerFor('ALERT_STALE') });
    assert.deepEqual(deps.sender.keys(), [`${LABEL}#1:ALERT_STALE`, `${LABEL}#3:ALERT_STALE`]);
    assert.equal(store.source().messageSeq, 3);
    assert.equal(store.source().lastNotifiedKey, `${LABEL}#3:ALERT_STALE`);
  });
});

describe('#295 stan i protokół: awarie wysyłki i zapisu (13, 14a–c)', () => {
  test('13: nieudana wysyłka — lastNotified* i messageSeq bez zmian, undeliveredSince ustawione commitem, przebieg czerwony; następny wysyła z tym samym messageId i czyści', async () => {
    const store = createStore(notifiedState('OK'));
    const first = await run({ store, sender: createSender(['unconfirmed']), reader: readerFor('ALERT_STALE') });
    assert.deepEqual(first.result.problems, ['SEND_FAILED']);
    assert.equal(first.result.green, false);
    assert.deepEqual(first.result.sent, []);
    const state = store.source();
    assert.equal(state.messageSeq, 3);
    assert.equal(state.lastNotifiedState, 'OK');
    assert.equal(state.lastNotifiedKey, `${LABEL}#3:RECOVERY`);
    assert.equal(state.eventId, null);
    assert.equal(state.undeliveredSince, NOW.toISOString());
    assert.equal(state.lastObservedState, 'ALERT_STALE');
    const second = await run({ store, reader: readerFor('ALERT_STALE'), clock: () => at('2026-11-18 10:30:00') });
    assert.equal(second.deps.sender.sent[0].messageId, first.deps.sender.sent[0].messageId);
    assert.equal(second.deps.sender.sent[0].key, first.deps.sender.sent[0].key);
    assert.equal(store.source().undeliveredSince, null);
    assert.equal(store.source().messageSeq, 4);
  });

  test('13: undeliveredSince trzyma pierwszą chwilę nieudanej wysyłki przez kolejne nieudane przebiegi', async () => {
    const store = createStore(notifiedState('OK'));
    await run({ store, sender: createSender(['throw']), reader: readerFor('ALERT_STALE') });
    await run({ store, sender: createSender(['throw']), reader: readerFor('ALERT_STALE'), clock: () => at('2026-11-18 10:30:00') });
    assert.equal(store.source().undeliveredSince, NOW.toISOString());
  });

  test('13: wyjątek nadawcy to też brak potwierdzenia, a log nie zawiera tekstu wyjątku', async () => {
    const { result, deps } = await run({ sender: createSender(['throw']), reader: readerFor('ALERT_STALE') });
    assert.deepEqual(result.problems, ['SEND_FAILED']);
    assert.ok(deps.lines.some(line => line.includes('potwierdzona=nie') && line.includes('kod_http=503')));
  });

  test('13: ocena wróciła do OK bez żadnego potwierdzenia — undeliveredSince czyszczone, wiadomość nie wychodzi (stan, nie historia)', async () => {
    const store = createStore(notifiedState('OK'));
    await run({ store, sender: createSender(['unconfirmed']), reader: readerFor('ALERT_STALE') });
    assert.ok(store.source().undeliveredSince);
    const next = await run({ store, reader: readerFor('OK'), clock: () => at('2026-11-18 10:30:00') });
    assert.equal(next.deps.sender.calls, 0);
    assert.equal(store.source().undeliveredSince, null);
    assert.equal(store.source().lastNotifiedState, 'OK');
    assert.equal(store.source().lastObservedState, 'OK', 'błysk zostaje w historii przez lastObservedState poprzedniego commitu');
    assert.equal(next.result.green, true);
  });

  test('14a: wysyłka potwierdzona, zapis stanu nieudany — stan bez zmian; następny przebieg wyznacza ten sam messageId i klucz (duplikat dopuszczony), po commicie messageSeq + 1', async () => {
    const store = createStore(notifiedState('OK'));
    store.failNextWrites = 1;
    const first = await run({ store, reader: readerFor('ALERT_STALE') });
    assert.deepEqual(first.result.problems, ['STATE_WRITE_FAILED']);
    assert.equal(first.result.green, false);
    assert.equal(first.result.committed, false);
    assert.equal(store.commits.length, 0);
    assert.equal(store.source().messageSeq, 3);
    assert.equal(store.source().lastNotifiedKey, `${LABEL}#3:RECOVERY`);
    const second = await run({ store, reader: readerFor('ALERT_STALE'), clock: () => at('2026-11-18 10:30:00') });
    assert.equal(second.deps.sender.sent[0].messageId, first.deps.sender.sent[0].messageId);
    assert.equal(second.deps.sender.sent[0].key, first.deps.sender.sent[0].key);
    assert.equal(store.source().messageSeq, 4);
    assert.equal(store.source().eventId, first.deps.sender.sent[0].messageId);
  });

  test('14b: messageId i eventId to funkcja zatwierdzonego stanu: różne zegary i restart dają ten sam identyfikator, inny rodzaj pod tym samym numerem inny klucz', async () => {
    const store = createStore(notifiedState('OK'));
    store.failNextWrites = 2;
    const a = await run({ store, reader: readerFor('ALERT_STALE'), clock: () => at('2026-11-18 10:00:00') });
    const b = await run({ store, reader: readerFor('ALERT_STALE'), clock: () => at('2026-11-18 11:45:00') });
    const c = await run({ store, reader: readerFor('ALERT_ERROR'), clock: () => at('2026-11-18 12:00:00') });
    assert.equal(a.deps.sender.sent[0].messageId, `${LABEL}#4`);
    assert.equal(b.deps.sender.sent[0].messageId, `${LABEL}#4`);
    assert.equal(a.deps.sender.sent[0].key, b.deps.sender.sent[0].key);
    assert.equal(c.deps.sender.sent[0].messageId, `${LABEL}#4`);
    assert.equal(c.deps.sender.sent[0].key, `${LABEL}#4:ALERT_ERROR`);
    assert.notEqual(c.deps.sender.sent[0].key, a.deps.sender.sent[0].key);
    assert.equal(store.source().eventId, `${LABEL}#4`);
  });

  test('14c: trzy konflikty commitu z rzędu — przebieg czerwony, stan niezmieniony przez ten przebieg, wiadomość nie wysłana trzeci raz; następny przebieg może ją powtórzyć', async () => {
    const store = createStore(notifiedState('OK'));
    store.beforeWrite = async () => store.external({ lastObservedAt: new Date(Date.parse('2026-11-18T08:00:00.000Z') + store.counter * 1000).toISOString() });
    const first = await run({ store, reader: readerFor('ALERT_STALE') });
    assert.deepEqual(first.result.problems, ['COMMIT_EXHAUSTED']);
    assert.equal(first.result.green, false);
    assert.equal(first.result.committed, false);
    assert.equal(first.deps.sender.sent.length, 1, 'wysłana raz, nie trzy razy');
    assert.equal(store.writes, 3);
    assert.equal(store.source().messageSeq, 3);
    assert.equal(store.source().lastNotifiedKey, `${LABEL}#3:RECOVERY`);
    store.beforeWrite = null;
    const next = await run({ store, reader: readerFor('ALERT_STALE'), clock: () => at('2026-11-18 10:30:00') });
    assert.equal(next.deps.sender.sent[0].key, first.deps.sender.sent[0].key);
    assert.equal(store.source().messageSeq, 4);
  });

  test('14c: po wyczerpaniu prób nie ma czwartego odczytu stanu (ostatni odczyt był przed ostatnią próbą)', async () => {
    const store = createStore(notifiedState('OK'));
    store.beforeWrite = async () => store.external({});
    await run({ store, reader: readerFor('ALERT_STALE') });
    assert.equal(store.reads, 3);
  });

  test('nieudany odczyt stanu po konflikcie to czerwony przebieg STATE_READ_FAILED', async () => {
    const store = createStore(notifiedState('OK'));
    store.beforeWrite = async () => { store.external({}); store.failReads = true; };
    const { result } = await run({ store, reader: readerFor('OK') });
    assert.deepEqual(result.problems, ['STATE_READ_FAILED']);
    assert.equal(result.green, false);
  });
});

describe('#295 stan i protokół: odczyt stanu, przypomnienia, konfiguracja, czerwień (1, 15–17)', () => {
  test('1: nieudany odczyt stanu to czerwony przebieg bez wysyłania i bez zapisu; czytnik nie jest nawet pytany', async () => {
    const store = createStore(notifiedState('OK'));
    store.failReads = true;
    const { result, deps } = await run({ store, reader: readerFor('ALERT_STALE') });
    assert.deepEqual(result.problems, ['STATE_READ_FAILED']);
    assert.equal(result.green, false);
    assert.equal(result.alertLevel, null);
    assert.equal(deps.sender.calls, 0);
    assert.equal(deps.reader.calls, 0);
    assert.equal(store.writes, 0);
    assert.deepEqual(deps.lines, ['[zrodlo-1] problem=STATE_READ_FAILED']);
  });

  test('1: plik stanu, którego sprawdzacz nie rozumie, nie jest nadpisywany', async () => {
    const store = createStore(null);
    store.text = '{"sources":{"zrodlo-1":{"messageSeq":"x"}}}';
    store.version = 'v0';
    const { result, deps } = await run({ store });
    assert.deepEqual(result.problems, ['STATE_READ_FAILED']);
    assert.equal(store.writes, 0);
    assert.equal(deps.sender.calls, 0);
  });

  test('2: odczyt jest ponawiany w obrębie przebiegu (2 próby, odstęp co najmniej 60 s); pierwsza nieudana i druga udana to zwykły stan', async () => {
    const reader = createReader(leakyError(503), OK_MARKER);
    const { result, deps } = await run({ reader });
    assert.equal(reader.calls, 2);
    assert.deepEqual(deps.sleeps, [60000]);
    assert.equal(result.alertLevel, 'OK');
    assert.equal(result.green, true);
  });

  test('3: obie próby nieudane to ERROR: ALERT_ERROR, jedno oczekiwanie, brak aktualizacji lastSuccessfulCheckAt', async () => {
    const store = createStore(notifiedState('OK'));
    const reader = createReader(...FAILING_READ);
    const { result, deps } = await run({ store, reader });
    assert.equal(reader.calls, 2);
    assert.deepEqual(deps.sleeps, [60000]);
    assert.equal(result.alertLevel, 'ALERT_ERROR');
    assert.equal(result.assessment.reason, 'READ_FAILED');
    assert.equal(store.source().lastSuccessfulCheckAt, '2026-11-18T08:30:00.000Z');
    assert.equal(store.source().lastObservedAt, NOW.toISOString());
  });

  test('3: odstęp ponowienia pochodzi z konfiguracji', async () => {
    const { deps } = await run({ reader: createReader(leakyError(), OK_MARKER), config: makeConfig({ retryDelayMs: 120000 }) });
    assert.deepEqual(deps.sleeps, [120000]);
  });

  test('3: udany odczyt aktualizuje lastSuccessfulCheckAt także przy znaczniku niepoprawnym i przy ALERT_STALE', async () => {
    for (const marker of ['', STALE_MARKER, OK_MARKER]) {
      const store = createStore(notifiedState('OK'));
      await run({ store, reader: createReader(marker), sender: createSender(['unconfirmed']) });
      assert.equal(store.source().lastSuccessfulCheckAt, NOW.toISOString(), JSON.stringify(marker));
    }
  });

  test('15: przypomnienie liczone od potwierdzonego lastNotifiedAt w godzinach pracy; przed 24 h nic, po 24 h jedno, bez dublowania', async () => {
    // Pn 16.11 09:00 potwierdzony alarm; okno 08–18 → 24 h pracy mija w środę 18.11 o 13:00.
    const sent = '2026-11-16T08:00:00.000Z';
    const stale = createReader('2026-11-13 10:00:00');
    const mk = (time, store) => run({ store, reader: stale, clock: () => at(time) });
    const store = createStore(notifiedState('ALERT_STALE', { lastNotifiedAt: sent }));
    const before = await mk('2026-11-18 12:59:59', store);
    assert.equal(before.deps.sender.calls, 0);
    const due = await mk('2026-11-18 13:00:00', store);
    assert.equal(due.deps.sender.sent.length, 1);
    assert.equal(due.deps.sender.sent[0].kind, 'REMINDER');
    assert.equal(due.deps.sender.sent[0].key, `${LABEL}#4:REMINDER`);
    assert.match(due.deps.sender.sent[0].text, /^Przypomnienie\. Źródło zrodlo-1: brak nowych wpisów od 123 godz\./);
    assert.equal(due.deps.sender.sent[0].subject, '[zrodlo-1] brak nowych wpisów od 123 godz. (przypomnienie)');
    assert.equal(store.source().lastNotifiedAt, at('2026-11-18 13:00:00').toISOString());
    assert.equal(store.source().eventId, `${LABEL}#3`, 'przypomnienie nie zmienia zdarzenia');
    assert.equal(store.source().messageSeq, 4);
    const again = await mk('2026-11-18 13:30:00', store);
    assert.equal(again.deps.sender.calls, 0);
  });

  test('15: opóźniony harmonogram (przerwa równa kilku interwałom) daje dokładnie jedno przypomnienie, nie kilka', async () => {
    const store = createStore(notifiedState('ALERT_STALE', { lastNotifiedAt: '2026-11-10T08:00:00.000Z' }));
    const sender = createSender();
    await runCheck(createDeps({ store, sender, reader: createReader('2026-11-01 10:00:00'), clock: () => at('2026-11-18 10:00:00') }));
    assert.equal(sender.sent.length, 1);
    assert.equal(sender.sent[0].kind, 'REMINDER');
  });

  test('15: przypomnienie o ALERT_ERROR ma treść błędu, a próg przypomnienia pochodzi z konfiguracji', async () => {
    const store = createStore(notifiedState('ALERT_ERROR', { lastNotifiedAt: '2026-11-18T08:00:00.000Z' }));
    const config = makeConfig({ reminderWorkingHours: 1 });
    const { deps } = await run({ store, config, reader: readerFor('ALERT_ERROR') });
    assert.equal(deps.sender.sent[0].kind, 'REMINDER');
    assert.match(deps.sender.sent[0].text, /^Przypomnienie\. Źródło zrodlo-1: nie udało się sprawdzić/);
    assert.equal(deps.sender.sent[0].subject, '[zrodlo-1] nie udało się sprawdzić świeżości źródła (przypomnienie)');
  });

  test('15: stan z alarmem bez lastNotifiedAt nie daje przypomnienia (brak punktu odniesienia)', async () => {
    const store = createStore(notifiedState('ALERT_STALE', { lastNotifiedAt: null }));
    const { deps } = await run({ store, reader: readerFor('ALERT_STALE') });
    assert.equal(deps.sender.calls, 0);
  });

  test('16: zmiana progu — oceniane wg bieżącej konfiguracji: ten sam wynik bez wiadomości i bez zmiany historii, nowy wynik z wiadomością uzasadnioną nim', async () => {
    const store = createStore(notifiedState('ALERT_STALE'));
    const same = await run({ store, reader: readerFor('ALERT_STALE'), config: makeConfig({ workingHoursThresholdHours: 5 }) });
    assert.equal(same.deps.sender.calls, 0);
    assert.equal(store.source().lastNotifiedKey, `${LABEL}#3:ALERT_STALE`);
    assert.equal(store.source().lastNotifiedAt, '2026-11-18T08:30:00.000Z');
    assert.equal(store.source().messageSeq, 3);
    const relaxed = await run({ store, reader: readerFor('ALERT_STALE'), config: makeConfig({ workingHoursThresholdHours: 13 }), clock: () => at('2026-11-18 10:10:00') });
    assert.equal(relaxed.deps.sender.sent[0].kind, 'RECOVERY');
    const tightened = await run({ store, reader: createReader(OK_MARKER), config: makeConfig({ workingHoursThresholdHours: 0.5 }), clock: () => at('2026-11-18 10:20:00') });
    assert.equal(tightened.deps.sender.sent[0].kind, 'ALERT_STALE');
  });

  test('16: zmiana okna pracy i listy dni wolnych między przebiegami też działa wg bieżącej konfiguracji', async () => {
    const store = createStore(notifiedState('OK'));
    // Wtorek 17.11 (08:00) → środa 18.11 10:00 to 12 h pracy; okno skrócone do 09–10 daje 1 h i brak alarmu.
    const shorter = await run({ store, reader: readerFor('ALERT_STALE'),
      config: makeConfig({ window: { days: [2, 3], start: '09:00', end: '10:00' } }) });
    assert.equal(shorter.deps.sender.calls, 0);
    const holiday = await run({ store, reader: readerFor('ALERT_STALE'), config: makeConfig({ holidays: ['2026-11-17'] }), clock: () => at('2026-11-18 10:05:00') });
    assert.equal(holiday.deps.sender.calls, 0, 'wtorek wolny: 2 h pracy w środę');
    const plain = await run({ store, reader: readerFor('ALERT_STALE'), clock: () => at('2026-11-18 10:10:00') });
    assert.equal(plain.deps.sender.sent[0].kind, 'ALERT_STALE');
  });

  test('17: przebieg jest czerwony przy ALERT_STALE i ALERT_ERROR, także gdy wiadomości nie wysłano, bo stan już ją zawiera', async () => {
    for (const level of ['ALERT_STALE', 'ALERT_ERROR']) {
      const store = createStore(notifiedState(level));
      const { result, deps } = await run({ store, reader: readerFor(level) });
      assert.equal(deps.sender.calls, 0, level);
      assert.equal(result.alertLevel, level);
      assert.equal(result.green, false, level);
      assert.deepEqual(result.problems, [], level);
    }
  });

  test('godziny pracy: alarm z progu godzin pracy poza oknem czeka do otwarcia okna, a undeliveredSince trwa', async () => {
    const store = createStore(notifiedState('OK', { undeliveredSince: '2026-11-17T15:00:00.000Z' }));
    // Środa 07:30, okno otwiera się o 08:00; znacznik z wtorku 08:00 ma 10 h pracy (wtorek) i 0 h dziś.
    const config = makeConfig({ workingHoursThresholdHours: 8 });
    const early = await run({ store, config, reader: createReader('2026-11-17 08:00:00'), clock: () => at('2026-11-18 07:30:00') });
    assert.equal(early.result.alertLevel, 'ALERT_STALE');
    assert.equal(early.result.assessment.deferred, true);
    assert.equal(early.deps.sender.calls, 0);
    assert.equal(early.result.green, false);
    assert.equal(store.source().undeliveredSince, '2026-11-17T15:00:00.000Z');
    assert.equal(store.source().lastNotifiedState, 'OK');
    const open = await run({ store, config, reader: createReader('2026-11-17 08:00:00'), clock: () => at('2026-11-18 08:00:00') });
    assert.equal(open.deps.sender.sent[0].kind, 'ALERT_STALE');
    assert.equal(store.source().undeliveredSince, null);
  });

  test('godziny pracy: ALERT_STALE z twardego limitu i ALERT_ERROR nie czekają na okno', async () => {
    const night = () => at('2026-11-22 03:00:00'); // niedziela, poza oknem
    const hard = await run({ reader: createReader('2026-11-10 10:00:00'), clock: night });
    assert.equal(hard.deps.sender.sent[0].kind, 'ALERT_STALE');
    assert.match(hard.deps.sender.sent[0].text, /Alarm wynika z limitu bezwzględnego 96 godz\. \(liczonego razem z weekendami i świętami\)\./);
    assert.doesNotMatch(hard.deps.sender.sent[0].text, /w godzinach pracy/);
    const failing = await run({ reader: readerFor('ALERT_ERROR'), clock: night });
    assert.equal(failing.deps.sender.sent[0].kind, 'ALERT_ERROR');
  });

  test('godziny pracy: odroczone przypomnienie też czeka na okno', async () => {
    const store = createStore(notifiedState('ALERT_STALE', { lastNotifiedAt: '2026-11-10T08:00:00.000Z' }));
    const config = makeConfig({ hardLimitHours: 100000, workingHoursThresholdHours: 1 });
    const { deps } = await run({ store, config, reader: createReader('2026-11-17 08:00:00'), clock: () => at('2026-11-21 12:00:00') });
    assert.equal(deps.sender.calls, 0);
  });

  test('log przebiegu: jedna linia stanu z polami o stałym kształcie', async () => {
    const { deps } = await run({ reader: readerFor('ALERT_STALE'), store: createStore(notifiedState('ALERT_STALE')) });
    assert.deepEqual(deps.lines, [
      '[zrodlo-1] stan=ALERT_STALE surowy=STALE powod=WORKING_HOURS wiek_h=26 praca_h=12 prog_h=6 limit_h=96 odroczony=nie zdarzenie=zrodlo-1#3 przebieg=2026-11-18T09:00:00.000Z'
    ]);
    const errorLine = (await run({ reader: readerFor('ALERT_ERROR'), sender: createSender(['unconfirmed']) })).deps.lines;
    assert.equal(errorLine[0], '[zrodlo-1] stan=ALERT_ERROR surowy=ERROR powod=READ_FAILED wiek_h=- praca_h=- prog_h=6 limit_h=96 odroczony=nie zdarzenie=- przebieg=2026-11-18T09:00:00.000Z');
    assert.equal(errorLine[1], '[zrodlo-1] wiadomosc=ALERT_ERROR klucz=zrodlo-1#1:ALERT_ERROR potwierdzona=nie');
  });

  test('log: potwierdzona wiadomość i kod HTTP z wyjątku nadawcy', async () => {
    const ok = await run({ reader: readerFor('ALERT_STALE') });
    assert.equal(ok.deps.lines[1], '[zrodlo-1] wiadomosc=ALERT_STALE klucz=zrodlo-1#1:ALERT_STALE potwierdzona=tak');
    const thrown = await run({ reader: readerFor('ALERT_STALE'), sender: createSender(['throw']) });
    assert.equal(thrown.deps.lines[1], '[zrodlo-1] wiadomosc=ALERT_STALE klucz=zrodlo-1#1:ALERT_STALE potwierdzona=nie kod_http=503');
  });

  test('nadawca zwracający cokolwiek poza { confirmed: true } nie potwierdza dostarczenia', async () => {
    for (const reply of [undefined, null, true, { confirmed: 'true' }, { confirmed: 1 }, {}]) {
      const sender = { sent: [], async send(m) { sender.sent.push(m); return reply; } };
      const { result } = await run({ sender, reader: readerFor('ALERT_STALE') });
      assert.deepEqual(result.problems, ['SEND_FAILED'], JSON.stringify(reply));
    }
  });
});
