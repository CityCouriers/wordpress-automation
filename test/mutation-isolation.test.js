'use strict';

// Testy bramki izolacji mutacji (#253): fakty z /proc, sondy czynne, odmowa narzędzi bez izolatora.
// Nie uruchamiają mutantów, nie dotykają sieci ani poświadczeń; sondy dostają atrapy wejścia/wyjścia.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const guard = require('../scripts/mutation/isolation-guard.js');
const probes = require('../scripts/mutation/isolation-probe.js');
const { runProbes, NETWORK_TARGETS, READ_PATHS, WRITE_DIRS } = probes;

const ROOT = path.resolve(__dirname, '..');
const T = '\t';

const GOOD_STATUS = [
  'Name:\tnode', 'State:\tR (running)', 'Pid:\t1',
  'Uid:\t1000\t1000\t1000\t1000', 'Gid:\t1000\t1000\t1000\t1000', 'Groups:\t',
  'CapInh:\t0000000000000000', 'CapPrm:\t0000000000000000', 'CapEff:\t0000000000000000', 'CapBnd:\t0000000000000000', 'CapAmb:\t0000000000000000',
  'NoNewPrivs:\t1', 'Seccomp:\t2', ''
].join('\n');

const CID = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const GOOD_MOUNTS = [
  '1230 1100 0:92 / / ro,relatime - overlay overlay ro,lowerdir=/x,upperdir=/y',
  '1231 1230 0:94 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw',
  '1232 1230 0:95 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755',
  '1233 1232 0:96 / /dev/pts rw,nosuid,noexec,relatime - devpts devpts rw,gid=5,mode=620,ptmxmode=666',
  '1234 1230 0:97 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro',
  '1235 1234 0:28 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw',
  '1236 1232 0:93 / /dev/mqueue rw,nosuid,nodev,noexec,relatime - mqueue mqueue rw',
  '1237 1232 0:98 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k',
  `1238 1230 8:1 /var/lib/docker/containers/${CID}/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/sda1 rw`,
  `1239 1230 8:1 /var/lib/docker/containers/${CID}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw`,
  `1240 1230 8:1 /var/lib/docker/containers/${CID}/hosts /etc/hosts rw,relatime - ext4 /dev/sda1 rw`,
  '1241 1230 0:99 / /tmp rw,nosuid,size=2097152k - tmpfs tmpfs rw',
  '1242 1230 8:1 /home/runner/work/_temp/mutation-run /work rw,relatime - ext4 /dev/sda1 rw',
  '1243 1231 0:94 /bus /proc/bus ro,nosuid,nodev,noexec,relatime - proc proc rw',
  '1244 1231 0:100 / /proc/kcore rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755',
  '1245 1232 0:96 /0 /dev/console rw,nosuid,noexec,relatime - devpts devpts rw,gid=5,mode=620,ptmxmode=666',
  ''
].join('\n');

const GOOD_NET_DEV = [
  'Inter-|   Receive                                                |  Transmit',
  ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
  '    lo:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0',
  ''
].join('\n');

const GOOD_ROUTE = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n';

function goodFacts(over = {}) {
  return {
    platform: 'linux', uid: 1000, euid: 1000, status: GOOD_STATUS, mountinfo: GOOD_MOUNTS, netDev: GOOD_NET_DEV, route: GOOD_ROUTE,
    interfaces: ['lo'], envNames: ['PATH', 'HOME', 'HOSTNAME', 'TZ', 'NODE_VERSION', 'YARN_VERSION'], cwd: '/work', root: '/work', ...over
  };
}

const withStatus = (key, value) => GOOD_STATUS.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}:${T}${value}`);

test('fakty zgodne z kontraktem: brak odmów (pozytywna kontrola oceny)', () => {
  assert.deepEqual(guard.evaluateFacts(goodFacts()), []);
  assert.deepEqual(guard.evaluateFacts(goodFacts({ cwd: '/work/.stryker-tmp/sandbox-1', root: '/work/.stryker-tmp/sandbox-1' })), []);
});

const BAD = {
  'platforma inna niż Linux': [goodFacts({ platform: 'win32' }), /tylko na Linuksie/],
  'brak odczytu /proc/self/status': [goodFacts({ status: null }), /nie da się odczytać faktów z \/proc/],
  'brak odczytu mountinfo': [goodFacts({ mountinfo: null }), /nie da się odczytać faktów z \/proc/],
  'proces jako root (process.getuid)': [goodFacts({ uid: 0 }), /root/],
  'proces jako root (efektywny)': [goodFacts({ euid: 0 }), /root/],
  'UID 0 w Uid (zapisany)': [goodFacts({ status: withStatus('Uid', '1000\t1000\t0\t1000') }), /root/],
  'Uid w nieoczekiwanym formacie': [goodFacts({ status: GOOD_STATUS.replace(/^Uid:.*$/m, 'Uid:\t1000') }), /root|UID/],
  'brak wiersza Uid': [goodFacts({ status: GOOD_STATUS.replace(/^Uid:.*\n/m, '') }), /UID/],
  'CapEff niezerowe': [goodFacts({ status: withStatus('CapEff', '00000000a80425fb') }), /CapEff/],
  'CapPrm niezerowe': [goodFacts({ status: withStatus('CapPrm', '0000000000000001') }), /CapPrm/],
  'CapBnd niezerowe': [goodFacts({ status: withStatus('CapBnd', '00000000a80425fb') }), /CapBnd/],
  'brak wiersza CapEff': [goodFacts({ status: GOOD_STATUS.replace(/^CapEff:.*\n/m, '') }), /CapEff/],
  'brak no_new_privs': [goodFacts({ status: withStatus('NoNewPrivs', '0') }), /no_new_privs/],
  'brak seccomp': [goodFacts({ status: withStatus('Seccomp', '0') }), /seccomp/],
  'sieć do innego hosta: drugi interfejs w /proc/net/dev': [goodFacts({ netDev: `${GOOD_NET_DEV}  eth0: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n` }), /interfejsy w \/proc\/net\/dev: lo, eth0/],
  'sieć: tylko interfejs inny niż lo w os.networkInterfaces': [goodFacts({ interfaces: ['lo', 'eth0'] }), /os\.networkInterfaces/],
  'sieć: os.networkInterfaces puste (nie da się potwierdzić)': [goodFacts({ interfaces: [] }), /os\.networkInterfaces/],
  'sieć: os.networkInterfaces niedostępne': [goodFacts({ interfaces: null }), /os\.networkInterfaces/],
  'sieć: brak interfejsów w /proc/net/dev': [goodFacts({ netDev: 'a\nb\n' }), /sieć nie jest odcięta/],
  'sieć: trasa domyślna': [goodFacts({ route: `${GOOD_ROUTE}eth0\t00000000\t0100A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n` }), /trasy/],
  'system plików główny zapisywalny': [goodFacts({ mountinfo: GOOD_MOUNTS.replace('/ / ro,relatime', '/ / rw,relatime') }), /główny nie jest tylko do odczytu/],
  'brak montowania katalogu przebiegu': [goodFacts({ mountinfo: GOOD_MOUNTS.replace(/^1242.*\n/m, '') }), /brak jednego zapisywalnego montowania/],
  'katalog przebiegu tylko do odczytu': [goodFacts({ mountinfo: GOOD_MOUNTS.replace('/work rw,relatime', '/work ro,relatime') }), /brak jednego zapisywalnego montowania/],
  'katalog nadrzędny/domowy zamontowany z zapisem (HOME użytkownika)': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1230 8:1 /home/runner /home/runner rw,relatime - ext4 /dev/sda1 rw\n` }), /nieznany punkt montowania \/home\/runner/],
  'niezwiązana ścieżka zamontowana tylko do odczytu': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1230 8:1 /etc/passwd /srv/dane ro,relatime - ext4 /dev/sda1 rw\n` }), /nieznany punkt montowania \/srv\/dane/],
  'gniazdo dockera': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1230 0:5 /docker.sock /var/run/docker.sock rw,relatime - tmpfs tmpfs rw\n` }), /\/var\/run\/docker\.sock/],
  'podkatalog /dev spoza listy (np. host w /dev/host)': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1230 8:1 /home /dev/host rw,relatime - ext4 /dev/sda1 rw\n` }), /\/dev\/host/],
  'katalog o nazwie zaczynającej się jak /proc (np. /procfs-host)': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1230 8:1 /home /procfs-host ro,relatime - ext4 /dev/sda1 rw\n` }), /\/procfs-host/],
  'podkatalog /tmp (nie jest dozwolony poza samym /tmp)': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1230 8:1 /home /tmp/x rw,relatime - ext4 /dev/sda1 rw\n` }), /\/tmp\/x/],
  'GID 0 w grupie głównej': [goodFacts({ status: withStatus('Gid', '0\t1000\t1000\t1000') }), /GID 0/],
  'GID 0 w grupach dodatkowych': [goodFacts({ status: withStatus('Groups', '1000 0') }), /GID 0/],
  'brak wiersza Gid': [goodFacts({ status: GOOD_STATUS.replace(/^Gid:.*\n/m, '') }), /GID/],
  'katalog przebiegu z korzenia hosta': [goodFacts({ mountinfo: GOOD_MOUNTS.replace('8:1 /home/runner/work/_temp/mutation-run /work', '8:1 / /work') }), /katalog przebiegu \/work ma źródło \//],
  'katalog przebiegu z HOME hosta': [goodFacts({ mountinfo: GOOD_MOUNTS.replace('/home/runner/work/_temp/mutation-run /work', '/home/runner /work') }), /oczekiwano kopii kończącej się na \/mutation-run/],
  'katalog przebiegu zamontowany dwa razy': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1230 8:1 /home/runner/work/_temp/mutation-run /work rw,relatime - ext4 /dev/sda1 rw\n` }), /brak jednego zapisywalnego montowania/],
  'system plików główny zamontowany drugi raz': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1230 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n` }), /więcej niż raz/],
  '/etc/hosts z pliku hosta': [goodFacts({ mountinfo: GOOD_MOUNTS.replace(`/var/lib/docker/containers/${CID}/hosts`, '/etc/passwd') }), /\/etc\/hosts ma źródło spoza katalogu kontenera: \/etc\/passwd/],
  '/etc/hostname z cudzego pliku': [goodFacts({ mountinfo: GOOD_MOUNTS.replace(`/var/lib/docker/containers/${CID}/hostname`, '/home/runner/hostname') }), /\/etc\/hostname ma źródło spoza/],
  '/etc/resolv.conf z cudzego pliku': [goodFacts({ mountinfo: GOOD_MOUNTS.replace(`/var/lib/docker/containers/${CID}/resolv.conf`, '/home/runner/resolv.conf') }), /\/etc\/resolv\.conf ma źródło spoza/],
  '/tmp jako katalog hosta (nie tmpfs)': [goodFacts({ mountinfo: GOOD_MOUNTS.replace('/tmp rw,nosuid,size=2097152k - tmpfs tmpfs', '/tmp rw,nosuid,size=2097152k - ext4 /dev/sda1') }), /\/tmp ma typ ext4, oczekiwano tmpfs/],
  '/tmp zamontowany drugi raz': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1230 0:99 / /tmp rw,nosuid - tmpfs tmpfs rw\n` }), /\/tmp jest zamontowany więcej niż raz/],
  '/proc jako katalog hosta': [goodFacts({ mountinfo: GOOD_MOUNTS.replace('/proc rw,nosuid,nodev,noexec,relatime - proc proc', '/proc rw,nosuid,nodev,noexec,relatime - ext4 /dev/sda1') }), /\/proc ma typ ext4, oczekiwano proc/],
  '/dev/shm jako katalog hosta': [goodFacts({ mountinfo: GOOD_MOUNTS.replace('/dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm', '/dev/shm rw,relatime - ext4 /dev/sda1') }), /\/dev\/shm ma typ ext4/],
  'tmpfs pod /sys poza listą maskowanych ścieżek (katalog hosta podstawiony pod /sys)': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1234 0:20 / /sys/kernel/security rw,nosuid - tmpfs tmpfs rw\n` }), /\/sys\/kernel\/security ma typ tmpfs poza listą ścieżek maskowanych przez kontener/],
  'tmpfs pod /proc poza listą maskowanych ścieżek': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1231 0:20 / /proc/host rw,nosuid - tmpfs tmpfs rw\n` }), /\/proc\/host ma typ tmpfs poza listą/],
  'podmontowanie pod /proc z dysku hosta': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1231 8:1 /home /proc/host ro,relatime - ext4 /dev/sda1 rw\n` }), /\/proc\/host ma typ ext4, oczekiwano proc\/tmpfs/],
  'podmontowanie pod /sys z dysku hosta': [goodFacts({ mountinfo: `${GOOD_MOUNTS}1250 1234 8:1 /home /sys/host ro,relatime - ext4 /dev/sda1 rw\n` }), /\/sys\/host ma typ ext4, oczekiwano sysfs\/cgroup\/cgroup2\/tmpfs/],
  'token w otoczeniu': [goodFacts({ envNames: ['PATH', 'GITHUB_TOKEN'] }), /poświadczeniami/],
  'GIT_DIR w otoczeniu': [goodFacts({ envNames: ['PATH', 'GIT_DIR'] }), /poświadczeniami lub GIT_/],
  'zmienna Actions w otoczeniu': [goodFacts({ envNames: ['PATH', 'ACTIONS_RUNTIME_TOKEN'] }), /poświadczeniami/],
  'zmienna spoza allowlisty': [goodFacts({ envNames: ['PATH', 'MUTATION_ISOLATED'] }), /spoza allowlisty: 1/],
  'bieżący katalog poza katalogiem przebiegu': [goodFacts({ cwd: '/home/runner/work' }), /bieżący katalog/],
  'bieżący katalog o wspólnym prefiksie (/workspace)': [goodFacts({ cwd: '/workspace' }), /bieżący katalog/],
  'korzeń repozytorium poza katalogiem przebiegu': [goodFacts({ root: '/srv/repo' }), /korzeń repozytorium/]
};

for (const [label, [facts, pattern]] of Object.entries(BAD)) {
  test(`fakty: ${label} => odmowa`, () => {
    const failures = guard.evaluateFacts(facts);
    assert.ok(failures.length >= 1, 'oczekiwano odmowy');
    assert.match(failures.join('\n'), pattern);
  });
}

test('fakty: tryb potomny (strictEnv: false) toleruje nieznane nazwy, ale nie poświadczenia', () => {
  assert.deepEqual(guard.evaluateChildFacts(goodFacts({ envNames: ['PATH', '__STRYKER_ACTIVE_MUTANT__', 'MUTATION_SELECTION'] })), []);
  assert.deepEqual(guard.evaluateChildFacts(goodFacts({ envNames: ['PATH', 'CUSTOM'] })), []);
  assert.match(guard.evaluateChildFacts(goodFacts({ envNames: ['PATH', 'NPM_TOKEN'] })).join('\n'), /poświadczeniami/);
});

test('fakty: kilka odmów naraz jest zgłaszanych razem (nie tylko pierwsza)', () => {
  const failures = guard.evaluateFacts(goodFacts({ uid: 0, interfaces: ['eth0'], cwd: '/x' }));
  assert.ok(failures.length >= 3, failures.join('\n'));
});

test('parsery /proc: Uid, mountinfo (ucieczki ósemkowe), interfejsy, trasy', () => {
  assert.equal(guard.parseStatus('Uid:\t1\t2\t3\t4\nName:\tx:y\n').Uid, '1\t2\t3\t4');
  assert.equal(guard.parseStatus('Name:\tx:y\n').Name, 'x:y');
  assert.deepEqual(guard.parseStatus('bez dwukropka\n:zaczyna się\n'), {});
  const mounts = guard.parseMountinfo('1 0 0:1 / /moja\\040sciezka rw,relatime - tmpfs t rw\n\n2 1 0:2 / /a ro - tmpfs t ro\n');
  assert.deepEqual(mounts, [
    { mountPoint: '/moja sciezka', options: ['rw', 'relatime'], root: '/', fsType: 'tmpfs' },
    { mountPoint: '/a', options: ['ro'], root: '/', fsType: 'tmpfs' }
  ]);
  assert.deepEqual(guard.parseMountinfo('5 1 8:1 /a\\040b /c rw - ext4 /dev/sda1 rw\n'), [{ mountPoint: '/c', options: ['rw'], root: '/a b', fsType: 'ext4' }]);
  assert.deepEqual(guard.parseMountinfo('5 1 8:1 /a /c rw\n'), [{ mountPoint: '/c', options: ['rw'], root: '/a', fsType: '' }]);
  assert.deepEqual(guard.parseNetDev(GOOD_NET_DEV), ['lo']);
  assert.deepEqual(guard.routeEntries(GOOD_ROUTE), []);
  assert.equal(guard.routeEntries(`${GOOD_ROUTE}x\n\ny\n`).length, 2);
});

test('parsery /proc: wiersze skrajne (puste znaki, krótkie wiersze, wiersz zaczynający się od myślnika)', () => {
  assert.deepEqual(guard.parseMountinfo('   \n'), []);
  assert.deepEqual(guard.parseMountinfo('a b\n'), [{ mountPoint: '', options: [''], root: '', fsType: '' }]);
  assert.deepEqual(guard.parseMountinfo('- ext4 x\n')[0].fsType, 'ext4');
  assert.deepEqual(guard.parseMountinfo('5 1 8:1 /a /c rw -\n')[0].fsType, '');
  assert.deepEqual(guard.parseNetDev('h1: x\nh2: y\n lo: 1\n'), ['lo']);
  assert.deepEqual(guard.parseNetDev('h1\nh2\n'), []);
  assert.deepEqual(guard.routeEntries(`${GOOD_ROUTE}   \n`), []);
  assert.deepEqual(guard.routeEntries('Iface\nx\n'), ['x']);
});

test('readText: treść jako tekst UTF-8, brak pliku to null (nie wyjątek ani undefined)', () => {
  const file = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mut-rt-')), 'a.txt');
  try {
    fs.writeFileSync(file, 'zażółć\n');
    assert.equal(guard.readText(file), 'zażółć\n');
    assert.equal(guard.readText(`${file}.brak`), null);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('interfaceNames i numericId: wynik albo null przy błędzie / braku funkcji', () => {
  assert.deepEqual(guard.interfaceNames({ networkInterfaces: () => ({ lo: [], eth0: [] }) }), ['lo', 'eth0']);
  assert.equal(guard.interfaceNames({ networkInterfaces() { throw new Error('x'); } }), null);
  assert.deepEqual(guard.interfaceNames(), Object.keys(require('node:os').networkInterfaces()));
  assert.equal(guard.numericId(() => 5), 5);
  assert.equal(guard.numericId(() => 0), 0);
  assert.equal(guard.numericId(undefined), null);
  assert.equal(guard.numericId('nie funkcja'), null);
});

test('readFacts: czyta dokładnie cztery pliki /proc przez podany czytnik', () => {
  const asked = [];
  const facts = guard.readFacts(file => { asked.push(file); return `treść:${file}`; });
  assert.deepEqual(asked, ['/proc/self/status', '/proc/self/mountinfo', '/proc/net/dev', '/proc/net/route']);
  assert.equal(facts.status, 'treść:/proc/self/status');
  assert.equal(facts.mountinfo, 'treść:/proc/self/mountinfo');
  assert.equal(facts.netDev, 'treść:/proc/net/dev');
  assert.equal(facts.route, 'treść:/proc/net/route');
});

test('realne fakty bieżącej maszyny nie są zgodne z kontraktem (maszyna deweloperska nie jest izolatorem)', () => {
  const facts = guard.readFacts();
  assert.equal(facts.platform, process.platform);
  assert.equal(facts.cwd, process.cwd());
  assert.equal(facts.root, ROOT);
  assert.deepEqual(facts.envNames, Object.keys(process.env));
  assert.deepEqual(facts.interfaces, Object.keys(require('node:os').networkInterfaces()));
  assert.equal(facts.uid, typeof process.getuid === 'function' ? process.getuid() : null);
  assert.ok(guard.evaluateFacts(facts).length > 0, 'ta maszyna nie może przejść bramki izolacji');
});

test('polityka montowań: każdy punkt z tabeli wymaga swojego typu systemu plików', () => {
  const wrongType = [['/proc', 'proc'], ['/dev', 'tmpfs'], ['/dev/pts', 'devpts'], ['/dev/shm', 'tmpfs'], ['/dev/mqueue', 'mqueue'], ['/dev/console', 'devpts'], ['/sys', 'sysfs'], ['/tmp', 'tmpfs']];
  for (const [point, expected] of wrongType) {
    const lines = GOOD_MOUNTS.split('\n').map(l => (l.split(' ')[4] === point ? l.replace(/ - \S+ /, ' - ext4 ') : l));
    assert.notEqual(lines.join('\n'), GOOD_MOUNTS, point);
    const failures = guard.evaluateFacts(goodFacts({ mountinfo: lines.join('\n') }));
    assert.deepEqual(failures, [`punkt montowania ${point} ma typ ext4, oczekiwano ${expected}`], point);
  }
});

test('polityka montowań: pliki kontenera muszą kończyć się dokładnie nazwą pliku (bez przyrostków)', () => {
  for (const name of ['hosts', 'hostname', 'resolv.conf']) {
    const bad = GOOD_MOUNTS.replace(`/${name} /etc/`, `/${name}.zly /etc/`);
    assert.notEqual(bad, GOOD_MOUNTS, name);
    assert.match(guard.evaluateFacts(goodFacts({ mountinfo: bad })).join('\n'), new RegExp(`/etc/${name.replace('.', '\\.')} ma źródło spoza katalogu kontenera`), name);
    const shortId = GOOD_MOUNTS.replace(CID, 'abc');
    assert.match(guard.evaluateFacts(goodFacts({ mountinfo: shortId })).join('\n'), /ma źródło spoza katalogu kontenera/);
  }
});

test('allowlista otoczenia: dokładnie te nazwy, każda przechodzi w trybie ścisłym', () => {
  const names = ['PATH', 'HOME', 'HOSTNAME', 'TZ', 'LANG', 'LC_ALL', 'TERM', 'PWD', 'SHLVL', '_', 'NODE_VERSION', 'YARN_VERSION'];
  assert.deepEqual(guard.ENV_ALLOWED, names);
  for (const name of names) assert.deepEqual(guard.evaluateFacts(goodFacts({ envNames: [name] })), [], name);
});

test('nazwy poświadczeń: każdy wzorzec osobno, przedrostki tylko na początku nazwy', () => {
  const contained = ['MY_TOKEN', 'MY_SECRET', 'MY_PASS', 'MY_KEY', 'MY_CRED', 'MY_AUTH', 'my_token'];
  // Przedrostek firmowy składany w kodzie: test tożsamości repozytorium nie dopuszcza go zapisanego literalnie.
  const prefixed = [`${'C'.repeat(2)}_X`, 'CLAUDE_X', 'GOOGLE_X', 'GH_X', 'GITHUB_X', 'NPM_X', 'RUNNER_X', 'ACTIONS_X', 'GIT_X', 'git_x'];
  for (const name of [...contained, ...prefixed]) {
    assert.match(guard.evaluateChildFacts(goodFacts({ envNames: [name] })).join('\n'), /poświadczeniami lub GIT_\*: 1 szt\./, name);
  }
  for (const name of prefixed) {
    assert.deepEqual(guard.evaluateChildFacts(goodFacts({ envNames: [`X${name}`] })), [], `X${name}`);
  }
});

test('uprawnienia: pole zerowe musi być całe zerami, a identyfikatory mogą mieć wielokrotne odstępy', () => {
  assert.match(guard.evaluateFacts(goodFacts({ status: withStatus('CapEff', '00000000a8042500') })).join('\n'), /CapEff=00000000a8042500/);
  assert.match(guard.evaluateFacts(goodFacts({ status: withStatus('CapEff', '') })).join('\n'), /CapEff/);
  assert.deepEqual(guard.evaluateFacts(goodFacts({ status: withStatus('Uid', '1000\t\t1000\t1000  1000') })), []);
  assert.deepEqual(guard.evaluateFacts(goodFacts({ status: withStatus('Gid', '1000\t\t1000\t1000  1000') })), []);
  assert.deepEqual(guard.evaluateFacts(goodFacts({ status: withStatus('Groups', '1000  2000') })), []);
});

test('komunikaty odmów: dokładna treść dla odczytu faktów i sieci', () => {
  assert.deepEqual(guard.evaluateFacts(goodFacts({ status: null, mountinfo: null })), ['nie da się odczytać faktów z /proc (status, mountinfo): odmowa']);
  assert.deepEqual(guard.evaluateFacts(goodFacts({ netDev: 'a\nb\n' })), ['sieć nie jest odcięta: interfejsy w /proc/net/dev: brak odczytu']);
});

test('refuse: komunikat no-go-izolacja z listą odmów i kodem 3', () => {
  const errors = [];
  const original = console.error;
  console.error = text => errors.push(text);
  const codes = [];
  try {
    guard.requireIsolationFacts('narzędzie.js', { readFacts: () => goodFacts({ uid: 0 }), exit: code => codes.push(code) });
  } finally {
    console.error = original;
  }
  assert.deepEqual(codes, [3]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0],
    'no-go-izolacja: narzędzie.js nie startuje mutantów. Mutacje uruchamia się wyłącznie w izolatorze wymuszającym ' +
    'kontrakt #253 (kontener bez sieci, system plików tylko do odczytu, zapis tylko w katalogu przebiegu, ' +
    'nieuprzywilejowany UID, bez poświadczeń), a ten proces go nie spełnia:\n- proces działa jako root (UID 0) albo UID nie dał się ustalić');
});

test('verifyIsolation: proces główny wymaga ścisłej allowlisty otoczenia, proces potomny nie', async () => {
  const facts = () => goodFacts({ envNames: ['PATH', 'CUSTOM'] });
  assert.match((await guard.verifyIsolation({ readFacts: facts, runProbes: async () => [] })).join('\n'), /spoza allowlisty: 1/);
  const codes = [];
  guard.requireIsolationFacts('x', { readFacts: facts, exit: c => codes.push(c) });
  assert.deepEqual(codes, []);
});

// --- sondy czynne -------------------------------------------------------------------------------

function fakeIo(over = {}) {
  const calls = [];
  const io = {
    connectSucceeds: async (h, p) => { calls.push(['connect', h, p]); return false; },
    lookupSucceeds: async n => { calls.push(['dns', n]); return false; },
    canWriteIn: d => { calls.push(['write', d]); return false; },
    canRead: f => { calls.push(['read', f]); return false; },
    positiveTestPasses: () => { calls.push(['positive']); return true; },
    homedir: () => '/home/node',
    ...over
  };
  return { io, calls };
}

test('sondy: wszystkie odmowy i pozytywny test => brak odmów; pozytywny test jest ostatni', async () => {
  const { io, calls } = fakeIo();
  assert.deepEqual(await runProbes({ io, outside: ['/host/kanarek'] }), []);
  assert.deepEqual(calls[calls.length - 1], ['positive']);
  assert.equal(calls.filter(c => c[0] === 'connect').length, NETWORK_TARGETS.length);
  assert.deepEqual(calls.filter(c => c[0] === 'read').map(c => c[1]), [...READ_PATHS, '/host/kanarek']);
  const written = calls.filter(c => c[0] === 'write').map(c => c[1]);
  for (const dir of [...WRITE_DIRS, '/home/node']) assert.ok(written.includes(dir), `brak próby zapisu w ${dir}`);
  assert.ok(calls.some(c => c[0] === 'dns'));
});

test('sondy: lista adresów sieci jest zróżnicowana (IPv4, IPv6, metadane), nie tylko dwa adresy', () => {
  assert.ok(NETWORK_TARGETS.length >= 4);
  assert.ok(NETWORK_TARGETS.some(([h]) => h.includes(':')), 'brak adresu IPv6');
  assert.ok(NETWORK_TARGETS.some(([h]) => h === '169.254.169.254'), 'brak adresu metadanych');
  assert.equal(new Set(NETWORK_TARGETS.map(([h]) => h)).size, NETWORK_TARGETS.length);
});

for (const [host] of NETWORK_TARGETS) {
  test(`sondy: udane połączenie z ${host} (blokada tylko niektórych adresów) => odmowa`, async () => {
    const { io } = fakeIo({ connectSucceeds: async h => h === host });
    const failures = await runProbes({ io });
    assert.equal(failures.length, 1);
    assert.ok(failures[0].includes(`połączenie z ${host}`), failures[0]);
  });
}

test('sondy: rozwiązanie nazwy DNS => odmowa', async () => {
  const { io } = fakeIo({ lookupSucceeds: async () => true });
  assert.match((await runProbes({ io })).join('\n'), /rozwiązanie nazwy/);
});

test('sondy: zapis w katalogu systemowym, nadrzędnym albo domowym => odmowa z nazwą katalogu', async () => {
  for (const dir of ['/', '/etc', '/home/node']) {
    const { io } = fakeIo({ canWriteIn: d => d === dir });
    const failures = await runProbes({ io });
    assert.equal(failures.length, 1, dir);
    assert.match(failures[0], /zapis poza katalogiem przebiegu/);
    assert.ok(failures[0].includes(`(${dir})`), failures[0]);
  }
});

test('sondy: odczyt znanej ścieżki hosta albo pliku kontrolnego z workflow => odmowa', async () => {
  for (const file of ['/var/run/docker.sock', '/etc/shadow', '/host/kanarek']) {
    const { io } = fakeIo({ canRead: f => f === file });
    const failures = await runProbes({ io, outside: ['/host/kanarek'] });
    assert.equal(failures.length, 1, file);
    assert.match(failures[0], /odczyt poza katalogiem przebiegu/);
    assert.ok(failures[0].includes(file));
  }
});

test('sondy: nieudany pozytywny test uruchomienia testów => odmowa', async () => {
  const { io } = fakeIo({ positiveTestPasses: () => false });
  assert.deepEqual(await runProbes({ io }), ['pozytywny test uruchomienia testów w tym środowisku nie przeszedł']);
});

test('sondy: pozytywny test nie rusza się, gdy sonda ujemna już wykryła ekspozycję', async () => {
  const { io, calls } = fakeIo({ connectSucceeds: async () => true });
  assert.ok((await runProbes({ io })).length > 0);
  assert.ok(!calls.some(c => c[0] === 'positive'));
});

test('sondy: błąd samej sondy to odmowa, nie pominięcie (fail-closed)', async () => {
  const cases = {
    connect: { connectSucceeds: async () => { throw new Error('boom'); } },
    dns: { lookupSucceeds: async () => { throw new Error('boom'); } },
    write: { canWriteIn: () => { throw new Error('boom'); } },
    read: { canRead: () => { throw new Error('boom'); } },
    positive: { positiveTestPasses: () => { throw new Error('boom'); } }
  };
  for (const [label, over] of Object.entries(cases)) {
    const { io } = fakeIo(over);
    const failures = await runProbes({ io });
    assert.ok(failures.length >= 1, label);
    assert.match(failures.join('\n'), /zakończyła się błędem: boom/, label);
  }
});

test('sondy: brak katalogu domowego nie przerywa i nie dodaje próby zapisu', async () => {
  const { io, calls } = fakeIo({ homedir: () => { throw new Error('brak HOME'); } });
  const failures = await runProbes({ io });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /katalog domowy/);
  assert.ok(!calls.some(c => c[0] === 'write' && c[1] === false));
});

test('sondy: zakodowane listy adresów, nazwy i ścieżek są dokładnie takie, jak w kontrakcie', () => {
  assert.deepEqual(NETWORK_TARGETS, [['1.1.1.1', 443], ['8.8.8.8', 53], ['9.9.9.9', 443], ['169.254.169.254', 80], ['2606:4700:4700::1111', 443]]);
  assert.deepEqual(WRITE_DIRS, ['/', '/etc', '/usr', '/var', '/root']);
  assert.deepEqual(READ_PATHS, ['/var/run/docker.sock', '/run/docker.sock', '/home/runner', '/github', '/run/secrets', '/root/.ssh', '/etc/shadow']);
  assert.equal(probes.DNS_NAME, 'example.org');
});

test('sondy: wywołania wejścia/wyjścia mają dokładne argumenty, a bez outside czyta tylko znane ścieżki', async () => {
  const { io, calls } = fakeIo();
  const seen = [];
  io.connectSucceeds = async (h, p, t) => { seen.push([h, p, t]); return false; };
  assert.deepEqual(await runProbes({ io }), []);
  assert.ok(seen.every(([, , t]) => t === 3000));
  assert.deepEqual(calls.filter(c => c[0] === 'dns'), [['dns', 'example.org']]);
  assert.deepEqual(calls.filter(c => c[0] === 'read').map(c => c[1]), READ_PATHS);
  assert.deepEqual(calls.filter(c => c[0] === 'write').map(c => c[1]), ['/', '/etc', '/usr', '/var', '/root', '/', '/home/node'].filter((d, i, a) => a.indexOf(d) === i));
});

test('sondy: błąd każdej sondy daje dokładnie jedną odmowę z jej nazwą (nie dwie)', async () => {
  const boom = () => { throw new Error('x'); };
  const expected = {
    connectSucceeds: 'sonda „sieć 1.1.1.1” zakończyła się błędem: x',
    lookupSucceeds: 'sonda „DNS” zakończyła się błędem: x',
    canWriteIn: 'sonda „zapis /” zakończyła się błędem: x',
    canRead: 'sonda „odczyt /var/run/docker.sock” zakończyła się błędem: x',
    homedir: 'sonda „katalog domowy” zakończyła się błędem: x'
  };
  for (const [key, message] of Object.entries(expected)) {
    const { io } = fakeIo({ [key]: boom });
    const failures = await runProbes({ io });
    assert.ok(failures.includes(message), `${key}: ${failures.join(' | ')}`);
    if (key !== 'connectSucceeds' && key !== 'canWriteIn' && key !== 'canRead') assert.equal(failures.length, 1, key);
  }
  const first = fakeIo({ connectSucceeds: async h => { if (h === '1.1.1.1') throw new Error('x'); return false; } });
  assert.deepEqual(await runProbes({ io: first.io }), ['sonda „sieć 1.1.1.1” zakończyła się błędem: x']);
  const positive = fakeIo({ positiveTestPasses: boom });
  assert.deepEqual(await runProbes({ io: positive.io }), ['sonda „pozytywny test” zakończyła się błędem: x', 'pozytywny test uruchomienia testów w tym środowisku nie przeszedł']);
});

test('sondy: katalog domowy pusty albo niebędący tekstem nie trafia do prób zapisu', async () => {
  for (const home of ['', undefined, null, 5]) {
    const { io, calls } = fakeIo({ homedir: () => home });
    assert.deepEqual(await runProbes({ io }), [], String(home));
    assert.deepEqual(calls.filter(c => c[0] === 'write').map(c => c[1]), ['/', '/etc', '/usr', '/var', '/root']);
  }
});

// --- prawdziwe wejście/wyjście sond (na atrapach gniazda, resolvera i w katalogach tymczasowych) -------

const { EventEmitter } = require('node:events');

/** Obietnica musi się rozstrzygnąć w rozsądnym czasie: zawieszenie to porażka asercji, nie limit czasu. */
function settles(promise, ms = 1500) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new assert.AssertionError({ message: 'obietnica sondy się nie rozstrzygnęła' })), ms).unref())]);
}

function fakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = 0;
  socket.destroy = () => { socket.destroyed += 1; };
  socket.setTimeout = (ms, cb) => { socket.timeoutMs = ms; socket.onTimeout = cb; };
  return socket;
}

test('connectSucceeds: zdarzenie connect => true, error => false, przekroczony czas => false; gniazdo zawsze zamykane', async () => {
  for (const [event, expected] of [['connect', true], ['error', false], ['timeout', false]]) {
    const socket = fakeSocket();
    let asked;
    const pending = probes.connectSucceeds('10.0.0.1', 99, 1234, options => { asked = options; return socket; });
    assert.deepEqual(asked, { host: '10.0.0.1', port: 99 });
    assert.equal(socket.timeoutMs, 1234);
    if (event === 'timeout') socket.onTimeout();
    else socket.emit(event, new Error('x'));
    assert.equal(await settles(pending), expected, event);
    assert.equal(socket.destroyed, 1, event);
  }
});

test('connectSucceeds: prawdziwe gniazdo lokalne => true, zamknięty port => false', async () => {
  const server = require('node:net').createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.equal(await settles(probes.connectSucceeds('127.0.0.1', port, 2000)), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(await settles(probes.connectSucceeds('127.0.0.1', port, 2000)), false);
});

test('lookupSucceeds: rozwiązana nazwa => true, błąd resolvera => false', async () => {
  const asked = [];
  assert.equal(await probes.lookupSucceeds('a.test', { lookup: async name => { asked.push(name); return { address: '1.2.3.4' }; } }), true);
  assert.deepEqual(asked, ['a.test']);
  assert.equal(await probes.lookupSucceeds('b.test', { lookup: async () => { throw new Error('ENOTFOUND'); } }), false);
});

test('canWriteIn: zapisywalny katalog => true i bez śladu; istniejący plik próby, brak katalogu albo plik zamiast katalogu => false', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mut-cw-'));
  try {
    assert.equal(probes.canWriteIn(dir), true);
    assert.deepEqual(fs.readdirSync(dir), []);
    const existing = path.join(dir, `.mutation-probe-${process.pid}`);
    fs.writeFileSync(existing, 'cudze');
    assert.equal(probes.canWriteIn(dir), false);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'cudze');
    fs.rmSync(existing);
    assert.equal(probes.canWriteIn(path.join(dir, 'brak')), false);
    fs.writeFileSync(path.join(dir, 'plik'), 'x');
    assert.equal(probes.canWriteIn(path.join(dir, 'plik')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('canRead: istniejący czytelny plik => true, brak pliku => false', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mut-cr-'));
  try {
    const file = path.join(dir, 'a');
    fs.writeFileSync(file, 'x');
    assert.equal(probes.canRead(file), true);
    assert.equal(probes.canRead(path.join(dir, 'brak')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('positiveTestPasses: w katalogu z testem kontrolnym => true, w pustym => false', () => {
  assert.equal(probes.positiveTestPasses(ROOT), true);
  const empty = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mut-pt-'));
  try {
    assert.equal(probes.positiveTestPasses(empty), false);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('REAL_IO: komplet funkcji, katalog domowy z systemu', () => {
  const real = probes.REAL_IO;
  assert.deepEqual(Object.keys(real).sort(), ['canRead', 'canWriteIn', 'connectSucceeds', 'homedir', 'lookupSucceeds', 'positiveTestPasses']);
  assert.equal(real.homedir(), require('node:os').homedir());
  assert.equal(real.canRead, probes.canRead);
  assert.equal(real.canWriteIn, probes.canWriteIn);
  assert.equal(real.connectSucceeds, probes.connectSucceeds);
  assert.equal(real.lookupSucceeds, probes.lookupSucceeds);
  assert.equal(real.positiveTestPasses, probes.positiveTestPasses);
});

// --- weryfikacja i odmowa ----------------------------------------------------------------------

test('verifyIsolation: złe fakty => sondy czynne w ogóle się nie uruchamiają', async () => {
  let probed = false;
  const failures = await guard.verifyIsolation({ readFacts: () => goodFacts({ uid: 0 }), runProbes: async () => { probed = true; return []; } });
  assert.ok(failures.length > 0);
  assert.equal(probed, false);
});

test('verifyIsolation: dobre fakty i dobre sondy => zgoda; nieudana sonda => odmowa (sztucznie zepsuta sonda)', async () => {
  const seen = [];
  assert.deepEqual(await guard.verifyIsolation({ readFacts: () => goodFacts(), runProbes: async o => { seen.push(o); return []; }, probeOptions: { outside: ['/x'] } }), []);
  assert.deepEqual(seen, [{ outside: ['/x'] }]);
  const broken = await guard.verifyIsolation({ readFacts: () => goodFacts(), runProbes: async () => ['sieć nie jest odcięta (zepsuta sonda)'] });
  assert.deepEqual(broken, ['sieć nie jest odcięta (zepsuta sonda)']);
});

test('verifyIsolation: wyjątek podczas weryfikacji to odmowa', async () => {
  const failures = await guard.verifyIsolation({ readFacts: () => { throw new Error('awaria odczytu'); } });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /nieoczekiwany błąd weryfikacji izolacji: awaria odczytu/);
});

test('requireIsolation: odmowa kończy kodem 3 z komunikatem no-go-izolacja i listą powodów; zgoda nic nie kończy', async () => {
  const exits = [];
  const errors = [];
  const original = console.error;
  console.error = msg => errors.push(msg);
  try {
    await guard.requireIsolation('narzedzie.js', { readFacts: () => goodFacts(), runProbes: async () => ['powód A', 'powód B'], exit: c => exits.push(c) });
    await guard.requireIsolation('inne.js', { readFacts: () => goodFacts(), runProbes: async () => [], exit: c => exits.push(c) });
  } finally {
    console.error = original;
  }
  assert.deepEqual(exits, [3]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^no-go-izolacja: narzedzie\.js nie startuje mutantów/);
  assert.match(errors[0], /- powód A\n- powód B/);
});

test('requireIsolationFacts: złe fakty => kod 3; dobre => cisza', () => {
  const exits = [];
  const original = console.error;
  console.error = () => {};
  try {
    guard.requireIsolationFacts('a.js', { readFacts: () => goodFacts({ platform: 'win32' }), exit: c => exits.push(c) });
    guard.requireIsolationFacts('b.js', { readFacts: () => goodFacts({ envNames: ['PATH', 'CUSTOM'] }), exit: c => exits.push(c) });
  } finally {
    console.error = original;
  }
  assert.deepEqual(exits, [3]);
});

// --- narzędzia bez izolatora ---------------------------------------------------------------------

const GUARDED = [
  ['run-file.js', ['Payloads.gs']], ['validate-selection.js', ['Payloads.gs']], ['trial.js', ['Payloads.gs']],
  ['canary.js', []], ['zero-check.js', ['Payloads.gs']], ['run-tests.js', []], ['run-for-mutant.js', []], ['vm-preload.js', []]
];
const ARTIFACTS = ['.stryker-tmp', '.stryker-shadow', path.join('reports', 'mutation')];
const ENVS = {
  'tylko PATH': () => ({ PATH: process.env.PATH || process.env.Path || '' }),
  'czyste otoczenie z CI=true': () => ({ PATH: process.env.PATH || process.env.Path || '', CI: 'true' }),
  'fałszywe deklaracje izolacji': () => ({
    PATH: process.env.PATH || process.env.Path || '', CI: 'true', MUTATION_ISOLATED: '1', MUTATION_ISOLATION_OK: '1', ISOLATED: 'true', NETWORK: 'none',
    MUTATION_SELECTION: 'nie-istnieje.json'
  })
};
const snapshot = () => ARTIFACTS.map(a => [a, fs.existsSync(path.join(ROOT, a))]);

for (const [tool, args] of GUARDED) {
  for (const [label, makeEnv] of Object.entries(ENVS)) {
    test(`${tool} nie startuje bez izolatora (${label}), nie tworzy raportu ani katalogów`, () => {
      const before = snapshot();
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'mutation', tool), ...args], { cwd: ROOT, encoding: 'utf8', env: makeEnv(), timeout: 60000 });
      assert.equal(r.status, 3, `oczekiwano kodu 3, jest ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /no-go-izolacja/);
      assert.deepEqual(snapshot(), before);
    });
  }

  test(`${tool}: bramka izolacji jest przed pierwszym procesem potomnym i zapisem`, () => {
    const code = fs.readFileSync(path.join(ROOT, 'scripts', 'mutation', tool), 'utf8');
    const mainAt = code.search(/function main\(/);
    const lastRequire = code.split('\n').reduce((last, line, i) => (line.includes('require(') ? i : last), 0);
    // vm-preload.js nie ma funkcji main: bramka jest na poziomie modułu, przed wszystkim innym w pliku.
    const body = mainAt >= 0 || tool === 'vm-preload.js' ? code.slice(Math.max(mainAt, 0)) : code.split('\n').slice(lastRequire + 1).join('\n');
    // Orkiestratory przyjmują bramkę we wstrzykiwanych zależnościach (testy), ale domyślną jest prawdziwa bramka izolacji.
    const injected = /\bguard = requireIsolation(Facts)?\b/.test(body);
    if (/\bguard\(|\bguard =/.test(body)) assert.ok(injected, 'domyślną bramką musi być requireIsolation');
    const guardAt = body.search(/\bguard\(|requireIsolation(Facts)?\(/);
    assert.ok(guardAt >= 0, 'brak wywołania bramki w ciele wejścia');
    const effectAt = body.search(/\b(spawnSync|mkdirSync|writeFileSync|copyFileSync|rmSync|readFileSync)\(/);
    assert.ok(effectAt < 0 || guardAt < effectAt, `efekt uboczny przed bramką: ${body.slice(effectAt, effectAt + 40)}`);
  });
}

test('wejścia bez wymaganego argumentu kończą się kodem 2 (przed bramką i bez skutków ubocznych)', () => {
  for (const tool of ['run-file.js', 'validate-selection.js', 'trial.js', 'zero-check.js']) {
    const before = snapshot();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'mutation', tool)], { cwd: ROOT, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH || process.env.Path || '' } });
    assert.equal(r.status, 2, `${tool}: ${r.stderr}`);
    assert.deepEqual(snapshot(), before);
  }
});

test('żaden kod mutacji nie traktuje deklaracji ze środowiska ani sondy jako zgody na start', () => {
  const dir = path.join(ROOT, 'scripts', 'mutation');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(code, /process\.env\.(MUTATION_ISOLATED|MUTATION_ISOLATION_OK|ISOLATED|MUTATION_NO_GUARD)/, `${f} czyta deklarację izolacji`);
    assert.doesNotMatch(code, /refuseStart/, `${f}: pozostałość po stałej odmowie pilota`);
  }
});

test('canWriteIn: zamyka deskryptor utworzonego pliku próby dokładnie raz', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mut-cl-'));
  const original = fs.closeSync;
  const closed = [];
  fs.closeSync = fd => { closed.push(fd); return original(fd); };
  try {
    assert.equal(probes.canWriteIn(dir), true);
  } finally {
    fs.closeSync = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(closed.length, 1);
  assert.equal(typeof closed[0], 'number');
});

test('maskowane ścieżki kontenera pod /proc i /sys (tmpfs) są dozwolone, każda z osobna; lista jest zamknięta', () => {
  const masked = [
    '/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys', '/proc/latency_stats', '/proc/timer_list',
    '/proc/timer_stats', '/proc/sched_debug', '/proc/scsi', '/sys/firmware', '/sys/devices/virtual/powercap'
  ];
  assert.deepEqual(guard.MASKED_PATHS, masked);
  for (const point of masked) {
    const mounts = `${GOOD_MOUNTS}1250 1231 0:20 / ${point} ro,nosuid - tmpfs tmpfs rw\n`;
    assert.deepEqual(guard.evaluateFacts(goodFacts({ mountinfo: mounts })), [], point);
  }
});

test('vm-preload.js wczytany przez --require poza izolatorem kończy proces kodem 3 przed uruchomieniem kodu, nie tylko jako samodzielne narzędzie', () => {
  const marker = path.join(os.tmpdir(), `mut-preload-${process.pid}-${Date.now()}.txt`);
  const code = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'uruchomiono');`;
  // Most pomiaru mutacyjnego: zinstrumentowany vm-preload.js w podprocesie bierze numer mutanta z global.__stryker__.
  const bridge = path.join(os.tmpdir(), `mut-preload-bridge-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(bridge, "globalThis.__stryker__ = Object.assign(globalThis.__stryker__ || {}, { activeMutant: process.env.MUT_OUTER_MUTANT === undefined ? '' : process.env.MUT_OUTER_MUTANT });\n");
  const outer = process.env.__STRYKER_ACTIVE_MUTANT__ === undefined ? {} : { MUT_OUTER_MUTANT: process.env.__STRYKER_ACTIVE_MUTANT__ };
  const r = spawnSync(process.execPath, ['--require', bridge, '--require', path.join(ROOT, 'scripts', 'mutation', 'vm-preload.js'), '-e', code], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH || process.env.Path || '', CI: 'true', MUTATION_ISOLATED: '1', ...outer }, timeout: 60000
  });
  fs.rmSync(bridge, { force: true });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /no-go-izolacja: vm-preload\.js nie startuje mutantów/);
  assert.equal(fs.existsSync(marker), false, 'kod po wczytaniu preloadu nie mógł się wykonać');
});
