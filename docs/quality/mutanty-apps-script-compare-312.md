# Rozliczenie mutantów `scripts/quality/apps-script-compare.js` (#312)

Plik kodu **nie został zmieniony** (`scripts/quality/apps-script-compare.js` identyczny z `main` = `b4abce3`). Zmiany to wyłącznie testy w `test/apps-script-compare.test.js` (istniejące testy bez zmian) oraz ten dokument i raport audytu.

## Pomiar

Stryker 10.1.1, runner `command` (`node --test test/apps-script-compare.test.js test/apps-script-compare-drift.test.js`), `coverageAnalysis: off`, pomiar na kopii poza drzewem roboczym, Windows 11, Node 24.15.0, git 2.56.1. Linuksa z Node w tym środowisku nie było: wnioski o Linuksie są wnioskowaniem, nie pomiarem (CI na Ubuntu uruchamia te same testy).

| Pomiar | Stan | Wynik (312 mutantów) |
| --- | --- | --- |
| Kontrola zerowa, krok 1 (tylko `apps-script-compare.test.js`) | `main` = `b4abce3` | 250 zabitych, 8 Timeout, 54 ocalałych |
| Kontrola zerowa, krok 2 (linie z kroku 1 ponownie, oba pliki testów; lista wiążąca) | `main` = `b4abce3` | z 182 mutantów: 153 zabitych, 7 Timeout, **22 ocalałych** |
| Pomiar końcowy (pełny) | HEAD `04435b5`, kod pliku identyczny z `main` | **299 zabitych, 6 Timeout, 7 ocalałych** (wszystkie 7 uznane za równoważne) |

Sumy kontrolne raportów JSON (artefakty lokalne): kontrola zerowa krok 2 `6f7e328cd83a2fcccd8635ce5e3c9b67623542bd6bdc51368ba76298fd8bd043`, pomiar końcowy `92deff471ab65213f8b43fb234ce55c9ec0938fc1a60075ed82a123dfa50af35`.

Pomiar końcowy dotyczy HEAD `04435b5`. Późniejsze commity tej gałęzi zmieniają komentarze w teście i dokumentację, a od rundy 2 także jeden test (mutant 10, 117:9, patrz „Test mutanta 10”); kod pliku bez zmian.

Pomiar zawężony po zmianie testu mutanta 10 (zakres, którego zmiana dotyka: `normalizeIndexTrailingNewline`, linie 113-122, `stryker run` z `mutate: …:113-122`, te same dwa pliki testów, kod pliku identyczny z `main`): **33 mutanty, 32 zabite, 1 ocalały (114:19, równoważny, audyt #4)**, brak Timeoutów. sha256 raportu (artefakt lokalny) `f6a62bb7646e2caf55d3a898143bdaa9e1ea9a792ca06eacad3b8dd7eaa71a48`. Pozostałe mutanty pliku leżą poza zakresem zmienionego testu (zmieniony test wykonuje tylko `compare()` na małym repozytorium z ścieżką normalizacji indeksu), więc ich wynik z pomiaru pełnego na `04435b5` pozostaje w mocy.

## Tabela 22 mutantów

Położenie to linia:kolumna według Stryker.

| # | Położenie | Zamiana | Wynik | Test / audyt |
| --- | --- | --- | --- | --- |
| 1 | 64:68 | stdio `['ignore','pipe','pipe']` → `[]` | zabity | „stdin gita to urządzenie znakowe (null), nie potok …” |
| 2 | 64:69 | `'ignore'` → `""` | zabity | „git poza repozytorium: błąd niesie stderr gita …” |
| 3 | 64:79 | pierwszy `'pipe'` → `""` | zabity | j.w. |
| 4 | 64:87 | drugi `'pipe'` → `""` | zabity | j.w. |
| 5 | 73:57 | `process.platform === 'win32'` → `true` | zabity | „pull(): opcja shell zależy od platformy …” |
| 6 | 94:10 | `dir === '.'` → `false` | **równoważny** | audyt #2 |
| 7 | 94:18 | `'.'` → `""` | **równoważny** | audyt #3 |
| 8 | 114:19 | usunięcie `.filter(Boolean)` | **równoważny** | audyt #4 |
| 9 | 114:93 | `s.trim()` → `s` | zabity | „znane ograniczenie: … wiodącą spacją albo NBSP …” |
| 10 | 117:9 | `shown.status !== 0` → `false` | zabity | „znane ograniczenie: gdy git show kończy się niepowodzeniem (ENOBUFS) …” (atrapa wyniku `spawnSync`, patrz niżej) |
| 11 | 131:7 | usunięcie `.trim()` przy `ls-files Version.gs` | **równoważny** | audyt #7 |
| 12 | 140:18 | `l.trim()` → `l` | **równoważny** | audyt #8 |
| 13 | 140:31 | `startsWith('??')` → `endsWith('??')` | zabity | „zmiana tylko w indeksie, której ścieżka kończy się na ?? …” |
| 14 | 142:14 | `/\s+$/` → `/\s$/` | zabity | „białe znaki na końcu … (dwa NBSP)” |
| 15 | 142:22 | `''` → `"Stryker was here!"` | zabity | „białe znaki na końcu … (dwa NBSP)”, „jeden końcowy NBSP …” |
| 16 | 143:7 | `!changes.trim()` → `false` | **równoważny** | audyt #12 |
| 17 | 143:8 | `changes.trim()` → `changes` | **równoważny** | audyt #13 |
| 18 | 145:21 | usunięcie filtra `startsWith('??')` | zabity | „plik usunięty w żywym projekcie jest driftem …” |
| 19 | 145:66 | `'??'` → `""` | zabity | j.w. |
| 20 | 145:82 | `l.slice(3).trim()` → `l.slice(3)` | zabity | „znane ograniczenie: nieśledzony plik z wiodącym NBSP …” |
| 21 | 146:7 | `if (untracked.length)` → `if (true)` (`git add -N`) | zabity | „drift tylko w śledzonym pliku przy zajętym indeksie …” |
| 22 | 148:7 | `if (untracked.length)` → `if (true)` (`git reset`) | zabity | „normalizacja indeksu zostaje po przebiegu z driftem …” |

Zabitych 15, równoważnych 7. Dowód RED (każdy zabity mutant nałożony pojedynczo na kopię, nowy test czerwony, oryginał zielony): wiersze 1-5, 9, 10, 13-15, 18-22 (dla 1, 9, 10, 13, 14, 15, 20, 21 zmierzone na HEAD `04435b5`, dla pozostałych na `fd177d1`).

## Mutanty równoważne i audyt niezależny

Mutanty 6, 7, 8, 11, 12, 16, 17 (siedem ocalałych w pomiarze końcowym) rozliczył **niezależny agent** (osobna sesja bez dostępu do rozumowania autora; autor zmiany go nie wykonuje). Raport: [mutanty-apps-script-compare-audyt-312.md](mutanty-apps-script-compare-audyt-312.md), sha256 `52bc3c5266a2683ff04ca0aa20ee21bc5339123781d58f191fa116fafd399a3f`. Numeracja audytu (#1-#15) odpowiada kolejności z tabeli 15 mutantów poddanych audytowi (64:68, 94:10, 94:18, 114:19, 114:93, 117:9, 131:7, 140:18, 140:31, 142:14, 142:22, 143:7, 143:8, 145:82, 146:7).

Audyt pierwotnie dostał 15 kandydatów na równoważne; **osiem z nich okazało się zabijalnych** (audyt #1, #5, #6, #9, #10, #11, #14, #15) i zostało zabitych testami powyżej. Zgłoszenie „równoważny” było więc na wyrost w połowie przypadków, co potwierdza sens weryfikacji.

Ograniczenia obserwowalności siedmiu równoważnych (z audytu): #2/#3 (git normalizuje `./` w pathspec; sprawdzone na git 2.56.1, tylko tej wersji), #4 i #12 (różnią się wyłącznie dodatkowym wywołaniem gita; brak rozbieżności wykazano empirycznie i fuzzem różnicowym, nie dowodem z kodu gita), #7, #8 i #13 (tożsamość warunków).

## Timeouty (AC7)

W pomiarze końcowym 6 Timeoutów, wszystkie to **pętle nieskończone, nie zabicie asercją**: `i++` → `i--` w `parseArgs` (45:36, 46:51, 47:56, 48:65, 50:74, 51:72). Dowód: funkcja `parseArgs` wyjęta ze zmutowanego pliku i uruchomiona z flagą wymagającą wartości kończy się kodem 124 po limicie 15 s (`timeout 15`), a oryginał z tymi samymi argumentami kończy się w mniej niż 1 ms. Sumy kontrolne dowodów: `timeouts-log.txt` `6c9840c4c7975a0aa35770e95179bc90c408ae7bd53cf11055065a762ce1158e`. Runner Stryker kończy je limitem czasu, więc są wykryte (testy nie przechodzą), ale przez zawieszenie, nie przez asercję.

Trzy mutanty (114:78, 121:86, 121:93) w pierwszym pomiarze końcowym przy obciążonej maszynie dały Timeout; uruchomione osobno na pełnym zestawie testów kończą się czerwono asercjami w 40-90 s (`timeouts2-log.txt` `f8013f60ea1ec92dd6deae04afa1dc0ee2a7395392ab55c725948a1d3803b309`), a w pomiarze na HEAD są zabite.

## Testy charakteryzujące znane ograniczenia

Trzy testy (mutanty 9, 10, 20) zapisują obecne, błędne zachowanie kodu, bo jedyną obserwowalną różnicą mutanta jest właśnie to ograniczenie. Naprawy poza zakresem #312: #317 (nazwy plików z `git status`/`ls-files` przycinane i bez `-z`) oraz #318 (limit 1 MiB wyniku gita). Naprawa odwróci asercje tych testów. Aktualizacja: #317 naprawiło część dotyczącą nazw plików i odwróciło testy mutantów 9 i 20 (rozliczenie w [mutanty-apps-script-compare-317.md](mutanty-apps-script-compare-317.md)); test mutanta 10 (limit bufora) czeka na #318.

### Test mutanta 10 (117:9): atrapa zamiast pliku 1 MiB + 1 B

Pierwsza wersja tego testu używała prawdziwego pliku o rozmiarze równym limitowi `maxBuffer` plus jeden bajt i na tym samym HEAD (`b5e314b`) raz przeszła, raz padła w CI na Linuksie (`'' !== ' M Big.gs'`). Przyczyna: gdy wynik `spawnSync` przekracza `maxBuffer`, Node ustawia `error: ENOBUFS` i zabija proces; `status` jest `null`, gdy git jeszcze żył, a `0`, gdy zdążył wyjść (stdout jest wtedy pełny, plik jest normalizowany i test dostaje `''`). Przy rozmiarze tuż nad limitem ostatni fragment danych jest mały, więc wynik zależy od wyścigu. Zmierzone lokalnie (Windows): `git show` bloba 1 048 577 B dało `status=null` i pełny stdout 200 razy na 200, a blob 3 MiB `status=null` i stdout obcięty; samego wyścigu na Linuksie lokalnie nie odtworzono (brak Node pod Linuksem), jest to wniosek z przebiegu CI i z dokumentacji Node.

Większy plik nie pomaga: mutant `status !== 0` → `false` jest obserwowalny tylko wtedy, gdy stdout jest pełny mimo niepowodzenia, a to zachodzi dokładnie na granicy limitu. Test używa więc małego pliku i atrapy `spawnSync` dla `git show` zwracającej to, co Node zwraca przy ENOBUFS (`status: null`, `error: ENOBUFS`, pełny stdout), a w drugiej połowie sprawdza, że bez atrapy ten sam plik jest normalizowany. Nie zależy to od rozmiaru, platformy ani wyścigu. Dowód: mutant 117:9 nałożony na kopię daje czerwony test (`actual: ''`), oryginał zielony; 50 uruchomień pod rząd testu i pozostałych testów charakteryzujących: 50 zielonych. Pozostałe nowe testy (nazwy ze spacją i NBSP, deskryptor stdin, blokada indeksu, wpisy tylko w indeksie) nie zależą od rozmiaru ani czasu: ich wynik wynika z deterministycznego zachowania gita i systemu plików, a w CI przeszły na Linuksie.

## Ograniczenia platformowe

Mutant 73:57 (`shell`) rozliczony dla obu gałęzi atrapą platformy (`win32`/`linux`/`darwin`). Testy NBSP i wpisów tylko w indeksie nie zależą od nazewnictwa NTFS (plik nie powstaje na dysku lub nazwa zawiera NBSP, który NTFS dopuszcza). Test „stdin gita to urządzenie znakowe” opiera się na różnicy `/dev/null` (urządzenie znakowe) i potoku; na Windows zmierzony, na Linuksie wynika z konstrukcji i zostanie sprawdzony w CI.
