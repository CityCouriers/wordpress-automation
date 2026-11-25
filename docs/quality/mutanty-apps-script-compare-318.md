# Rozliczenie mutantów `scripts/quality/apps-script-compare.js` (#318)

Zmiana kodu: jawny limit wyniku gita `GIT_MAX_BUFFER` (256 MiB, jak w `apps-script-drift.js` i `debt-ratchet.js`) w `git()` (`execFileSync`) i w `spawnSync('git', ['show', ...])` w `normalizeIndexTrailingNewline`. Domyślny `maxBuffer` Node (1 MiB) powodował wyjątek ENOBUFS przy diffie większym niż 1 MiB i obcięty stdout ze statusem `null` (fałszywy drift) przy blobie większym niż 1 MiB. Zmienione funkcje: `git`, `normalizeIndexTrailingNewline` (w tym warunek pominięcia pliku: `shown.error || shown.status !== 0`, poprawka F1 z przeglądu obejść); nowa stała `GIT_MAX_BUFFER`.

Zmiany testów: trzy testy z wejściem 3 MiB (diff, nieśledzony plik, śledzony plik bez końcowej nowej linii) oraz dwie atrapy `spawnSync` dla `git show`: awaria gita ze statusem 128 (zastępuje ENOBUFS ze statusem `null`) i status 0 z błędem ENOBUFS i obciętym stdout (F1). Dawny test „znane ograniczenie: gdy git show kończy się niepowodzeniem (ENOBUFS), plik bez końcowej nowej linii nie jest normalizowany” (uwaga P2 z audytu do #319, zgłoszenie #318 kryterium 3) został zastąpiony: kod nie ma już ENOBUFS dla wyników do 256 MiB, więc utrwalanie tego ograniczenia byłoby fałszem. Atrapa zostaje dla innej awarii `git show` (kierunek bezpieczny: plik pozostaje widoczny jako drift) i zabija mutanty `shown.status !== 0`.

Dlaczego 3 MiB, a nie granica 1 MiB: tuż nad limitem wynik `spawnSync` zależał od wyścigu (`status` `null` albo 0, gdy git zdążył wyjść; test był niestabilny w CI na Linuksie, #319). Dla wejścia kilka MiB większego niż limit stdout jest obcięty, a status zawsze `null`, więc test jest deterministyczny. Po poprawce wynik nie zależy od wielkości (do 256 MiB).

## Dowód RED/GREEN

Na niezmienionym kodzie z `main` = `1607f42` trzy nowe testy są czerwone (diff: `spawnSync git ENOBUFS`; nieśledzony plik: `spawnSync git ENOBUFS` w `git diff`; blob: niezgodny wynik, plik raportowany jako drift), czwarty (atrapa z innym kodem wyjścia) zielony, bo pilnuje mutantów. Piąty test (status 0, błąd ENOBUFS i obcięty stdout; poprawka F1 z przeglądu obejść) jest czerwony na kodzie bez `shown.error ||` (`changes` puste zamiast ` M Big.gs`). Po poprawkach wszystkie pięć zielone. Zmierzone wykonaniem także na samym kodzie (skrypt wywołujący `compare()` na repozytorium z plikami 3 MiB) przed zmianą: diff kończył się wyjątkiem ENOBUFS, blob większy niż 1 MiB dawał ` M Big.gs`.

## Pomiar

Stryker 10.1.1, runner `command` (`node failfast.js test/apps-script-compare.test.js test/apps-script-compare-drift.test.js`; opakowanie przerywa bieg przy pierwszym nieudanym teście i nie zmienia semantyki testów), `coverageAnalysis: off`, pomiar na kopii poza drzewem roboczym (plik wywołuje gita, zapisuje i usuwa pliki oraz wylicza ścieżki), Windows 11, Node 24.15.0. Przed każdym startem zmierzony zapas pamięci (limit zatwierdzenia minus zatwierdzone) co najmniej 20 GB.

**Uchybienie co do kolejności:** kod i testy zostały napisane przed kontrolą zerową (zasada: najpierw kontrola zerowa). Kontrolę zerową wykonano później na kopii z `origin/main` (`git archive`), czyli na kodzie sprzed zmiany (sha256 `d67afcc2…e066`, testy sha256 `df915dd0…88ad`), więc jej wynik dotyczy dokładnie pliku sprzed zmiany; zmiany w drzewie roboczym nie miały na nią wpływu.

| Pomiar | Stan | Wynik |
| --- | --- | --- |
| Kontrola zerowa (pełna, 6 procesów, `timeoutMS` 60 s) | kod i testy z `main` = `1607f42` | 305 mutantów: **272 zabite, 33 Timeout, 0 ocalałych** |
| Powtórka limitów czasu pojedynczo (1 proces, `timeoutMS` 300 s): 28 poza `parseArgs`, zakresy linii 129, 150-151, 157-158, 182-187, 187-191, 196-200 (zakresy wskazują nadzbiór mutantów; kilka powtórek, bo Stryker pomija mutanty o zasięgu wykraczającym poza zakres) | j.w. | 28 z 28 **zabitych** (limity z obciążenia maszyny, nie pętle nieskończone) |
| Pełny po pierwszej wersji zmiany (4 procesy, `timeoutMS` 180 s; zastąpiony przez wiersz niżej) | kod sha256 `34140b08…5dd47`, testy sha256 `942141b5…b147a` | 307 mutantów: 302 zabite, 5 Timeout, 0 ocalałych (raport sha256 `963a6c3b096bafbebec409430b97c957f934dccae199e1d4a2d40b61d3e35499`) |
| **Końcowy, pełny po zmianie z poprawką z przeglądu „spróbuj to obejść” (4 procesy, `timeoutMS` 180 s)** | kod sha256 `0d1135d9072b8b030f44d1191eb57d94bf1490e0e63a5471f99041c56f16523b`, testy sha256 `c0e1dd30a8f7561867cc640dd4aee5ea129f6f5f231ba7dfd405b11594c1744c` (dokładnie drzewo HEAD PR; sprawdzone `cmp`), drift-testy bez zmian | 309 mutantów: **304 zabite, 5 Timeout, 0 ocalałych**; 5 Timeoutów to pętle nieskończone `parseArgs` |

Sumy kontrolne raportów JSON (artefakty lokalne): kontrola zerowa `646dae8290aee9eb298b4c29ed5b93abfcb611b499b0d7b6054cddd2f121c1ab`; powtórki pojedyncze: `30eb67779cfc742db7309e135a94ed233b918612e32ebd93e212b4fb2cbceee2` (16 mutantów, z tego 10 z listy limitów), `47e33022447f60fbf9c236ac520d887dae136fe6ef5008f2f8db0b3f903b9dd1` (45), `dc0b59eec1b9685cc48df0f124785e311427055f18121b2260483ccc88733c36` (15), `995da38edd7da7506a0cace9d69b48bebeff007e45b1713cb47199681c1711fa` (10); jedna dodatkowa powtórka z błędnie dobranymi zakresami kolumn trafiła w te same 16 mutantów co pierwsza i nic nie wniosła (nie liczona); końcowy pełny `251fce60e2f05461bc9f0eaab1ecbec5f283c66d5b41f4f10226824eadb229b6`.

Mutanty funkcji dotkniętych zmianą (`git`, `GIT_MAX_BUFFER`, `normalizeIndexTrailingNewline`) wszystkie zabite w pomiarze końcowym; 4 nowe mutanty względem kontroli zerowej (309 zamiast 305) to wyrażenie `256 * 1024 * 1024` (zmiana `*` na `/` daje 256 B, zabija je każdy test z plikiem większym niż 256 B, w tym nowe z 3 MiB) oraz warunek `shown.error || shown.status !== 0` (zabija je test ze statusem 0 i błędem ENOBUFS).

## Kontrola zerowa

Brak ocalałych mutantów (kod z #333 zamknął wszystkie siedem z #312). Zero ocalałych w pełnym biegu; 33 limity czasu: 5 w `parseArgs` (niżej) i 28 z obciążenia (kontrola zerowa trwała 2 h 44 min, bo maszyna była obciążona innymi pracami, a pojedyncza powtórka zabiła wszystkie 28). Kod pliku nie został zmieniony przed zamknięciem kontroli w kopii.

## Przegląd „spróbuj to obejść”

Zmiana dotyka kontroli CI, więc przeszła niezależny przegląd (osobny agent, tylko odczyt; raport: [mutanty-apps-script-compare-obejscie-318.md](mutanty-apps-script-compare-obejscie-318.md), sha256 kopii w repozytorium `551e5fef60aa3326060552f47fb48d8ae06e00cc718bd73fbb6a1473f526a1b9`, identyczna z oryginałem). Zmiana nie wprowadza nowego obejścia; cztery znaleziska istniały przed nią. Rozliczenie (sprawdzone wykonaniem):

- **F1 (obejście, naprawione w tym PR):** `git show` ze statusem 0, błędem ENOBUFS i obciętym stdout (Linux): obcięty prefiks plus `
` uchodził za samą różnicę nowej linii i `git add` kasował brakujący ogon pliku. Test z atrapą odtwarza to deterministycznie: RED na kodzie sprzed poprawki (`changes` puste zamiast ` M Big.gs`), zielony po dodaniu `shown.error ||` do warunku pominięcia. Poziom pozycji planu: P2 (mała, lokalna, wykazana wykonaniem; reguła skilla: obejścia naprawiamy w PR).
- **F2 (UTF-8, różne bajty uchodzą za ten sam napis):** istniało przed zmianą; ma już zgłoszenie #336 (dopisany komentarz z wejściami).
- **F3, F4 (diff i pliki powyżej 256 MiB: wyjątek zamiast raportu, ślad intent-to-add po wyjątku):** nieosiągalne dla Apps Script; zgłoszenie #344 (P4).

## Ocalałe po zmianie

Brak. Żaden mutant nie wymaga uznania za równoważny, więc osobny audyt równoważności nie jest potrzebny.

## Timeouty

Pięć Timeoutów w pomiarze końcowym (i te same pięć w kontroli zerowej): `i++` → `i--` w `parseArgs` (46:51, 47:56, 48:65, 50:74, 51:72). Kod `parseArgs` nie jest zmieniany w tym PR (linie i kolumny bez zmian). Rozliczenie, wraz z trzema dowodami wymaganymi przez regułę właściciela (z kodu, pojedynczy bieg bez równoległości, ocena osobnego agenta), jest w [mutanty-apps-script-compare-timeouty-317.md](mutanty-apps-script-compare-timeouty-317.md) i [mutanty-apps-script-compare-317.md](mutanty-apps-script-compare-317.md) (rozdział „Timeouty”); nie jest tu powtarzane.

## Czego nie rozliczono

- Pomiar dotyczy Windows; wynik testów na Linuksie to CI (te same testy). Plik 3 MiB nie powinien zależeć od platformy, bo limit jest dużo większy niż rozmiar wejścia.
- `maxBuffer` nie zmieniono w `pull()` (`spawnSync clasp pull`): jego wyjście jest małe, a przekroczenie kończy się jawnym błędem „Pull failed” (poza zakresem zgłoszenia; poziom pozycji planu: P4).

## Kopie pomiarowe

Kopie pomiarowe poza drzewem roboczym (`ctrl` dla kontroli zerowej i `after` dla pomiaru po zmianie, każda z `node_modules`, raportami i katalogami `.stryker-tmp`) zostały zgłoszone do usunięcia po zakończeniu pomiaru (decyzja właściciela z 2026-11-22).
