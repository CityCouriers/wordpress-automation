'use strict';

// Sonda WYKRYWANIA ekspozycji (diagnostyka), a nie dowód izolacji. Może tylko zawetować: znajduje
// dostęp, którego być nie powinno, ale NIGDY nie stwierdza, że izolacja jest skuteczna. Próbki są
// skończone (dwa adresy IP, katalog nadrzędny, kilka plików użytkownika), więc „nic nie wykryto” nie
// znaczy „odcięto”: zablokowane dwa adresy nie dowodzą braku sieci, brak czterech plików nie dowodzi
// braku dostępu do reszty dysku. Dlatego kod wyjścia nigdy nie wynosi 0 i nic w pilocie nie
// pozwala na start Strykera na jej podstawie (zob. isolation-guard.js). Dowód MECHANIZMU izolacji
// (kontener bez sieci, ograniczony mount i UID, jawna polityka systemu plików) jest przedmiotem #253.
//   1. sieć: czy połączenie TCP z publicznym adresem się udaje,
//   2. zapis poza katalogiem przebiegu: czy plik kontrolny w katalogu nadrzędnym da się zapisać,
//   3. odczyt konfiguracji użytkownika (np. ~/.npmrc, ~/.gitconfig, ~/.ssh),
//   4. otoczenie: poświadczenia, GIT_* i pliki .clasp*.
// Użycie: node scripts/mutation/isolation-probe.js   (kod 3 = wykryto ekspozycję, kod 4 = nic nie wykryto, bez zgody na start)
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SECRET_NAME = /TOKEN|SECRET|PASS|KEY|CRED|AUTH|^CC_|^CLAUDE|^GOOGLE|^GH_|^GITHUB|^NPM_/i;

function connectSucceeds(host, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

function canWriteOutside() {
  const target = path.join(path.dirname(ROOT), `.mutation-probe-${process.pid}`);
  try {
    fs.writeFileSync(target, 'x');
    fs.rmSync(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

function readableUserConfig() {
  const home = os.homedir();
  return ['.npmrc', '.gitconfig', '.ssh', '.config'].map(n => path.join(home, n)).filter(p => {
    try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
  });
}

async function probe(env = process.env) {
  const failures = [];
  for (const [host, port] of [['1.1.1.1', 443], ['8.8.8.8', 53]]) {
    if (await connectSucceeds(host, port, 3000)) failures.push(`sieć nie jest odcięta (połączenie z ${host}:${port} się udało)`);
  }
  if (canWriteOutside()) failures.push('zapis poza katalogiem przebiegu jest możliwy (katalog nadrzędny repozytorium)');
  const readable = readableUserConfig();
  if (readable.length) failures.push(`odczyt konfiguracji użytkownika jest możliwy (${readable.map(p => path.basename(p)).join(', ')})`);
  const secrets = Object.keys(env).filter(n => SECRET_NAME.test(n) || /^GIT_/i.test(n));
  if (secrets.length) failures.push(`w otoczeniu są zmienne z poświadczeniami lub GIT_*: ${secrets.length} szt.`);
  if (fs.readdirSync(ROOT).some(n => /^\.clasp/.test(n) && n !== '.claspignore')) failures.push('w katalogu repozytorium są pliki .clasp*');
  return failures;
}

/** Wynik sondy: nigdy zgoda na start. */
function verdict(failures) {
  if (failures.length) {
    return { code: 3, text: ['WYKRYTO EKSPOZYCJĘ (no-go-izolacja):', ...failures.map(f => `- ${f}`)].join(String.fromCharCode(10)) };
  }
  return {
    code: 4,
    text: 'Nie wykryto ekspozycji w skończonej liście próbek. To NIE jest dowód izolacji i nie daje zgody na start mutantów (no-go-izolacja do czasu dowodu mechanizmu w #253).'
  };
}

if (require.main === module) {
  probe().then(failures => {
    const v = verdict(failures);
    console.log(v.text);
    process.exit(v.code);
  });
}
module.exports = { probe, verdict };
