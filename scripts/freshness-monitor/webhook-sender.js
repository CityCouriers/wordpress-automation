'use strict';

/**
 * Domyślny kanał dostarczenia (#295): POST JSON na adres webhooka instalacji.
 *
 * Kanał i adresat należą do instalacji i są jej sekretami. Kanał nie może być `MailApp` z Apps Script,
 * a powiadomienie GitHuba o nieudanym przebiegu nie jest kanałem gwarantowanym. Potwierdzeniem
 * przyjęcia jest odpowiedź 2xx odbiorcy; wszystko inne (kod spoza 2xx, błąd sieci, przekierowanie,
 * przekroczony czas) to brak potwierdzenia. Klucz idempotencji idzie w nagłówku `Idempotency-Key`,
 * ale kontrakt dostarczenia „co najmniej raz” NIE zakłada, że odbiorca go honoruje.
 *
 * Instalacja z innym kanałem (e-mail, komunikator) podstawia własnego nadawcę o tym samym
 * interfejsie: `send(message)` zwraca `{ confirmed: true }` tylko po potwierdzonym przyjęciu.
 */

const TIMEOUT_MS = 15000;

/** Błąd wysyłki: tylko kod HTTP (liczba) albo nic; komunikat jest stały. */
class SendError extends Error {
  constructor(status) {
    super(status === undefined ? 'SEND_FAILED' : `HTTP ${status}`);
    this.name = 'SendError';
    if (status !== undefined) this.status = status;
  }
}

class SenderConfigError extends Error {
  constructor() {
    super('SENDER_CONFIG_INVALID:url');
    this.name = 'SenderConfigError';
  }
}

function assertHttps(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SenderConfigError();
  }
  if (parsed.protocol !== 'https:') throw new SenderConfigError();
}

/**
 * @param {{url: string, fetchFn?: function}} options
 * @return {{send: function(object): Promise<{confirmed: boolean}>}}
 */
function createWebhookSender({ url, fetchFn = fetch }) {
  assertHttps(url);
  return {
    async send(message) {
      let response;
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': message.key },
          body: JSON.stringify({
            messageId: message.messageId, key: message.key, kind: message.kind, subject: message.subject, text: message.text
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS)
        });
      } catch {
        throw new SendError();
      }
      if (response.status < 200 || response.status > 299) throw new SendError(response.status);
      return { confirmed: true };
    }
  };
}

module.exports = { SendError, SenderConfigError, createWebhookSender };
