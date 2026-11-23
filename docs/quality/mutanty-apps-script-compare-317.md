# Rozliczenie mutantów `scripts/quality/apps-script-compare.js` (#317)

Zmiana kodu: nazwy plików pochodzą z wyjścia gita rozdzielonego znakiem NUL (`git status --porcelain -z --no-renames`, `git ls-files -z`) i nie są przycinane; nowa funkcja `splitNul`. Zmienione funkcje: `splitNul` (nowa), `normalizeIndexTrailingNewline`, `compare`. Zmiany testów: trzy testy „znane ograniczenie” dotyczące nazw zastąpione testami poprawnego zachowania (uwaga P2 z audytu do #319); test limitu bufora (ENOBUFS) należy do #318 i został bez zmian.

## Pomiar

Stryker 10.1.1, runner `command` (`node failfast.js test/apps-script-compare.test.js test/apps-script-compare-drift.test.js`; opakowanie przerywa bieg przy pierwszym nieudanym teście i nie zmienia semantyki testów), `coverageAnalysis: off`, pomiar na kopii poza drzewem roboczym (plik zapisuje, usuwa i wylicza ścieżki), Windows 11, Node 24.15.0, git 2.56.1. Linuksa z Node w tym środowisku nie było: wnioski o Linuksie są wnioskowaniem, nie pomiarem (CI na Ubuntu uruchamia te same testy).

| Pomiar | Stan | Wynik |
| --- | --- | --- |
| Kontrola zerowa (pełna, 6 procesów) | kod bez zmian (sha256 `a4aa0632…7379`), testy z `main` = `8892bba` | 312 mutantów: **298 zabitych, 7 Timeout, 7 ocalałych** |
| Kontrola zerowa: powtórka Timeoutów pojedynczo (1 proces) | j.w.; zakres linii 45-51, 114, 182 | 47 mutantów: 41 zabitych, 5 Timeout, 1 ocalały |
| Po zmianie (pełny, 4 procesy) | kod sha256 `1e36d915…69c2`, testy ze zmianą testów nazw | 303 mutanty: **294 zabite, 5 Timeout, 4 ocalałe** |
| Końcowy, zawężony do zmienionych funkcji (4 procesy) | kod j.w., testy z dopisanymi testami zabijającymi ocalałe | linie 66-70 (`splitNul`), 99 (`sourcePathspec`), 118-156 (`normalizeIndexTrailingNewline`, `compare`): **109 mutantów, 109 zabitych, 0 Timeout, 0 ocalałych** |

Sumy kontrolne raportów JSON (artefakty lokalne): kontrola zerowa `aaff484240ac9b0859b02be1c6680b7ff1671801d49d3680a4e639d96fc4dcf2`, powtórka pojedyncza `3338b0830c4f554f5e85d5da8ce9b75d8265e994608a569382526458af01692f`, po zmianie `e0cd5ac4e3228851ac347def010e25d5c2da611d905536934f17c7d6f9975597`, końcowy `b61f939b0ab7a0bfd36df797cf1e254b9aaf42ccc34efe3e0f94e9ba21cb1894`.

Pomiar końcowy jest zawężony, bo po pełnym pomiarze „po zmianie” zmieniły się tylko testy (dopisane testy mogą wyłącznie zabijać kolejne mutanty), a kod pliku jest ten sam; zakres obejmuje wszystkie funkcje dotknięte zmianą oraz linię 99, której mutantów dotyczył audyt. Mutanty poza tym zakresem (m.in. `parseArgs`) mają wynik z pomiaru pełnego „po zmianie”.

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
