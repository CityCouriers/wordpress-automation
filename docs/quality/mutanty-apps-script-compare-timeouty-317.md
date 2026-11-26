# Ocena (c): pięć mutantów Timeout w `parseArgs` (apps-script-compare.js)

Oceniający: osobny agent, niebędący autorem zmiany. Plik oceniany: `scripts/quality/apps-script-compare.js`, sha256 a4aa0632e799b69ad584b1e899c5b01dbbf1116bb88307fdf8d3cc90a1b07379 (zweryfikowany przed oceną). Zestaw testów: `git show HEAD:test/apps-script-compare.test.js` oraz `test/apps-script-compare-drift.test.js` (bez zmian względem HEAD; w statusie git zmodyfikowany jest tylko `test/apps-script-compare.test.js`). Nic w repozytorium ani w kopii pomiarowej Strykera nie zostało zmienione; eksperymenty w `scratchpad/ocena-c/`.

## Dowód (a) z kodu

Pętla (linie 45-53): `for (let i = 0; i < argv.length; i++)`, a w gałęzi flagi wywołanie `value(i++, '<flaga>')`. Wyrażenie `i++` przekazuje do `value` bieżące `i`, po czym zwiększa `i` o 1, a `i++` z nagłówka pętli zwiększa o kolejne 1: normalnie `i` przeskakuje o 2 (flaga + wartość). Po mutacji `i--` wyrażenie przekazuje bieżące `i`, zmniejsza `i` o 1, a nagłówek pętli zwiększa o 1: wypadkowa zmiana `i` w tej iteracji to 0. Pętla wraca do tej samej iteracji z tym samym `i`; `argv[i]` jest wciąż tą samą flagą, `value(i, flaga)` dostaje te same dane, więc ponownie nie rzuca (`i + 1 < argv.length` i `argv[i+1]` nie zaczyna się od `--` są niezmienne, bo `argv` i `i` się nie zmieniają). Nie ma wyjątku, nie ma `break`, nie ma zmiany stanu prowadzącej do wyjścia: pętla nie kończy się dla żadnego wejścia, w którym zmutowana flaga występuje z poprawną wartością. Gdy wartości brakuje (test „flaga bez wartości"), `value` rzuca w pierwszej iteracji i mutant nie zapętla (to wejście nie jest wejściem, na którym mutant wisi).

Wejścia testów, które zawierają daną flagę z poprawną wartością (numery linii w HEAD:test/apps-script-compare.test.js, a dla drift w test/apps-script-compare-drift.test.js):

| mutant | linia/kol. | wejście z testów |
|---|---|---|
| `--label` | 46:51 | `['--cwd', root, '--label', 'v9.9.9', ...]` (helper `run`, l. 56, używany przez większość testów); `['--cwd', root, '--label', 'v1']` (l. 219, 230, 284, 409) |
| `--patch` | 47:56 | `['--cwd', root, '--label', 'v9.9.9', '--patch', 'drift.patch']` (l. 99, 107, 118, 149); `['--patch', 'out.patch', '--cwd', root]` (l. 249); drift l. 77 z `['--patch', 'drift.patch']` |
| `--cwd` | 48:65 | prawie każdy test: `['--cwd', root, ...]`; drift: `['--drift', '--cwd', cwd, '--repo-dir', fx.dir]` (l. 77, 175) |
| `--repo-dir` | 50:74 | drift l. 77 i 175: `['--drift', '--cwd', cwd, '--repo-dir', fx.dir, ...]` |
| `--ref-dir` | 51:72 | drift l. 125-130: `['--drift', '--cwd', cwd, '--repo-dir', fx.dir, '--ref-dir', refDir]` |

Helpery `runNodeSync` i `runNode` (`test/helpers/node-child.js` l. 84-121) nie ustawiają limitu czasu (`spawnSync`/`spawn` bez `timeout`), więc zapętlony potomek wiesza test do czasu zabicia go z zewnątrz (limit Strykera). To jest wprost nieskończona pętla w kodzie, a nie wolny test.

## Dowód z eksperymentu

Pozycje kolumn potwierdzone: na pozycjach 46:51, 47:56, 48:65, 50:74, 51:72 jest dokładnie `i++` (sprawdzone programowo); każda kopia różni się od oryginału tylko tą jedną linią (diff 1 linii na mutant).

Ślad wartości `i` (kopia `parseArgs` wycięta dosłownie z linii 39-55, licznik przerywa po 12 iteracjach), wejście z testów:

| mutant | wejście | `i` w kolejnych iteracjach |
|---|---|---|
| `--label` | `--cwd R --label v9.9.9` | 0,2,2,2,2,... |
| `--patch` | `--cwd R --label v9.9.9 --patch drift.patch` | 0,2,4,4,4,... |
| `--cwd` | `--cwd R --label v1` | 0,0,0,0,... |
| `--repo-dir` | `--drift --cwd P --repo-dir F` | 0,1,3,3,3,... |
| `--ref-dir` | `--drift --cwd P --repo-dir F --ref-dir W` | 0,1,3,5,5,5,... |

Oryginał na wejściu `--ref-dir` kończy pętlę normalnie (rc=0).

Bieg jednostkowy `parseArgs` (oryginał vs mutant, to samo wejście, `timeout 15`):

| mutant | oryginał | mutant |
|---|---|---|
| `--label` | rc=0, 0.13 s | rc=124, 15.14 s |
| `--patch` | rc=0, 0.14 s | rc=124, 15.14 s |
| `--cwd` | rc=0, 0.14 s | rc=124, 15.15 s |
| `--repo-dir` | rc=0, 0.13 s | rc=124, 15.14 s |
| `--ref-dir` | rc=0, 0.14 s | rc=124, 15.15 s |

Bieg całego CLI (kopia `scripts/quality/` z jedną mutacją, `APPS_SCRIPT_PULL_CMD="node fake-clasp.js"`, repo git z `src/`), `timeout 15`:

| wejście | oryginał | mutant |
|---|---|---|
| `--cwd R --label v9.9.9` | rc=0, 576 ms, „Apps Script matches v9.9.9" | `--label`: rc=124, 15.2 s; `--cwd`: rc=124, 15.2 s |
| `--cwd R --label v9.9.9 --patch drift.patch` | rc=0, 556 ms | `--patch`: rc=124, 15.1 s |
| `--drift --cwd W --repo-dir R` | rc=1, 121 ms (kończy się błędem „GITHUB_REPOSITORY…", brak pętli) | `--repo-dir`: rc=124 |
| `--drift --cwd W --repo-dir R --ref-dir W2` | rc=1, 457 ms (ten sam błąd) | `--ref-dir`: rc=124, 15.1 s |

Uwaga do dwóch ostatnich wierszy: bez atrapy API GitHuba oryginał kończy się szybkim błędem dalszego etapu, nie sukcesem; istotne jest, że parsowanie argumentów w oryginale się kończy i program idzie dalej, a w mutancie nigdy nie wychodzi z `parseArgs`. W testach drift (atrapa API w `fake`) oryginał przechodzi.

Kontrola negatywna: `--cwd R --label` (brak wartości) kończy się rc=1 „`--label requires a value`" zarówno w oryginale, jak i w mutancie `--label` (wyjątek przerywa pętlę), co potwierdza, że wiszenie wynika z konkretnej ścieżki „flaga z poprawną wartością", a nie z ogólnej wady harnessu.

## Werdykty

Dowód (a) spełniony, dowód (b) wg zgłoszenia już wykonany (nie powtarzany tu pojedynczo na Stryker-owej kopii, ale 15 s-owe biegi jednostkowe i CLI powyżej są biegami pojedynczymi, bez równoległości, i dają to samo), przyczyna to wyłącznie nieskończona pętla, a nie obciążenie.

1. Linia 46, kol. 51 (`--label`): NIESKOŃCZONA PĘTLA (dowód a, wejście: `--cwd R --label v9.9.9`; `i`: 0,2,2,2,...). Uznać za wykrytego.
2. Linia 47, kol. 56 (`--patch`): NIESKOŃCZONA PĘTLA (dowód a, wejście: `--cwd R --label v9.9.9 --patch drift.patch`; `i`: 0,2,4,4,4,...). Uznać za wykrytego.
3. Linia 48, kol. 65 (`--cwd`): NIESKOŃCZONA PĘTLA (dowód a, wejście: `--cwd R --label v1`; `i`: 0,0,0,...). Uznać za wykrytego.
4. Linia 50, kol. 74 (`--repo-dir`): NIESKOŃCZONA PĘTLA (dowód a, wejście: `--drift --cwd P --repo-dir F`; `i`: 0,1,3,3,3,...). Uznać za wykrytego.
5. Linia 51, kol. 72 (`--ref-dir`): NIESKOŃCZONA PĘTLA (dowód a, wejście: `--drift --cwd P --repo-dir F --ref-dir W`; `i`: 0,1,3,5,5,5,...). Uznać za wykrytego.

Żaden z pięciu nie okazał się mutantem, który kończy się wyjątkiem lub wolnym testem. Zastrzeżenia: (1) ocena dotyczy wyłącznie tych pięciu mutantów `i++`→`i--` i nie rozciąga się na inne Timeouty; (2) potomki `node` spawnowane przez testy bez limitu czasu (`runNode`/`runNodeSync`) po ubiciu testu przez Strykera mogą zostać jako osierocone procesy kręcące CPU: warto sprawdzić i zakończyć ręcznie procesy `node ... apps-script-compare.js` po pomiarze (ja tego nie robiłem, bo nie są to moje procesy).

## Polecenia użyte w eksperymencie (katalog `scratchpad/ocena-c/`)

- `sha256sum scripts/quality/apps-script-compare.js` (zgodny z zadanym).
- `git show HEAD:test/apps-script-compare.test.js > /tmp/head-test.js` oraz `grep -n` po flagach w obu plikach testowych.
- `node mk.js <plik>`: sprawdza, że na wskazanych pozycjach jest `i++`.
- `node build.js <worktree> <scratchpad>`: tworzy `cli/<nazwa>/scripts/quality/` (kopia katalogu z jedną mutacją), `unit/<nazwa>.js` (dosłowny wycinek linii 39-55 + `path`) oraz `unit/<nazwa>.trace.js` (licznik iteracji).
- `timeout 15 node unit/<nazwa>.js '<json argv>'`, `node unit/<nazwa>.trace.js '<json argv>'`, `timeout 15 node cli/<nazwa>/scripts/quality/apps-script-compare.js <argumenty testu>` ze `APPS_SCRIPT_PULL_CMD="node fake-clasp.js"` w repo git `e2e/root`.
