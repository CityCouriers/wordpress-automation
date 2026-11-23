# Rozliczenie mutantów `scripts/quality/apps-script-compare.js` (#317)

Zmiana kodu: nazwy plików pochodzą z wyjścia gita rozdzielonego znakiem NUL (`git status --porcelain -z --no-renames`, `git ls-files -z`) i nie są przycinane; nowa funkcja `splitNul`. Zmienione funkcje: `splitNul` (nowa), `normalizeIndexTrailingNewline`, `compare`. Zmiany testów: trzy testy „znane ograniczenie” dotyczące nazw zastąpione testami poprawnego zachowania (uwaga P2 z audytu do #319); test limitu bufora (ENOBUFS) należy do #318 i został bez zmian.

## Pomiar

Stryker 10.1.1, runner `command` (`node failfast.js test/apps-script-compare.test.js test/apps-script-compare-drift.test.js`; opakowanie przerywa bieg przy pierwszym nieudanym teście i nie zmienia semantyki testów), `coverageAnalysis: off`, pomiar na kopii poza drzewem roboczym (plik zapisuje, usuwa i wylicza ścieżki), Windows 11, Node 24.15.0, git 2.56.1. Linuksa z Node w tym środowisku nie było: wnioski o Linuksie są wnioskowaniem, nie pomiarem (CI na Ubuntu uruchamia te same testy).

| Pomiar | Stan | Wynik |
| --- | --- | --- |
| Kontrola zerowa (pełna, 6 procesów) | kod bez zmian (sha256 `a4aa0632…7379`), testy z `main` = `8892bba` | 312 mutantów: **298 zabitych, 7 Timeout, 7 ocalałych** |
| Kontrola zerowa: powtórka Timeoutów pojedynczo (1 proces) | j.w.; zakres linii 45-51, 114, 182 | 47 mutantów: 41 zabitych, 5 Timeout, 1 ocalały |
| Po zmianie (pełny, 4 procesy) | kod sha256 `1e36d915…69c2`, testy ze zmianą testów nazw | 303 mutanty: **294 zabite, 5 Timeout, 4 ocalałe** |
| Pośredni zawężony do zmienionych funkcji (4 procesy) | kod sha256 `1e36d915…69c2`, testy z dopisanymi testami zabijającymi ocalałe | linie 66-70 (`splitNul`), 99 (`sourcePathspec`), 118-156 (`normalizeIndexTrailingNewline`, `compare`): 109 mutantów, 109 zabitych |
| **Końcowy** zawężony do zmienionych funkcji (6 procesów), po poprawce z przeglądu „spróbuj to obejść” (`--literal-pathspecs`) | kod sha256 `d67afcc2…e066`, testy sha256 `df915dd0…88ad` | linie 66-74 (`splitNul`, `LITERAL`), 101-102 (`sourcePathspec`), 121-159 (`normalizeIndexTrailingNewline`, `compare`): **111 mutantów, 111 zabitych, 0 Timeout, 0 ocalałych** |

Sumy kontrolne raportów JSON (artefakty lokalne): kontrola zerowa `aaff484240ac9b0859b02be1c6680b7ff1671801d49d3680a4e639d96fc4dcf2`, powtórka pojedyncza `3338b0830c4f554f5e85d5da8ce9b75d8265e994608a569382526458af01692f`, po zmianie `e0cd5ac4e3228851ac347def010e25d5c2da611d905536934f17c7d6f9975597`, pośredni zawężony `b61f939b0ab7a0bfd36df797cf1e254b9aaf42ccc34efe3e0f94e9ba21cb1894`, końcowy `ee7a3d112c3980278839f1c89c196df32473f26b670e91e98dd2debeab011022`.

Pomiary zawężone wykonano, bo po pełnym pomiarze „po zmianie” zmieniły się tylko testy (pomiar pośredni) oraz poprawka F2 w trzech wywołaniach `add`/`reset` i stałej `LITERAL` (pomiar końcowy); zakres obejmuje wszystkie funkcje dotknięte zmianą oraz `sourcePathspec`, której mutantów dotyczył audyt. Reszta pliku (m.in. `parseArgs`) nie zmieniła się od pełnego pomiaru „po zmianie”, więc jego wynik pozostaje w mocy.

## Kontrola zerowa

Ocalałe w kontroli zerowej (siedem) to te same pozycje, które audyt niezależny z #312 uznał za równoważne: 94:10, 94:18, 114:19, 131:7, 140:18, 143:7, 143:8 ([mutanty-apps-script-compare-audyt-312.md](mutanty-apps-script-compare-audyt-312.md)). Kod pliku nie został zmieniony przed zamknięciem kontroli. Siedem Timeoutów z pierwszego biegu: pięć w `parseArgs` (patrz niżej) oraz 114:78 i 182:20, które przy powtórce pojedynczej (bez równoległości) zostały zabite asercjami, czyli były limitami z obciążenia, a nie pętlami nieskończonymi.

## Ocalałe po zmianie i audyt niezależny

Po zmianie ocalały cztery mutanty (99:10, 99:18, 136:7, 148:7). Rozliczył je **niezależny agent** (osobna sesja; autor zmiany go nie wykonuje; raport: [mutanty-apps-script-compare-audyt-317.md](mutanty-apps-script-compare-audyt-317.md), sha256 kopii w repozytorium `8ae7cf114c4637ff7a5d6884ce8bd38a6ce344bbc1d069c15d7e0a8346f0d8ad`; oryginał przed usunięciem lokalnych ścieżek `1dde202e28db6295c488e0d39eb85b68ac27958ad9e4b107573fe0027a5922be`). Wynik: żaden nie jest równoważny w sensie dowiedzionym, wszystkie zabito testami:

| Mutant | Położenie | Zamiana | Wynik | Test |
| --- | --- | --- | --- | --- |
| 126 | 99:10 | `dir === '.'` → `false` | zabity | „układ w katalogu głównym: git dostaje pathspec `*.gs` i `appsscript.json`, bez przedrostka `./`” (ślad trace2 argumentów gita) |
| 128 | 99:18 | `'.'` → `""` | zabity | j.w. oraz „… komunikat błędu gita poza repozytorium niesie dokładne polecenie z pathspec” |
| 197 | 136:7 | usunięcie `.trim()` przy `ls-files Version.gs` | zabity | „białe znaki zamiast ścieżki z `git ls-files -- Version.gs` oznaczają „plik nieśledzony”: brak git checkout” (atrapa `execFileSync`, bo prawdziwy git nie zwraca samych białych znaków) |
| 225 | 148:7 | `if (!entries.length)` → `if (false)` | zabity | „brak driftu: compare() nie uruchamia git diff …” i wariant ze zmianą tylko w indeksie (ślad trace2: brak wywołania `diff`) |

Dotychczasowe uznanie 99:10, 99:18 (audyt #2/#3 z #312) i 136:7 (audyt #7) za równoważne okazało się więc na wyrost: to pozycja planu P2 („poziom pozycji planu: P2”, mała i lokalna, testy dopisane razem z zabiciem 148:7). Ograniczenia: testy trace2 wymagają gita ≥ 2.22; test z atrapą pinuje implementację (prawdziwy git nie zwraca samych białych znaków).

Mutanty 94:10/94:18, 114:19, 131:7, 140:18, 143:7/143:8 z #312 zniknęły albo zostały zabite przez zmianę kodu i testy; w pomiarze po zmianie ocalały wyłącznie cztery wyżej.

## Przegląd „spróbuj to obejść”

Zmiana dotyka logiki kontroli CI, więc przed prośbą o audyt przeszła niezależny przegląd (osobny agent, tylko odczyt; raport: [mutanty-apps-script-compare-obejscie-317.md](mutanty-apps-script-compare-obejscie-317.md), sha256 kopii w repozytorium `8cf8c8e6e16dd0632014ccef327ec142b12beaeaf6cd8fa8807b9b37bdd2cc7f`; oryginał `cb424118007e2f91d7337dec69be823835243807a79e16ea2ecca00950925aff`). Sama zmiana nie wprowadza obejścia ani fałszywego stopu (każdy przypadek uruchomiony na `8892bba` i na HEAD); wynik: pięć obejść i trzy pozostałe znaleziska, wszystkie istniejące przed zmianą.

- **F2 (obejście)** zmierzone przeze mnie wykonaniem: w repozytorium `a[1].gs` bez końcowej nowej linii i `a1.gs`; po pobraniu `a1.gs` ma inną treść. `git add -- a[1].gs` w `normalizeIndexTrailingNewline` traktował nazwę jak wzorzec, zamiatał `a1.gs` do indeksu, a `compare()` zwracało puste `changes`. Dotyczy nazw jako ścieżek, czyli tej samej klasy co kryteria zgłoszenia, i leży w funkcji dotkniętej zmianą, więc **naprawione w tym PR**: `--literal-pathspecs` w wywołaniach `add`, `add -N` i `reset` (stała `LITERAL`). Testy: „nazwa śledzonego pliku … z globem (a[1].gs) …” (RED na kodzie sprzed poprawki, zielony po) i „polecenia add i reset dostają nazwy plików jako ścieżki dosłowne …” (ślad trace2; zabija mutanty usunięcia opcji). Poziom pozycji planu: P2 (mała, lokalna, wykazana wykonaniem).
- **Pozostałe znaleziska** (F1 katalog z `.gitignore`, F3 i F8 dowiązania, F4 nieprawidłowy UTF-8, F5 wybór układu po manifeście, F6 konfiguracja i `GIT_*`, F7 drobne błędy) istniały przed zmianą (wynik identyczny na `8892bba`), więc idą osobno (problem obecny już na gałęzi bazowej nie blokuje PR): #334, #335, #336, #337, #338, #339. Limit bufora (ENOBUFS) to #318.

## Timeouty

Pięć Timeoutów w pomiarze po zmianie, wszystkie to `i++` → `i--` w `parseArgs` (46:51, 47:56, 48:65, 50:74, 51:72; kod `parseArgs` nie został zmieniony). Reguła właściciela (decyzja właściciela z 2026-11-22): limit czasu liczy się jako wykrycie wyłącznie przy trzech dowodach.

- **(a) z kodu:** `value(i++, flaga)` normalnie przesuwa `i` o 2; po mutacji `i` nie zmienia się w iteracji (−1 z mutanta i +1 z nagłówka pętli), pętla wraca do tego samego `argv[i]`, a `value` nie rzuca, więc nie ma wyjścia; ślady `i`: `0,2,2,2,…` (`--label`), `0,2,4,4,…` (`--patch`), `0,0,0,…` (`--cwd`), `0,1,3,3,…` (`--repo-dir`), `0,1,3,5,5,…` (`--ref-dir`).
- **(b) pojedynczy bieg bez równoległości:** powtórka Stryker z 1 procesem (zakres linii 45-51, 114, 182): wszystkie pięć nadal Timeout; ponadto wycięta funkcja pod `timeout 15`: oryginał kod 0 w ok. 0,14 s, każdy z pięciu mutantów kod 124 po 15 s.
- **(c) ocena osobnego agenta:** [mutanty-apps-script-compare-timeouty-317.md](mutanty-apps-script-compare-timeouty-317.md), sha256 `00dd1cdee64dbab001795b3e426560b7138c9cb25de67dda66e8ba5bb11cb5f5`. Werdykt: wszystkie pięć to nieskończona pętla dla wejścia z testów, żaden nie jest wolnym testem ani wyjątkiem.

W pomiarze po zmianie nie ma innych Timeoutów.

## Testy po zmianie (kryterium 3, uwaga z audytu do #319)

Zastąpione testy „znane ograniczenie” (nazwy): nieśledzony plik ze spacją, z wiodącym NBSP, ze znakami spoza ASCII i kilka naraz (raport i patch zawierają je w całości); śledzony plik z wiodącą spacją albo NBSP w nazwie, różniący się samą końcową nową linią, nie jest driftem (na Windowsie wpis wstawiany bezpośrednio do indeksu; wariant przez CLI jest pomijany na Windowsie i wykonuje się dopiero w CI na Linuksie, lokalnie niezmierzony); przemianowanie w indeksie i z intent-to-add nie daje osobnego wpisu o poprzedniej nazwie (`--no-renames`). Na niezmienionym kodzie 10 z 16 nowych i zmienionych testów jest czerwonych (dowód RED), pozostałe 6 pilnuje mutantów po zmianie. Test ENOBUFS (#318) bez zmian.

## Kopie pomiarowe

Kopia pomiarowa poza drzewem roboczym (plik zapisuje i usuwa pliki oraz wylicza ścieżki) i katalog doświadczeń z gitem po pomiarze zostały zgłoszone do usunięcia (decyzja właściciela z 2026-11-22).
