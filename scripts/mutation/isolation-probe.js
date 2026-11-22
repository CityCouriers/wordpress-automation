'use strict';

// Sondy czynne izolacji, wykonywane PRZED mutantami (kontrakt #253), po pozytywnej ocenie faktów
// z isolation-guard.js. Sondy NIE zastępują faktów: fakty dowodzą mechanizmu, sondy łapią błąd
// konfiguracji, którego fakty nie widzą. Każda nieudana sonda to odmowa startu, bez raportu.
//   1. sieć: połączenie TCP z kilkoma różnymi adresami (IPv4, IPv6, adres metadanych) i rozwiązanie
//      nazwy muszą się nie udać (wystarczy jeden udany => odmowa: blokada dwóch adresów nie jest odcięciem),
//   2. zapis poza katalogiem przebiegu: utworzenie pliku w katalogach systemowych, nadrzędnym i domowym
//      musi być odmówione,
//   3. odczyt poza katalogiem przebiegu: znane ścieżki hosta (gniazdo dockera, katalog runnera, sekrety)
//      oraz plik kontrolny hosta podany przez workflow muszą być niedostępne,
//   4. pozytywny test: testy uruchamiają się w tym środowisku (inaczej „zielony” wynik byłby pustą odmową).
const fs = require('node:fs');
const dns = require('node:dns');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeEnv } = require('./safe-env.js');
const { WORKDIR } = require('./isolation-guard.js');

const NETWORK_TARGETS = [['1.1.1.1', 443], ['8.8.8.8', 53], ['9.9.9.9', 443], ['169.254.169.254', 80], ['2606:4700:4700::1111', 443]];
const DNS_NAME = 'example.org';
const WRITE_DIRS = ['/', '/etc', '/usr', '/var', '/root'];
const READ_PATHS = ['/var/run/docker.sock', '/run/docker.sock', '/home/runner', '/github', '/run/secrets', '/root/.ssh', '/etc/shadow'];
const POSITIVE_TEST = path.join('scripts', 'mutation', 'load-only.test.js');

/** `connect` podmienia net.connect w testach (bez prawdziwej sieci). */
function connectSucceeds(host, port, timeoutMs, connect = net.connect) {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

function lookupSucceeds(name, resolver = dns.promises) {
  return resolver.lookup(name).then(() => true, () => false);
}

function canWriteIn(dir) {
  const target = path.join(dir, `.mutation-probe-${process.pid}`);
  let fd;
  try {
    fd = fs.openSync(target, 'wx');
  } catch {
    return false;
  }
  fs.closeSync(fd);
  try {
    fs.rmSync(target);
  } catch {
    // sprzątanie jest best-effort: udane utworzenie pliku już dowodzi, że zapis jest możliwy
  }
  return true;
}

function canRead(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** `cwd` podmienia katalog przebiegu w testach (w izolatorze to zawsze WORKDIR). */
function positiveTestPasses(cwd = WORKDIR) {
  const run = spawnSync(process.execPath, ['--test', POSITIVE_TEST], { cwd, env: safeEnv(process.env) });
  return run.status === 0;
}

const REAL_IO = { connectSucceeds, lookupSucceeds, canWriteIn, canRead, positiveTestPasses, homedir: os.homedir };

/**
 * Wykonuje sondy i zwraca listę odmów (pusta = wszystkie zdane). Błąd samej sondy to odmowa, nie pominięcie.
 * `options.outside`: ścieżki hosta, które w izolatorze nie mogą być widoczne (plik kontrolny z workflow).
 */
async function runProbes({ io = REAL_IO, outside = [] } = {}) {
  const failures = [];
  const attempt = async (what, fn) => {
    try {
      return await fn();
    } catch (error) {
      failures.push(`sonda „${what}” zakończyła się błędem: ${error && error.message}`);
      return false;
    }
  };
  for (const [host, port] of NETWORK_TARGETS) {
    if (await attempt(`sieć ${host}`, () => io.connectSucceeds(host, port, 3000))) failures.push(`sieć nie jest odcięta (połączenie z ${host}:${port} się udało)`);
  }
  if (await attempt('DNS', () => io.lookupSucceeds(DNS_NAME))) failures.push('sieć nie jest odcięta (rozwiązanie nazwy się udało)');
  const writeDirs = [...WRITE_DIRS, path.dirname(WORKDIR), await attempt('katalog domowy', () => io.homedir())].filter(d => typeof d === 'string' && d);
  for (const dir of [...new Set(writeDirs)]) {
    if (await attempt(`zapis ${dir}`, () => io.canWriteIn(dir))) failures.push(`zapis poza katalogiem przebiegu jest możliwy (${dir})`);
  }
  for (const file of [...READ_PATHS, ...outside]) {
    if (await attempt(`odczyt ${file}`, () => io.canRead(file))) failures.push(`odczyt poza katalogiem przebiegu jest możliwy (${file})`);
  }
  if (failures.length === 0 && !await attempt('pozytywny test', () => io.positiveTestPasses())) failures.push('pozytywny test uruchomienia testów w tym środowisku nie przeszedł');
  return failures;
}

module.exports = {
  runProbes, NETWORK_TARGETS, READ_PATHS, WRITE_DIRS, DNS_NAME, REAL_IO, connectSucceeds, lookupSucceeds, canWriteIn, canRead, positiveTestPasses
};
