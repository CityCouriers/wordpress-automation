# Audyt niezależny: 4 ocalałe mutanty pomiaru #317 w scripts/quality/apps-script-compare.js

Środowisko: Windows 11, git for Windows 2.56.1, Node 24.15.0 (Linuksa nie było; test oparty na trace2 wymaga gita >= 2.22 z 2019, w CI jest nowszy).
Pracowałem wyłącznie na kopiach w `(katalog tymczasowy audytu)/`
(`orig` = kopia pliku z worktree, sha256 1e36d91599399fff150d01d9a98048d32791e79be529b917f4d892fddd0369c2 potwierdzony; `m1`, `m2`, `m3`, `m4` = mutanty nałożone tekstowo na `orig`; `mkmut.js` je tworzy).
Worktree i kopia Strykera nietknięte. Raport poprzedniej rundy (audyt-312) przeczytałem dopiero po sformułowaniu werdyktów; metoda jest zgodna (różnicowe eksperymenty + test rozróżniający).

## Werdykty

| id | linia | mutant | werdykt | czym ginie |
|----|-------|--------|---------|------------|
| 126 | 99:10 | `dir === '.'` -> `false` | ZABIJALNY | argumenty gita: `./*.gs ./appsscript.json` zamiast `*.gs appsscript.json` |
| 128 | 99:18 | `'.'` -> `""` | ZABIJALNY | jw. (zachowanie identyczne z 126: `dir` jest zawsze `.` albo `src`, więc `dir === ""` to zawsze `false`) |
| 197 | 136:7 | usunięcie `.trim()` | RÓWNOWAŻNY WOBEC PRAWDZIWEGO GITA, ale zabijalny atrapą wyniku gita (patrz ocena niżej; jedyna pozycja do decyzji) | atrapa `execFileSync` zwracająca `"\n"` dla `ls-files -- Version.gs` |
| 225 | 148:7 | `!entries.length` -> `false` | ZABIJALNY | ślad poleceń gita (trace2): przy braku driftu mutant uruchamia dodatkowe `git diff` |

Reguła właściciela: dopuszczalny jest tylko mutant, którego NIE może rozróżnić żaden test. Dla 126, 128, 225 test istnieje i działa na prawdziwym gicie. Dla 197 test istnieje tylko z atrapą.

## Wyniki empiryczne (testy rozróżniające w `extra.test.js`, kod niżej)

| bieg | wynik |
|------|-------|
| `orig` | 5/5 zielone |
| `m1` (126) | 2 czerwone: test argumentów i test komunikatu błędu; 3 pozostałe zielone |
| `m2` (128) | 2 czerwone (te same) |
| `m3` (197) | 1 czerwony: `Command failed: git checkout -- Version.gs` / `error: pathspec 'Version.gs' did not match any file(s) known to git` |
| `m4` (225) | 2 czerwone: lista poleceń `["ls-files","show","show","ls-files","status","diff"]` zawiera `diff` przy braku driftu |

Pełnych dwóch plików testowych z repozytorium na kopiach nie uruchamiałem ponownie (ocalenie czterech mutantów na istniejących testach wynika z raportu Strykera); uruchomiłem testy dodane przeze mnie na `orig` i na każdym mutancie (logi: `res-orig.log`, `res-m1.log`, `res-m2.log`, `res-m3.log`, `res-m4.log` w katalogu audytu).

## #126 i #128 (linia 99): ZABIJALNY

Kod: `sourcePathspec` zwraca dla układu w katalogu głównym `['*.gs','appsscript.json']`. Oba mutanty sprowadzają ten układ do gałęzi `[dir + '/*.gs', dir + '/appsscript.json']`, czyli `./*.gs`, `./appsscript.json`.

Dane nie rozróżniają: eksperyment `exp1.js` (orig vs m1 vs m2, wynik `compare()` albo błąd) w 5 scenariuszach (zmiana pliku w podkatalogu, nowy plik w głębokim podkatalogu, zmiana `appsscript.json` w korzeniu, zmiana `sub/appsscript.json`, plik `.gs` w katalogu z kropką) x 2 katalogi robocze (`--cwd` = korzeń repo i podkatalog repo), oraz osobno z `GIT_LITERAL_PATHSPECS`, `GIT_GLOB_PATHSPECS`, `GIT_NOGLOB_PATHSPECS`, `GIT_ICASE_PATHSPECS`: wszystkie wyniki identyczne. Git zdejmuje `./` z pathspec przed dopasowaniem, a `status`/`ls-files`/`diff` z pathspec nie zgłaszają błędu przy braku dopasowania.

Obserwowalna różnica to samo wywołanie gita:
* ślad `GIT_TRACE`: oryginał `git ls-files -z -- '*.gs' appsscript.json` i `git status --porcelain -z --no-renames -- '*.gs' appsscript.json`; mutant `... -- './*.gs' ./appsscript.json`;
* komunikat błędu poza repozytorium (CLI wypisuje go jako `[apps-script-compare] FAIL: ...`): oryginał `Command failed: git ls-files -z -- *.gs appsscript.json`, mutant `Command failed: git ls-files -z -- ./*.gs ./appsscript.json`. Komunikat widzi użytkownik w CI, więc to nie jest wyłącznie szczegół implementacji. Istniejący test (`git ls-files[^\n]*\nfatal`) ma w tym miejscu `[^\n]*` i przepuszcza oba.

Ocena rozsądku testu: asercja dotyczy pathspec (nie całej sekwencji wywołań), czyta JSON trace2 (nie tekst). Prostsza alternatywa: sama asercja `startsWith` na komunikacie (drugi z testów niżej).

## #197 (linia 136): `.trim()` na wyniku `git ls-files -- <Version.gs>`

Kod: `if (git(cwd, ['ls-files','--',versionFile]).trim()) git checkout -- versionFile`. Wynik `ls-files` bez `-z` to albo `''` (plik nieśledzony), albo wiersze `<ścieżka>\n`. `.trim()` zmienia tylko białe znaki na brzegach, a wartość logiczna napisu jest taka sama przed i po przycięciu, o ile napis nie składa się wyłącznie z białych znaków.

Dowód równoważności wobec prawdziwego gita: pathspec to dosłowne `Version.gs` albo `src/Version.gs` (bez znaków wieloznacznych i magii). Każda linia wyniku zawiera dopasowaną ścieżkę (co najmniej znaki `Version.gs`), więc nigdy nie jest samymi białymi znakami; przy braku dopasowania wynik jest pusty. Dopasowanie pod katalogiem `Version.gs/...` też drukuje ścieżkę. `core.quotePath`, `core.ignorecase`, układ `src`/`.` niczego tu nie zmieniają. Nie znalazłem stanu repozytorium ani zmiennej środowiskowej, przy których prawdziwy `git ls-files` wypisałby na stdout same białe znaki (ślady `GIT_TRACE*` idą do pliku albo stderr, a przy `/dev/stdout` zawierają niebiałe znaki). Zwrot funkcji, stan indeksu i liczba wywołań gita są w obu wersjach identyczne dla każdego wyniku, który git może wyprodukować.

Różnica jest wywoływalna wyłącznie atrapą: gdy `ls-files -- Version.gs` zwróci `"\n"`, oryginał uznaje to za brak śledzenia, a mutant woła `git checkout -- Version.gs` i kończy się błędem. Ostatni test niżej podmienia `child_process.execFileSync` przed `require` (ten sam wzorzec, co istniejący test ENOBUFS dla `spawnSync`): zielony na `orig`, czerwony na `m3`.

Ocena do rozstrzygnięcia przez właściciela albo koordynatora (granica reguły):
* Wg litery reguły („żaden test nie może odróżnić”) mutant NIE jest równoważny, bo test z atrapą go odróżnia. Test opisuje kontrakt „same białe znaki z `ls-files` to brak śledzenia”, którego prawdziwy git nigdy nie uruchomi; wartość praktyczna niska (ta sama kategoria co test stdin z `diff.external` w rundzie 312, a atrapy w tym pliku już są).
* Alternatywa bez atrapy: usunąć `.trim()` z kodu (przy prawdziwym gicie jest redundantne, `if (git(...))` zachowuje się identycznie), wtedy mutant znika razem z kodem. To zmiana kodu produkcyjnego, więc poza moim zakresem; decyzja autora.
* Nie uznaję go za równoważny w sensie dowiedzionym. Uznanie go za równoważny wymagałoby przyjęcia, że atrapa wyniku gita nie jest dozwolonym narzędziem rozróżnienia.

## #225 (linia 148): `if (!entries.length) return ...` -> `if (false) return ...`

Kod: po filtrze wpisów (`??` albo `e[1] !== ' '`) przy braku wpisów funkcja kończy działanie przed `git add -N`/`git diff`/`git reset`. Mutant idzie dalej: `changes = ''`, `untracked = []` (brak `add -N` i `reset`), ale `git --no-pager diff -- <pathspec>` jest uruchamiany.

Wartość zwrotna się nie różni: eksperyment `exp4.js` (orig vs m4, wartość `compare()` albo błąd), 14 stanów: zmiana tylko w indeksie, `assume-unchanged` + zmiana, `skip-worktree` + zmiana, stat-dirty z tą samą treścią, zmiana trybu (`update-index --chmod`), staged-delete, `autocrlf=true` z CRLF w drzewie, `.gitattributes eol=crlf`, `diff.external` ustawiony, `diff.orderFile` na nieistniejący plik, `diff.algorithm` i `diff.renames` z bzdurną wartością (pada już `git status`, przed tą linią), `index.lock`, usunięcie z indeksu i dysku: wszystkie wartości identyczne. Wejścia z pustym zbiorem wpisów i niepustym diffem nie znalazłem: `status` bez kolumny roboczej niezmienionej odpowiada pustemu diffowi drzewa roboczego względem indeksu (ten sam pathspec).

Obserwowalna różnica to proces: przy braku driftu mutant uruchamia dodatkowe polecenie `git diff`. Ślad trace2 (`GIT_TRACE2_EVENT`, zdarzenia `cmd_name`) pokazuje to wprost: oryginał `ls-files, show, show, ls-files, status`, mutant dodaje `diff`. Test sprawdza obie strony (czysty przebieg: brak `diff`; przebieg z driftem: dokładnie jeden `diff`, co jest kontrolą pozytywną sondy), plus wariant ze zmianą tylko w indeksie (wpis `M `).

Ocena rozsądku testu: nie liczy wszystkich wywołań gita ani ich kolejności (kruche), sprawdza jedno zachowanie kontraktowe: czysty przebieg nie uruchamia `git diff` po całym drzewie źródeł. Sonda działa na prawdziwym gicie, bez atrap i bez podstawiania `git` w PATH (atrapa `git.cmd` na Windows i tak nie działa z `execFileSync` bez powłoki). Stabilność: JSON z trace2, filtr po `cmd_name === 'diff'` (a nie po liczbie startów, bo trace2 loguje też podprocesy); zmienna ustawiana na czas jednego wywołania i usuwana w `finally`; testy w pliku idą sekwencyjnie.

## Kod testów zabijających

Wersja samodzielna (uruchamiana na kopiach): `(katalog tymczasowy audytu)/extra.test.js`. Do wklejenia do bloku `describe` z #312 (są tam już `mini`, `BASE`, `compare`, `git`, `roots`):

```js
/**
 * Uruchamia fn() z włączonym śladem trace2 gita (GIT_TRACE2_EVENT) i zwraca polecenia gita wywołane w jej trakcie:
 * [{ name: nazwa polecenia, argv: argumenty bez słowa "git" }], w kolejności startu.
 */
function gitCalls(root, fn) {
  const file = path.join(root, 'trace2.json');
  process.env.GIT_TRACE2_EVENT = file;
  try { fn(); } finally { delete process.env.GIT_TRACE2_EVENT; }
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const calls = [];
  for (const e of events) {
    if (e.event === 'start') calls.push({ argv: e.argv.slice(1), name: null });
    else if (e.event === 'cmd_name' && calls.length) calls[calls.length - 1].name = e.name;
  }
  fs.rmSync(file);
  return calls.filter(c => c.name);
}

// id 126 i 128 (linia 99): dla gita `./*.gs` i `*.gs` są równoważne, więc różnicę widać tylko w wywołaniu: argumentach gita
// i w komunikacie błędu `Command failed: git ls-files ...` w CI.
test('układ w katalogu głównym: git dostaje pathspec `*.gs` i `appsscript.json`, bez przedrostka `./`', () => {
  const { root } = mini(BASE);
  const calls = gitCalls(root, () => compare(root));
  const withSpec = calls.filter(c => (c.name === 'ls-files' && c.argv.includes('-z')) || c.name === 'status');
  assert.equal(withSpec.length, 2, JSON.stringify(calls));
  for (const c of withSpec) assert.deepEqual(c.argv.slice(c.argv.indexOf('--') + 1), ['*.gs', 'appsscript.json'], c.argv.join(' '));
});

test('układ w katalogu głównym: komunikat błędu gita poza repozytorium niesie dokładne polecenie z pathspec', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-nogit-'));
  roots.push(plain);
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain);
  try {
    assert.throws(() => compare(plain), e => e.message.startsWith('Command failed: git ls-files -z -- *.gs appsscript.json\n'), 'polecenie w komunikacie');
  } finally { delete process.env.GIT_CEILING_DIRECTORIES; }
});

// id 225 (linia 148): bez wczesnego wyjścia kod uruchamia `git diff` także bez zmian; wynik ten sam (pusty patch), różnica tylko w śladzie poleceń.
test('brak driftu: compare() nie uruchamia git diff (wczesne wyjście), a przy driftcie diff jest uruchamiany', () => {
  const { root } = mini(BASE);
  const clean = gitCalls(root, () => assert.deepEqual(compare(root), { changes: '', patch: '' }));
  assert.deepEqual(clean.filter(c => c.name === 'diff'), [], 'bez zmian żaden diff: ' + JSON.stringify(clean.map(c => c.name)));
  assert.ok(clean.some(c => c.name === 'status'), 'sonda działa: status widoczny w śladzie');
  fs.writeFileSync(path.join(root, 'GA4.gs'), 'function b() { return 1; }\n');
  const dirty = gitCalls(root, () => compare(root));
  assert.equal(dirty.filter(c => c.name === 'diff').length, 1, 'z driftem dokładnie jeden diff');
});

test('brak driftu przy samej zmianie w indeksie (wpis `M `): też bez git diff', () => {
  const { root, g } = mini(BASE);
  fs.writeFileSync(path.join(root, 'GA4.gs'), 'function b() { return 1; }\n');
  g('add', '--', 'GA4.gs');
  const calls = gitCalls(root, () => assert.deepEqual(compare(root), { changes: '', patch: '' }));
  assert.deepEqual(calls.filter(c => c.name === 'diff'), []);
});

// id 197 (linia 136): prawdziwy git nie zwraca z `ls-files -- <plik>` samych białych znaków, więc różnicę da się wywołać tylko atrapą wyniku gita.
test('białe znaki zamiast ścieżki z `git ls-files -- Version.gs` oznaczają „plik nieśledzony”: brak git checkout', () => {
  const { root } = mini(BASE);
  const cp = require('child_process');
  const real = cp.execFileSync;
  const seen = [];
  cp.execFileSync = function (cmd, args) {
    seen.push(args.join(' '));
    if (cmd === 'git' && args[0] === 'ls-files' && args[args.length - 1] === 'Version.gs') return '\n';
    return real.apply(this, arguments);
  };
  let patched;
  try {
    delete require.cache[SCRIPT];
    patched = require(SCRIPT);
  } finally {
    cp.execFileSync = real;
    delete require.cache[SCRIPT];
  }
  assert.deepEqual(patched.compare(root), { changes: '', patch: '' });
  assert.ok(seen.some(s => s === 'ls-files -- Version.gs'), 'atrapa została użyta: ' + seen.join(' | '));
  assert.ok(!seen.some(s => s.startsWith('checkout')), 'żadnego checkout: ' + seen.join(' | '));
});
```

Uwaga integracyjna: test `GIT_CEILING_DIRECTORIES` ustawia zmienną w `process.env` na czas jednego wywołania; testy w pliku idą sekwencyjnie, a `stripGitEnv()` na górze pliku nie przeszkadza (zmienna jest ustawiana po nim).

## Ograniczenia obserwowalności i niepewności

* Linux niesprawdzony (Windows, git 2.56.1). Testy trace2 i argumentów nie zależą od platformy; wymagany git >= 2.22 (trace2 event).
* #197: rozróżnienie wyłącznie przez atrapę; prawdziwy git nie produkuje wejścia rozróżniającego (dowód z konstrukcji wyniku plus próby, nie dowód formalny na całej przestrzeni konfiguracji gita).
* #225 i #126/#128: zwrot funkcji nieodróżnialny, rozróżnienie przez zachowanie procesu (wywołania gita); sprawdzone w ograniczonym zestawie stanów (exp1: 5 scenariuszy x 2 cwd x 5 konfiguracji pathspec; exp4: 14 stanów), nie wyczerpująco.
