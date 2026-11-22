'use strict';

// Bramka startu mutantów: weryfikuje MECHANIZM izolacji z kontraktu #253 (następca #234), a nie
// deklarację. Nie ma tu zmiennej środowiskowej, pliku ani flagi, które zdejmują odmowę; narzędzie
// startuje tylko wtedy, gdy PROCES sam stwierdza, że działa w izolatorze o wymaganych cechach:
//   1. bez sieci: w przestrzeni nazw sieci jest wyłącznie `lo` i nie ma tras (czytane z /proc),
//   2. nieuprzywilejowany UID, zerowe uprawnienia (CapEff/CapPrm/CapBnd), no_new_privs i filtr seccomp,
//   3. system plików główny tylko do odczytu; zapisywalny jest wyłącznie katalog przebiegu (/work),
//      /tmp i systemowe punkty kontenera (/proc, /dev, /sys, /etc/hosts...); każdy inny punkt
//      montowania (także tylko do odczytu, np. HOME użytkownika albo gniazdo dockera) to odmowa,
//   4. otoczenie bez poświadczeń i GIT_* (w procesie głównym: tylko nazwy z allowlisty),
//   5. repozytorium (korzeń skryptów) i bieżący katalog leżą w katalogu przebiegu (albo w jego podkatalogu).
// Fakty czytamy z /proc procesu, który ma uruchomić mutanty, więc nie da się ich zadeklarować.
// Po faktach orkiestrator wykonuje jeszcze sondy czynne (isolation-probe.js): odmowa połączeń, zapisu
// i odczytu poza katalogiem oraz pozytywny test uruchomienia testów. Wynik niepewny (nie dał się
// odczytać plik z /proc, nieoczekiwany wyjątek) jest odmową. Zob. docs/quality/mutation.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Katalog przebiegu w izolatorze: jedyny zamontowany katalog z zapisem. Zgodny z workflow (test). */
const WORKDIR = '/work';
/** Końcówka źródła montowania katalogu przebiegu na hoście: kopia przygotowana przez workflow, nigdy / ani HOME. */
const WORKDIR_SOURCE_SUFFIX = '/mutation-run';
/**
 * Dozwolone punkty montowania poza katalogiem przebiegu: dokładny punkt => wymagany typ systemu plików (fs)
 * albo wzorzec źródła w systemie plików hosta (root, dla plików doklejanych przez środowisko kontenera).
 * Każdy inny punkt, także tylko do odczytu, jest odmową.
 */
const MOUNT_POLICY = {
  '/proc': { fs: 'proc' },
  '/dev': { fs: 'tmpfs' },
  '/dev/pts': { fs: 'devpts' },
  '/dev/shm': { fs: 'tmpfs' },
  '/dev/mqueue': { fs: 'mqueue' },
  '/dev/console': { fs: 'devpts' },
  '/sys': { fs: 'sysfs' },
  '/tmp': { fs: 'tmpfs' },
  '/etc/hosts': { root: /\/containers\/[0-9a-f]{12,64}\/hosts$/ },
  '/etc/hostname': { root: /\/containers\/[0-9a-f]{12,64}\/hostname$/ },
  '/etc/resolv.conf': { root: /\/containers\/[0-9a-f]{12,64}\/resolv\.conf$/ }
};
/** Podmontowania doklejane pod /proc i /sys (maskowanie ścieżek): wyłącznie typy systemowe. */
const MOUNT_FAMILIES = { '/proc/': ['proc', 'tmpfs'], '/sys/': ['sysfs', 'cgroup', 'cgroup2', 'tmpfs'] };
/**
 * Ścieżki pod /proc i /sys, które środowisko uruchomieniowe kontenera maskuje montowaniem tmpfs (domyślne maskowane
 * ścieżki runc). Montowanie tmpfs w innym miejscu tych drzew to odmowa: tak wyglądałby katalog hosta (np. /run)
 * podstawiony pod /sys/kernel/security, a sondy odczytu sprawdzają tylko stałe ścieżki.
 */
const MASKED_PATHS = [
  '/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys', '/proc/latency_stats', '/proc/timer_list',
  '/proc/timer_stats', '/proc/sched_debug', '/proc/scsi', '/sys/firmware', '/sys/devices/virtual/powercap'
];
const ENV_ALLOWED = ['PATH', 'HOME', 'HOSTNAME', 'TZ', 'LANG', 'LC_ALL', 'TERM', 'PWD', 'SHLVL', '_', 'NODE_VERSION', 'YARN_VERSION'];
const SECRET_NAME = /TOKEN|SECRET|PASS|KEY|CRED|AUTH|^CC_|^CLAUDE|^GOOGLE|^GH_|^GITHUB|^NPM_|^RUNNER_|^ACTIONS_|^GIT_/i;
const ROOT = path.resolve(__dirname, '..', '..');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Nazwy interfejsów sieciowych procesu; null, gdy nie da się ich odczytać (w ocenie to odmowa). */
function interfaceNames(source = os) {
  try {
    return Object.keys(source.networkInterfaces());
  } catch {
    return null;
  }
}

/** UID/GID z funkcji procesu; null, gdy platforma jej nie ma (w ocenie to odmowa). */
function numericId(getter) {
  return typeof getter === 'function' ? getter() : null;
}

/** Fakty o bieżącym procesie. Brak odczytu daje null, a ten w ocenie jest odmową. `reader` podmienia czytanie plików. */
function readFacts(reader = readText) {
  return {
    platform: process.platform,
    uid: numericId(process.getuid),
    euid: numericId(process.geteuid),
    status: reader('/proc/self/status'),
    mountinfo: reader('/proc/self/mountinfo'),
    netDev: reader('/proc/net/dev'),
    route: reader('/proc/net/route'),
    interfaces: interfaceNames(),
    envNames: Object.keys(process.env),
    cwd: process.cwd(),
    root: ROOT
  };
}

/** Pola /proc/self/status: "Uid:\t1000\t1000\t1000\t1000" -> { Uid: '1000\t1000\t1000\t1000' }. */
function parseStatus(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
}

/** Ucieczki ósemkowe w ścieżkach mountinfo (spacja to \040). */
function unescapeMount(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

/** Wiersze /proc/self/mountinfo: punkt montowania, opcje (rw/ro), ścieżka źródła (root) i typ systemu plików. */
function parseMountinfo(text) {
  const mounts = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split(' ');
    const dash = fields.indexOf('-');
    mounts.push({
      mountPoint: unescapeMount(fields[4] || ''),
      options: (fields[5] || '').split(','),
      root: unescapeMount(fields[3] || ''),
      fsType: dash >= 0 ? fields[dash + 1] || '' : ''
    });
  }
  return mounts;
}

/** Nazwy interfejsów z /proc/net/dev (dwa wiersze nagłówka). */
function parseNetDev(text) {
  return text.split('\n').slice(2).filter(l => l.includes(':')).map(l => l.slice(0, l.indexOf(':')).trim());
}

/** Wpisy tablicy tras /proc/net/route (bez nagłówka). */
function routeEntries(text) {
  return text.split('\n').slice(1).filter(l => l.trim());
}

/** Katalog przebiegu albo jego podkatalog (np. kopia robocza Strykera .stryker-tmp/sandbox-*). */
function withinWorkdir(dir) {
  return dir === WORKDIR || String(dir).startsWith(`${WORKDIR}/`);
}

function allZero(hex) {
  return /^0+$/.test(hex);
}

/** Identyfikatory z pola /proc/self/status (Uid, Gid, Groups): słowa rozdzielone białymi znakami. */
function idList(value) {
  return String(value).split(/\s+/);
}

function privilegeFailures(facts, status) {
  const failures = [];
  const ids = idList(status.Uid);
  if (facts.uid === 0 || facts.euid === 0 || ids.length !== 4 || ids.includes('0')) failures.push('proces działa jako root (UID 0) albo UID nie dał się ustalić');
  for (const key of ['CapEff', 'CapPrm', 'CapBnd']) {
    if (!allZero(status[key])) failures.push(`uprawnienia procesu nie są zerowe (${key}=${status[key]}); oczekiwano --cap-drop ALL`);
  }
  const gid = idList(status.Gid);
  const groups = idList(status.Groups);
  if (gid.length !== 4 || gid.includes('0') || groups.includes('0')) failures.push('proces ma GID 0 (grupa główna lub dodatkowa) albo GID nie dał się ustalić');
  if (status.NoNewPrivs !== '1') failures.push('brak no_new_privs (NoNewPrivs != 1)');
  if (status.Seccomp !== '2') failures.push('brak filtra seccomp (Seccomp != 2)');
  return failures;
}

function networkFailures(facts) {
  const failures = [];
  const names = parseNetDev(facts.netDev);
  if (names.length === 0 || names.some(n => n !== 'lo')) failures.push(`sieć nie jest odcięta: interfejsy w /proc/net/dev: ${names.join(', ') || 'brak odczytu'}`);
  if (!Array.isArray(facts.interfaces) || facts.interfaces.length === 0 || facts.interfaces.some(n => n !== 'lo')) failures.push('sieć nie jest odcięta: os.networkInterfaces() zawiera coś poza lo');
  if (routeEntries(facts.route).length) failures.push('sieć nie jest odcięta: w /proc/net/route są trasy');
  return failures;
}

/** Odmowa dla jednego punktu montowania poza / i katalogiem przebiegu; null = dozwolony. */
function mountPointFailure(m) {
  const exact = MOUNT_POLICY[m.mountPoint];
  if (exact) {
    if (exact.fs && exact.fs !== m.fsType) return `punkt montowania ${m.mountPoint} ma typ ${m.fsType}, oczekiwano ${exact.fs}`;
    if (exact.root && !exact.root.test(m.root)) return `punkt montowania ${m.mountPoint} ma źródło spoza katalogu kontenera: ${m.root}`;
    return null;
  }
  const family = Object.keys(MOUNT_FAMILIES).find(prefix => m.mountPoint.startsWith(prefix));
  if (family) {
    if (m.fsType === 'tmpfs' && !MASKED_PATHS.includes(m.mountPoint)) return `punkt montowania ${m.mountPoint} ma typ tmpfs poza listą ścieżek maskowanych przez kontener`;
    return MOUNT_FAMILIES[family].includes(m.fsType) ? null : `punkt montowania ${m.mountPoint} ma typ ${m.fsType}, oczekiwano ${MOUNT_FAMILIES[family].join('/')}`;
  }
  return `nieznany punkt montowania ${m.mountPoint} (dozwolone: ${WORKDIR}, /tmp i punkty kontenera)`;
}

/** Katalog przebiegu: dokładnie jedno zapisywalne montowanie, a jego źródłem jest kopia przygotowana przez workflow. */
function workdirMountFailures(mounts) {
  const work = mounts.filter(m => m.mountPoint === WORKDIR);
  if (work.length !== 1 || !work[0].options.includes('rw')) return [`brak jednego zapisywalnego montowania katalogu przebiegu ${WORKDIR}`];
  const source = work[0].root;
  if (!source.endsWith(WORKDIR_SOURCE_SUFFIX)) return [`katalog przebiegu ${WORKDIR} ma źródło ${source}, oczekiwano kopii kończącej się na ${WORKDIR_SOURCE_SUFFIX}`];
  return [];
}

function mountFailures(mounts) {
  const failures = [];
  const roots = mounts.filter(m => m.mountPoint === '/');
  if (roots.length !== 1 || !roots[0].options.includes('ro')) failures.push('system plików główny nie jest tylko do odczytu (albo jest zamontowany więcej niż raz)');
  failures.push(...workdirMountFailures(mounts));
  const seen = new Set();
  for (const m of mounts) {
    if (m.mountPoint === '/' || m.mountPoint === WORKDIR) continue;
    const failure = mountPointFailure(m);
    if (failure) failures.push(failure);
    else if (MOUNT_POLICY[m.mountPoint] && seen.has(m.mountPoint)) failures.push(`punkt montowania ${m.mountPoint} jest zamontowany więcej niż raz`);
    seen.add(m.mountPoint);
  }
  return failures;
}

function envFailures(names, strict) {
  const failures = [];
  const secrets = names.filter(n => SECRET_NAME.test(n));
  if (secrets.length) failures.push(`w otoczeniu są zmienne z poświadczeniami lub GIT_*: ${secrets.length} szt.`);
  if (strict) {
    const unknown = names.filter(n => !ENV_ALLOWED.includes(n) && !SECRET_NAME.test(n));
    if (unknown.length) failures.push(`w otoczeniu są zmienne spoza allowlisty: ${unknown.length} szt.`);
  }
  return failures;
}

/**
 * Ocena faktów: lista odmów (pusta = fakty zgodne z kontraktem). `strictEnv` wymaga, by w otoczeniu
 * były tylko nazwy z allowlisty (proces główny); procesy potomne dostają już zawężone otoczenie.
 */
function evaluate(facts, strictEnv) {
  if (facts.platform !== 'linux') return [`izolacja jest weryfikowana tylko na Linuksie (platforma: ${facts.platform})`];
  const required = ['status', 'mountinfo', 'netDev', 'route'].filter(k => typeof facts[k] !== 'string');
  if (required.length) return [`nie da się odczytać faktów z /proc (${required.join(', ')}): odmowa`];
  const failures = [
    ...privilegeFailures(facts, parseStatus(facts.status)),
    ...networkFailures(facts),
    ...mountFailures(parseMountinfo(facts.mountinfo)),
    ...envFailures(facts.envNames, strictEnv)
  ];
  if (!withinWorkdir(facts.cwd)) failures.push(`bieżący katalog to ${facts.cwd}, oczekiwano ${WORKDIR} albo jego podkatalogu`);
  if (!withinWorkdir(facts.root)) failures.push(`korzeń repozytorium to ${facts.root}, oczekiwano ${WORKDIR} albo jego podkatalogu`);
  return failures;
}

/** Ocena dla procesu głównego: otoczenie tylko z allowlisty. */
const evaluateFacts = facts => evaluate(facts, true);

/** Ocena dla procesów potomnych (np. komend testowych Strykera): otoczenie już zawężone, nazwy poświadczeń nadal zakazane. */
const evaluateChildFacts = facts => evaluate(facts, false);

function refuse(tool, failures, exit) {
  console.error(
    `no-go-izolacja: ${tool} nie startuje mutantów. Mutacje uruchamia się wyłącznie w izolatorze wymuszającym ` +
    'kontrakt #253 (kontener bez sieci, system plików tylko do odczytu, zapis tylko w katalogu przebiegu, ' +
    `nieuprzywilejowany UID, bez poświadczeń), a ten proces go nie spełnia:\n${failures.map(f => `- ${f}`).join('\n')}`
  );
  exit(3);
}

/** Szybka kontrola samych faktów (bez sond czynnych): dla procesów potomnych, np. komend testowych Strykera. */
function requireIsolationFacts(tool, deps = {}) {
  const failures = evaluateChildFacts((deps.readFacts || readFacts)());
  if (failures.length) refuse(tool, failures, deps.exit || process.exit);
}

/**
 * Pełna weryfikacja przed startem mutantów: fakty, a dopiero potem sondy czynne. Gdy fakty są złe, sond
 * czynnych nie uruchamiamy (na nieizolowanej maszynie nie próbujemy niczego zapisywać ani łączyć).
 * Zwraca listę odmów; pusta lista to zgoda.
 */
async function verifyIsolation(deps = {}) {
  let failures;
  try {
    failures = evaluateFacts((deps.readFacts || readFacts)());
    if (failures.length === 0) failures = await (deps.runProbes || require('./isolation-probe.js').runProbes)(deps.probeOptions);
  } catch (error) {
    failures = [`nieoczekiwany błąd weryfikacji izolacji: ${error && error.message}`];
  }
  return failures;
}

/** Bramka dla narzędzi startujących mutanty: kończy proces kodem 3 przy jakiejkolwiek odmowie. */
async function requireIsolation(tool, deps = {}) {
  const failures = await verifyIsolation(deps);
  if (failures.length) refuse(tool, failures, deps.exit || process.exit);
  return failures;
}

module.exports = {
  WORKDIR, MASKED_PATHS, ENV_ALLOWED, SECRET_NAME, readText, interfaceNames, numericId, readFacts, parseStatus, parseMountinfo, parseNetDev,
  routeEntries, evaluateFacts, evaluateChildFacts, requireIsolationFacts, verifyIsolation, requireIsolation
};
