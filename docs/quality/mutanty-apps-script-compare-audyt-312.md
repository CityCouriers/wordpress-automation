# Raport niezależnego audytu mutantów: scripts/quality/apps-script-compare.js

Środowisko: Windows 11, git for Windows 2.56.1, Node 24.15.0. Kopia robocza: katalog `audit` (nic poza nią nie ruszano, nic nie commitowano).
Linuksa z Node nie było: werdykty o Linuksie są wnioskowaniem z konstrukcji wejścia (zaznaczone).

## Metoda

1. Każdy z 15 mutantów nałożono na kopię (`apply-mutant.js`). UWAGA: pod położeniem 94:10, 117:9, 131:7, 140:18, 140:31, 142:14, 143:7, 146:7
   jest kilka mutantów; tabela w MUTANTY.md opisuje ten ocalały (indeks zamiany: 94:10 -> 2, 117:9 -> 1, 131:7 -> 2, 140:18 -> 3,
   140:31 -> 2, 142:14 -> 1, 143:7 -> 2, 146:7 -> 1). Domyślne `apply-mutant.js ... <loc>` (n=0) nakłada INNEGO, zabijanego mutanta
   (np. 94:10 n=0 to `true` i ginie na istniejącym teście `#105 układ src - plik w katalogu głównym`). Warto dopisać to do instrukcji.
2. Pełny `test/apps-script-compare.test.js` na każdym z 15 (HEAD fd177d1): linie bazowa 33 pass/1 skip, wszystkie 15 mutantów PRZEŻYWA
   (potwierdza stan z tabeli).
3. Własne testy rozróżniające: `test/kill-mutants.test.js` (w katalogu audytu) uruchomione na oryginale (wszystkie zielone) i na każdym mutancie.
4. Różnicowy fuzz `fuzz/diff-fuzz.js`: ten sam losowy scenariusz (układ `.`/`src`, 2-6 plików z nazwami m.in. wiodąca spacja, NBSP,
   znaki spoza ASCII, podkatalog; zawartości z/bez końcowej nowej linii, puste, CRLF; stany: bez zmian, +nl, -nl, zmieniony, usunięty,
   CRLF, pusta linia na końcu, puste; zmiany tylko w indeksie; `core.quotePath`, `core.autocrlf`, `core.ignorecase`,
   `status.showUntrackedFiles`, `diff.ignoreSubmodules`; wpisy indeksu w „katalogu” `appsscript.json/...`, także z `skip-worktree`)
   wykonany na oryginale i na mutancie; porównywane: wynik `compare()` albo błąd, `git status -z`, `ls-files -s`, `diff --cached`, pełna zawartość drzewa po przebiegu.
   Kontrola pozytywna fuzza: wykrywa zabijalne mutanty #5, #9 (patrz niżej).
5. Eksperymenty bezpośrednio na gicie (pathspec z `./`, `git show :`, `git add -N --`, kwotowanie w `status --porcelain`).

## Najważniejsze fakty o gicie, na których opierają się werdykty

* `git status --porcelain` (v1) KWOTUJE nazwy zawierające ASCII spację (`?? " Spacja.gs"`), natomiast nie kwotuje innych białych znaków
  przy `core.quotePath=false` (np. NBSP U+00A0 idzie surowo). `git ls-files` nie kwotuje spacji.
* Pathspec dosłowny `appsscript.json` pasuje też do wszystkiego pod „katalogiem” `appsscript.json/` (prefiks katalogu). Dzięki temu da się
  mieć w indeksie ścieżkę objętą pathspec, która NIE kończy się na `.gs`/`appsscript.json` (np. `appsscript.json/a??`).
  Wpisy o nazwach z `?` albo końcową spacją wymagają `-c core.protectNTFS=false` przy `git update-index` na Windows (bez pliku w drzewie roboczym).
* `git add -N --` bez ścieżek kończy się kodem 0 („Nothing specified”), ale NAJPIERW zakłada `.git/index.lock` (przy istniejącym locku: fatal, kod 128).
* `git show :` (pusta nazwa) kończy się kodem 128 (ambiguous argument).
* `spawnSync`/`execFileSync` mają domyślny `maxBuffer` 1 MiB; po przekroczeniu `status` = null (ENOBUFS), a `stdout` zawiera dotychczas odebrane dane.

## Werdykty (numeracja z MUTANTY.md)

Legenda: „kontrola” = istniejące testy (35 s) przepuszczają mutanta (wszystkie 15). „własny test” = `test/kill-mutants.test.js` (wszystkie jego testy
zielone na oryginale; wynik na mutancie podany). Kody w `\u00a0` oznaczają twardą spację (NBSP); w pliku testowym są wpisane jako ten znak.

### #1 stdio `['ignore','pipe','pipe']` -> `[]` (64:68): DA SIĘ ZABIĆ (testem sztucznym, ale deterministycznym)

* Co się zmienia: jedynie stdin potomka. Oryginał: `ignore` (NUL / `/dev/null`, urządzenie znakowe). Mutant: `pipe` zamykany od razu (EOF), ale to potok/socket.
  Stderr nadal jest przechwytywany w obu (`inheritStderr = !options.stdio`, `![]` jest fałszem), więc strumienie wyjściowe się nie różnią,
  a istniejący test „stderr gita” go nie rusza.
* Rozróżnienie: git przekazuje swój stdin do zewnętrznego sterownika `diff.external` (potwierdzone w bashu: `< /dev/null` -> CHAR, `printf '' |` -> PIPE).
  Skrypt-sterownik sprawdza `fs.fstatSync(0)`. Wynik na Windows: oryginał `char`, mutant `other` (potok). Test niżej: oryginał zielony, mutant czerwony.
* Linux: nie uruchamiano. Uzasadnienie konstrukcją: libuv tworzy dla `stdio:'pipe'` socketpair, więc `isCharacterDevice()` = false, a przy `ignore` jest to `/dev/null` (znakowe). Test jest przenośny (nie zależy od systemu), ale na Linuksie niezweryfikowany.
* Ograniczenie obserwowalności: żaden zwykły skutek (kod wyjścia, stdout, stan repo) się nie zmienia; EOF na stdin jest w obu przypadkach natychmiastowy, więc ewentualny „zawis na czytaniu stdin” nie występuje. Mutant jest rozróżnialny tylko przez rodzaj deskryptora widziany przez proces potomny gita (sterownik diff/textconv/filtr). To test „kontraktu przekazania stdin”, wartość praktyczna niska. Jeśli właściciel uzna to za zbyt sztuczne, to jest kandydat na „równoważny w praktyce”, ale NIE równoważny w sensie ścisłym, więc wg definicji zadania: DA SIĘ ZABIĆ.

```js
test('git dostaje stdin jako urządzenie znakowe (null), nie jako potok', () => {
  const { root, g } = newRepo();                       // repo z Kod.gs, GA4.gs (bez Version.gs)
  const ext = path.join(root, 'ext-diff.js');
  fs.writeFileSync(ext, [
    "const fs = require('fs');",
    'const st = fs.fstatSync(0);',
    "fs.writeFileSync(process.env.STDIN_OUT, st.isCharacterDevice() ? 'char' : st.isFIFO() ? 'fifo' : st.isSocket() ? 'socket' : 'other');"
  ].join('\n'));
  const fwd = p => p.split(path.sep).join('/');
  g('config', 'diff.external', `"${fwd(process.execPath)}" "${fwd(ext)}"`);
  fs.writeFileSync(path.join(root, 'GA4.gs'), 'function b() { return 1; }\n');   // drift => git diff woła sterownik
  const out = path.join(root, 'stdin-type.txt');
  process.env.STDIN_OUT = out;
  try { compare(root); } finally { delete process.env.STDIN_OUT; }
  assert.equal(fs.readFileSync(out, 'utf8'), 'char');
});
```

### #2 `dir === '.'` -> `false` (94:10, indeks zamiany 2) i #3 `'.'` -> `""` (94:18): RÓWNOWAŻNE (oba, ten sam skutek)

* Oba dają dla układu `.` pathspec `['./*.gs', './appsscript.json']` zamiast `['*.gs', 'appsscript.json']`. Dla układu `src` brak zmiany (gałąź i tak fałszywa).
* Git normalizuje wiodące `./` względem katalogu bieżącego (prefix_path), więc oba zapisy to ten sam pathspec. Sprawdzone bezpośrednio:
  `ls-files` i `status --porcelain` z `'*.gs' appsscript.json` vs `'./*.gs' ./appsscript.json` w repo z plikami w korzeniu, `sub/`, `sub/deep/`, `a.gs/`,
  `src/`, `[x].gs`; z cwd = `.`, `sub`, `sub/deep`; przy `GIT_LITERAL_PATHSPECS`, `GIT_GLOB_PATHSPECS`, `GIT_NOGLOB_PATHSPECS`, `GIT_ICASE_PATHSPECS`: za każdym razem identyczne wyjście.
  Fuzz różnicowy (150 scenariuszy): 0 różnic. Nic nie zmienia się też dla `diff`, bo pathspec jest ten sam.
* Ograniczenie obserwowalności: żadne (nie ma wejścia, które by to rozróżniło poza starym gitem sprzed normalizacji `./`; takiego nie było do sprawdzenia; wersja 2.56.1 sprawdzona, normalizacja jest w gicie od 2005 r.).
* Uwaga: #2 i #3 są sobie równe (ta sama transformacja `dir === '.'` -> fałsz), można rozliczyć jednym uzasadnieniem.

### #4 usunięcie `.filter(Boolean)` (114:19): RÓWNOWAŻNE

* Bez filtra do `tracked` trafia pusty łańcuch (z końcowej nowej linii `ls-files` albo z pustego wyniku). Wtedy `git show ':'` kończy się kodem 128
  (zmierzone: „ambiguous argument ':'”), a `if (shown.status !== 0) continue;` pomija wpis. Nic nie jest dodane do indeksu ani zapisane.
  (Ścieżka z nazwą złożoną z samych białych znaków -> po `trim()` także `''`; ten sam skutek.)
* Warianty, które sprawdziłem: pusty `ls-files`, repo z jednym i wieloma plikami, nazwy z wiodącą spacją/NBSP, `core.quotePath` true/false: wyniki, stan indeksu i drzewa identyczne (fuzz 150 scenariuszy: 0 różnic).
  Na Linuksie z plikiem o nazwie `:` w katalogu `git show :` potraktowałby `:` jako pathspec -> „empty string is not a valid pathspec”, nadal kod 128 (wnioskowanie, nie uruchamiane; plik `:` nie istnieje na NTFS).
* Ograniczenie obserwowalności: jedyna różnica to dodatkowe wywołanie `git show :` (nieudane). Widać je wyłącznie przez zliczanie wywołań gita (GIT_TRACE / podstawiony git w PATH), czyli nie zachowaniem programu.

### #5 `s.trim()` -> `s` w `normalizeIndexTrailingNewline` (114:93): DA SIĘ ZABIĆ (na Windows i Linuksie), ale test utrwala obecny błąd

* Oryginał przycina nazwę z `ls-files`, więc dla śledzonego `" Sp.gs"` (wiodąca spacja) `git show :Sp.gs` zawodzi i plik jest pomijany. Mutant zachowuje nazwę i normalizuje poprawnie.
  Wejście: `" Sp.gs"` zacommitowany jako `x` (bez nowej linii), w katalogu roboczym `x\n`. Oryginał: `changes` = ` M " Sp.gs"` (fałszywy drift), mutant: pusto.
* Windows: NTFS pozwala na WIODĄCĄ spację (końcową nie), `fs.writeFileSync(' Sp.gs')` działa. Istniejący test z tym samym wejściem jest `skip` na win32 niepotrzebnie: wystarczy go odblokować (zielony na oryginale, czerwony na mutancie; przy odblokowaniu użyć zawartości jak niżej). Wariant bez ASCII: NBSP + `core.quotePath=false` (ls-files wypisuje surowo, `trim()` JS usuwa U+00A0).
* Własny test: oba warianty zielone na oryginale, czerwone na mutancie (zmierzone).
* Uwaga: oryginał jest tu błędny (fałszywy drift); poprawką byłoby usunięcie `.trim()` (wtedy mutant #5 przestaje istnieć). Test utrwala ten błąd.

```js
test('wiodąca spacja w nazwie śledzonego pliku', () => {
  const { root } = newRepo({ ' Sp.gs': 'x', 'Kod.gs': 'function a() {}\n' });
  fs.writeFileSync(path.join(root, ' Sp.gs'), 'x\n');
  assert.match(compare(root).changes, /Sp\.gs/);       // oryginał: fałszywy drift (nazwa przycięta)
});
test('wiodąca NBSP przy core.quotePath=false', () => {
  const { root, g } = newRepo({ '\u00a0Nb.gs': 'x', 'Kod.gs': 'function a() {}\n' });
  g('config', 'core.quotePath', 'false');
  fs.writeFileSync(path.join(root, '\u00a0Nb.gs'), 'x\n');
  assert.match(compare(root).changes, /Nb\.gs/);
});
```

### #6 `shown.status !== 0` -> `false` (117:9, indeks 1): DA SIĘ ZABIĆ (Windows i Linux), test utrwala ograniczenie maxBuffer

* Gdy `git show` kończy się błędem z pustym stdout, mutant i oryginał są nierozróżnialne (`!indexed.length` -> continue). Ale `spawnSync` ma `maxBuffer` 1 MiB: dla blobu > 1 MiB `status` = null (ENOBUFS), a `stdout` zawiera dane odebrane do chwili zabicia.
  Dla blobu o rozmiarze 1 048 577 B (maxBuffer + 1) i 1 052 673 B stdout jest kompletny, więc mutant (pomija test statusu) normalizuje plik, a oryginał go pomija.
* Wejście: śledzony `Big.gs` rozmiaru 1 048 577 B (linie po 79 znaków, ostatnia linia bez `\n`), w katalogu roboczym ten sam plik + `\n`.
  Oryginał: `changes` = ` M Big.gs` (patch mały, bo zmienia się tylko ostatnia linia). Mutant: `changes` = '' (zmierzone). Dla 1 048 576 B obaj dają '' (bufor się mieści), dla 3 000 000 B obaj ` M Big.gs` (stdout obcięty, niezgodny z plikiem).
* To zachowanie oryginału jest wadą (plik tylko z inną końcową nową linią > 1 MiB zgłaszany jako drift), więc test pinuje błąd; po poprawce kodu (np. `maxBuffer` w `spawnSync` dla `git show`) mutant #6 stałby się równoważny. Dodatkowo: przy drifcie w pliku > ~0,5 MiB, którego diff przekracza 1 MiB, `git()` rzuca ENOBUFS (zmierzone: `spawnSync git ENOBUFS` w `git diff`), czyli kontrola kończy się awarią zamiast raportu. Poza zakresem mutantów, ale warto zgłosić.
* Platforma: ten sam mechanizm i stały próg na Linuksie (maxBuffer to Node, nie system); rozmiar deterministyczny dla Windows, na Linuksie nieuruchamiany.

```js
test('śledzony plik 1 MiB + 1 B bez końcowej nowej linii: normalizacja go pomija (ENOBUFS), więc zgłasza drift', () => {
  const big = size => { let t = ''; while (t.length < size) t += 'x'.repeat(79) + '\n'; return t.slice(0, size - 1) + 'y'; };
  const size = 1048577;
  const content = big(size);
  const { root } = newRepo({ 'Big.gs': content, 'Kod.gs': 'function a() {}\n' });
  fs.writeFileSync(path.join(root, 'Big.gs'), content + '\n');
  assert.equal(compare(root).changes, ' M Big.gs');     // mutant: ''
});
```

### #7 `.trim()` usunięte w warunku `ls-files Version.gs` (131:7, indeks 2): RÓWNOWAŻNE (dowód logiczny + fuzz)

* Wynik `git ls-files -- <versionFile>` to albo `''` (plik nieśledzony), albo lista ścieżek zawierających literalnie `Version.gs` (pathspec dosłowny pasuje też do katalogu `Version.gs/...`), zawsze zakończona `\n`.
  Niepusty wynik zawiera znaki niebiałe, więc `s.trim()` jest prawdziwe wtedy i tylko wtedy, gdy `s` jest prawdziwe. Żaden wynik gita nie składa się wyłącznie z białych znaków.
* Fuzz: 150 scenariuszy (Version.gs śledzony/nieśledzony/zmieniony), 0 różnic.
* Ograniczenie obserwowalności: brak (tożsamość warunków).

### #8 `l.trim()` -> `l` w filtrze statusu (140:18, indeks 3): RÓWNOWAŻNE

* Różnica wymaga linii `git status --porcelain`, która jest niepusta i składa się wyłącznie z białych znaków. Porcelain v1 zawsze zaczyna linię od kodu XY, z którego co najmniej jedna pozycja nie jest spacją (puste XY nie jest wypisywane),
  po nim spacja i ścieżka (niepusta). Linii czysto białych nie ma. Końcowy element po `split('\n')` to `''`, fałszywy w obu wersjach.
* Sprawdzone: wszystkie typy wpisów, jakie umiałem wytworzyć (M, A, D, ??, AD, MM, skip-worktree; rename nie był generowany, ale po filtrze pathspec nie powstaje, nazwy z NBSP/spacją, kwotowane), fuzz 150 scenariuszy: 0 różnic.
* Ograniczenie obserwowalności: brak.

### #9 `l.startsWith('??')` -> `l.endsWith('??')` (140:31, indeks 2): DA SIĘ ZABIĆ (Windows i Linux)

* Warunek `startsWith('??') || l[1] !== ' '`: pierwszy człon jest redundantny (linia zaczynająca się od `??` ma `l[1]==='?'`). Mutant dodaje wiersze KOŃCZĄCE SIĘ na `??` mające `l[1] === ' '`, czyli zmiany tylko w indeksie ze ścieżką kończącą się na `??`.
  Normalnie ścieżki pasujące do pathspec kończą się na `.gs`/`appsscript.json`, ALE pathspec dosłowny `appsscript.json` pasuje też do plików pod „katalogiem” `appsscript.json/`.
* Wejście: wpis tylko w indeksie `appsscript.json/a??` (dodany jako nowy względem HEAD) z `skip-worktree` (żeby `status` nie zgłosił usunięcia z dysku i żeby `readdir` w `normalizeTrailingNewline` nie trafił na katalog):
  `git status --porcelain` wypisuje `A  appsscript.json/a??`. Oryginał: `changes` = '' (zmiany indeksowe nie są driftem). Mutant: `changes` = `A  appsscript.json/a??` (fałszywy drift).
  Windows: `?` w ścieżce jest odrzucany przez `core.protectNTFS`, więc wpis wykonano przez `git -c core.protectNTFS=false update-index` (plik w drzewie nie jest tworzony). Na Linuksie bez tej flagi.
* Zmierzone: test zielony na oryginale, czerwony na mutancie; fuzz (z takimi wpisami) znalazł 8 różnic.
* Ograniczenie obserwowalności: dowód wymaga sztucznego stanu indeksu (katalog o nazwie pliku konfiguracyjnego). Żaden „zwykły” przebieg tego nie ujawni.

```js
test('wpis tylko w indeksie o ścieżce kończącej się na ?? (pod katalogiem appsscript.json) nie jest driftem', () => {
  const { root, g } = newRepo();
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'hello\n', encoding: 'utf8' }).trim();
  g('-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},appsscript.json/a??`);
  g('-c', 'core.protectNTFS=false', 'update-index', '--skip-worktree', 'appsscript.json/a??');
  assert.deepEqual(compare(root), { changes: '', patch: '' });
});
```

### #10 regex `/\s+$/` -> `/\s$/` (142:14, indeks 1) i #11 `''` -> `"Stryker was here!"` (142:22): DA SIĘ ZABIĆ (Windows i Linux)

* Różnica wymaga, by OSTATNI wiersz raportu kończył się białym znakiem (#10: co najmniej dwoma). Zwykła ścieżka kończy się na `.gs`/`.json`; ASCII spacja jest przez status v1 kwotowana (`" D "a  ""`, kończy się cudzysłowem), więc nie nadaje się.
  Surowo wypisywany biały znak to np. NBSP przy `core.quotePath=false`, a pathspec dosłowny `appsscript.json` dopuszcza ścieżkę pod katalogiem `appsscript.json/`, której nazwa może się kończyć NBSP.
* Wejście: plik `appsscript.json/n\u00a0\u00a0` zacommitowany (przez `update-index --cacheinfo`, bez pliku w drzewie), `core.quotePath=false`; w katalogu roboczym go brak, więc status to ` D appsscript.json/n\u00a0\u00a0` (ostatni wiersz).
  Oryginał: `changes` = ` D appsscript.json/n` (końcowe białe znaki obcięte). #10: zostaje jeden NBSP (` D appsscript.json/n\u00a0`). #11: ` D appsscript.json/nStryker was here!`.
  Zmierzone: test z DWOMA NBSP zabija oba (#10 i #11); test z jednym NBSP zabija tylko #11 (dla #10 `/\s$/` też zjada jeden znak). Fuzz: 1 różnica dla #10.
* Platformy: Windows (uruchomione; wpis tylko w indeksie, więc brak ograniczeń nazewnictwa NTFS), Linux analogicznie (wnioskowanie, na Linuksie można też użyć realnego pliku, ale wtedy `readdir` zobaczy katalog `appsscript.json`, więc i tak trzeba usunąć go z dysku).
* Ograniczenie obserwowalności: wymaga nazwy kończącej się niekwotowanym białym znakiem; przy domyślnym `core.quotePath` (true) NBSP jest kwotowany i ścieżki bez końcowych białych znaków (kończą się `"` albo `.gs`) mutanta nie ujawniają.

```js
function deletedWithTrailing(suffix) {                // suffix: znaki NBSP
  const { root, g } = newRepo();
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'hello\n', encoding: 'utf8' }).trim();
  g('-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob},appsscript.json/n${suffix}`);
  g('-c', 'core.protectNTFS=false', 'commit', '-q', '-m', 'w');
  g('config', 'core.quotePath', 'false');
  return root;
}
test('dwa końcowe NBSP w ostatnim wierszu raportu są obcinane (#10, #11)', () => {
  assert.equal(compare(deletedWithTrailing('\u00a0\u00a0')).changes, ' D appsscript.json/n');
});
test('jeden końcowy NBSP (#11)', () => {
  assert.equal(compare(deletedWithTrailing('\u00a0')).changes, ' D appsscript.json/n');
});
```

### #12 `!changes.trim()` -> `false` (143:7, indeks 2): RÓWNOWAŻNE (z ograniczeniem obserwowalności)

* Mutant nie wraca wcześniej przy pustym `changes`; dalej: `untracked` = [] (brak `add -N`/`reset`), `patch = git diff` i zwraca `{changes:'', patch}`.
  Różnica w wyniku wymagałaby niepustego `git diff` przy pustych `changes`. `changes` obejmuje każdy wiersz z `l[1] !== ' '` (czyli każdą różnicę drzewo-indeks) i `??`, a `git diff` (drzewo vs indeks) pokazuje dokładnie te same pliki.
* Szukałem rozbieżności status/diff: błędne wartości `diff.*` w konfiguracji (algorithm, context, renames, noprefix, orderFile, external, submodule i ok. 20 innych), `GIT_DIFF_OPTS`, `GIT_EXTERNAL_DIFF`, `.git/index.lock`, `diff.ignoreSubmodules`,
  `status.showUntrackedFiles`, `core.autocrlf`, zmiany tylko w indeksie (stat-brudne pliki bez zmiany treści tylko w rozumowaniu, nie w eksperymencie): `git status` i `git diff` zawsze kończą się tym samym kodem, a przy czystym drzewie diff jest pusty. Fuzz 150 scenariuszy: 0 różnic.
* Ograniczenie obserwowalności: jedyna różnica to dodatkowe wywołanie `git diff` (bez skutku ubocznego poza odświeżeniem statów indeksu, które robi już `git status`). Widoczne tylko przez liczenie wywołań gita.

### #13 `changes.trim()` -> `changes` (143:8): RÓWNOWAŻNE (dowód)

* Tuż przed warunkiem `changes` przeszło przez `.replace(/\s+$/, '')`, więc jest albo `''`, albo kończy się znakiem niebiałym. W pierwszym przypadku `!''` i `!''.trim()` są prawdziwe, w drugim oba fałszywe (`trim` zachowuje ten końcowy znak).
  `\s` i `String.prototype.trim` mają ten sam zbiór białych znaków (WhiteSpace + LineTerminator wg ES), więc to tożsamość, nie tylko statystyka. Fuzz: 0 różnic.
* Ograniczenie obserwowalności: brak.

### #14 `l.slice(3).trim()` -> `l.slice(3)` (145:82, indeks 0): DA SIĘ ZABIĆ (Windows; Linux wnioskowanie), test utrwala obecny błąd

* Status v1 kwotuje nazwy z ASCII spacją (`?? " Spacja.gs"`), więc przycinanie ASCII spacji jest bez znaczenia. Różnica: nazwa nieśledzonego pliku zaczynająca się od białego znaku NIEkwotowanego, np. NBSP przy `core.quotePath=false` (status wypisuje surowo).
  Oryginał przycina NBSP -> `git add -N -- Nb.gs` kończy się błędem (nieistniejąca ścieżka) -> `compare` rzuca `Command failed: git add -N ...`. Mutant przekazuje poprawną nazwę i raportuje drift z patchem.
* Własny test (oryginał zielony: rzuca błąd `git add -N`, mutant czerwony: nie rzuca): zmierzone na Windows.
  Linux: wnioskowanie (NBSP w nazwie dozwolony, zachowanie gita identyczne).
* Uwaga: to znowu test utrwalający błąd oryginału (komunikat błędu zamiast raportu). Poprawka kodu (bez `trim()`, ze `-z`) usuwa mutanta. Pokrewne ustalenie poza mutantami: każdy nieśledzony plik z ASCII spacją w nazwie (`a b.gs`) wywala `compare` (`git add -N -- "a b.gs"` z literalnymi cudzysłowami; zmierzone przez `compare()`).

```js
test('nieśledzony plik z wiodącą NBSP, core.quotePath=false: oryginał kończy się błędem git add -N', () => {
  const { root, g } = newRepo();
  g('config', 'core.quotePath', 'false');
  fs.writeFileSync(path.join(root, '\u00a0Nb.gs'), 'x\n');
  assert.throws(() => compare(root), /git add -N/);     // mutant: zwraca drift z patchem
});
```

### #15 `if (untracked.length)` -> `if (true)` przy `git add -N` (146:7, indeks 1): DA SIĘ ZABIĆ (Windows i Linux)

* Uwaga o zakresie mutanta: zmieniony jest tylko `if` przy `git add -N` (linia 146); `git reset -q --` (linia 148) ma własny, niezmieniony warunek. Dlatego istniejący test „normalizacja indeksu zostaje…” go NIE zabija (reset i tak się nie wykonuje).
  Mutant uruchamia `git add -N --` bez ścieżek: kod 0, komunikat „Nothing specified” na stderr (przechwycony).
* Ale `git add -N --` ZAKŁADA `.git/index.lock` zanim stwierdzi brak ścieżek (zmierzone: przy istniejącym locku fatal, kod 128, także bez ścieżek).
  Wejście: repo bez śledzonego `Version.gs` (brak `git checkout`, który też potrzebuje locka), brak normalizacji indeksu, drift w śledzonym pliku, brak nieśledzonych, `.git/index.lock` istnieje (stary/zajęty).
  Oryginał: `changes` = ` M GA4.gs`, patch poprawny (status i diff nie wymagają locka). Mutant: wyjątek „Unable to create index.lock”.
* Zmierzone: zielony na oryginale, czerwony na mutancie. Platformy: Windows (uruchomione); Linux identycznie (zachowanie gita, wnioskowanie).
* Ograniczenie obserwowalności: bez zajętego indeksu mutant różni się tylko dodatkowym wywołaniem gita.

```js
test('drift tylko w śledzonym pliku przy zajętym indeksie: bez nieśledzonych plików nic nie wymaga blokady indeksu', () => {
  const { root } = newRepo();          // bez Version.gs i bez normalizacji indeksu
  fs.writeFileSync(path.join(root, 'GA4.gs'), 'function b() { return 1; }\n');
  fs.writeFileSync(path.join(root, '.git', 'index.lock'), '');
  const r = compare(root);
  assert.equal(r.changes, ' M GA4.gs');
  assert.match(r.patch, /\+function b\(\) \{ return 1; \}/);
});
```

## Podsumowanie liczbowe

| Werdykt | Mutanty |
| ------- | ------- |
| DA SIĘ ZABIĆ (8) | #1, #5, #6, #9, #10, #11, #14, #15 |
| RÓWNOWAŻNE (7) | #2, #3, #4, #7, #8, #12, #13 |
| RÓWNOWAŻNY TYLKO NA platformie | żaden (wszystkie zabijalne są zabijalne na Windows; zabijalność na Linuksie to wnioskowanie) |

Z ośmiu zabijalnych: #9, #10, #11, #15 testują poprawne zachowanie oryginału (nie utrwalają błędu); #5, #6, #14 utrwalają błąd oryginału (poprawka kodu wyeliminowałaby mutanta);
#1 jest testem sztucznym (typ deskryptora stdin).

Wszystkie testy z `test/kill-mutants.test.js` są zielone na oryginale. Wyniki na mutantach (zmierzone): #1, #5, #6, #9, #10, #11, #14, #15 czerwone; #2, #3, #4, #7, #8, #12, #13 zielone (nierozróżnialne).
Fuzz różnicowy: 150 scenariuszy (19 scenariuszy, w których sam oryginał rzuca błąd, np. nieśledzone pliki ze spacją), 7 mutantów równoważnych: 0 różnic; kontrole pozytywne (#5, #9, #10, #14) znalazły 4+8+1+1 różnic.

Rozstrzygnięcie dla #12, #4 (i w części #2/#3, #8): rozróżnialne tylko przez liczbę/kolejność wywołań gita. Zapisane jako ograniczenie obserwowalności, nie jako możliwość zabicia.

## Rzeczy, w których mam wątpliwość

1. #1: test opiera się na tym, że `diff.external` dziedziczy stdin gita oraz że `fstat(0)` na Windows daje inny typ dla NUL i potoku (zmierzone: `char` vs `other`). Na Linuksie (socketpair vs `/dev/null`) nie uruchamiałem. Czy taki test jest „poprawny” w rozumieniu zasad właściciela (obserwuje rodzaj deskryptora, nie skutek), to do rozstrzygnięcia przez właściciela.
2. #5, #6, #14: testy utrwalają zachowanie, które jest błędem oryginału (fałszywy drift dla nazw z wiodącym białym znakiem i dla plików > 1 MiB, awaria `git add -N` dla NBSP). Zabicie mutanta takim testem jest formalnie możliwe, lecz sensowniejsze bywa poprawienie kodu (usunięcie `trim`, `maxBuffer`, `status -z`), po czym mutanty znikają (#6 staje się równoważny po zwiększeniu maxBuffer).
3. #9, #10, #11: wejścia (katalog o nazwie `appsscript.json` z plikiem o nazwie z `??`/NBSP, `core.protectNTFS=false`, `skip-worktree`) są sztuczne; ścisła definicja równoważności ich nie wyklucza, więc nie zaliczam tych mutantów do równoważnych.
4. #12, #4: moja argumentacja o braku rozbieżności status/diff wynika z testów empirycznych (kilkadziesiąt konfiguracji plus fuzz), nie z dowodu z kodu gita; nie wykluczam egzotycznej konfiguracji (np. sterownik `diff` z efektem ubocznym uruchamiany przy czystym drzewie) której nie znalazłem.
5. Wersje gita: tylko 2.56.1 (Windows). Zachowania `./` w pathspec (#2/#3), `git show :` (#4) i `git add -N --` (#15) opisałem dla tej wersji i z wiedzy o historii gita; na gicie z CI (Ubuntu) nie uruchamiałem.
6. Fuzz: scenariusze z nazwą `x.gs.` (końcowa kropka) nie dały się zbudować na NTFS i zostały pominięte; zawartość `appsscript.json` jako katalog dla układu `src` nie była generowana (tam `readdir` trafia na katalog i `compare` rzuca w obu wersjach).
7. Uwaga operacyjna do `MUTANTY.md`: położenia 94:10, 117:9, 131:7, 140:18, 140:31, 142:14, 143:7, 146:7 mają po kilka mutantów; domyślny `apply-mutant.js` (n=0) nakłada innego, już zabijanego. Wymagany indeks podano w sekcji „Metoda”.

## Pliki

* Raport: `D:\Temp\claude\ae9476c1eaef6f22\815f5472-44c6-4193-8b95-9672ee7a5b3a\scratchpad\audit\RAPORT-AUDYTU.md`
* Testy rozróżniające: `...\audit\test\kill-mutants.test.js` (ma też usunięte `console.log` do dopisania do repozytorium)
* Fuzz: `...\audit\fuzz\diff-fuzz.js`, log `...\audit\runs\fuzz.log`; wyniki pełnego zestawu na mutantach `...\audit\runs\summary.txt`, wyniki własnych testów `...\audit\runs\kill-summary.txt`
