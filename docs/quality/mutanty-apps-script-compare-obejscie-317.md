# Przegląd "spróbuj to obejść": compare() w apps-script-compare.js (#317)

Zakres: `git diff 8892bba..48ee2ab -- scripts/quality/apps-script-compare.js` oraz zachowanie całej funkcji `compare`.
Metoda: kopie wersji STAREJ (8892bba, `old/`) i NOWEJ (HEAD worktree, `new/`) w katalogu scratchpad, każdy przypadek
uruchomiony na tym samym stanie wejściowym (kopia katalogu) obiema wersjami. Windows: git 2.56.1, Node 24.15.0.
Przypadki z nazwami specyficznymi dla Linuksa (nowa linia, `*`, `?`, `"`, tab) uruchomione w WSL (Ubuntu,
git 2.43.0, Node 24.15.0); katalog tymczasowy w WSL usunięty po pomiarze. Klon roboczy nietknięty (jedyny kontakt: odczyt
plików; jedna próba `grep` w worktree przez Bash została odrzucona przez system uprawnień, dalej użyto narzędzia Grep).
Skrypty: `harness.js`, `t1.js` ... `t11.js` w tym samym katalogu.

## Wniosek ogólny

Zmiana 8892bba..48ee2ab (`-z`, `--no-renames`, `splitNul`, brak `trim`) działa zgodnie z zamiarem i **nie wprowadza żadnego
nowego obejścia ani nowego fałszywego stopu**. Wszystkie poniższe znaleziska istniały już w wersji 8892bba i dają identyczny
wynik w obu wersjach (kolumny "stare/nowe" niżej). Jedyne różnice zachowania są poprawkami:

- plik nieśledzony ze znakiem spoza ASCII / spacją / tabulatorem / cudzysłowem / nową linią w nazwie: STARE = błąd
  `git add -N -- "src/..."` (wyjątek, krok się wywraca), NOWE = poprawny wpis `??` i patch;
- plik śledzony z taką nazwą, różniący się tylko końcową nową linią: STARE = fałszywy stop (nazwa w cudzysłowie C-style,
  `git show :"..."` kończy się błędem, normalizacja pominięta), NOWE = przepuszcza (zamierzone);
- plik ze zmianą treści o takiej nazwie: oba wykrywają, NOWE ma czytelną nazwę w `changes`.

## Znaleziska

Oznaczenia: (1) obejście / fałszywy brak driftu, (2) fałszywa odmowa albo błąd, (3) utwardzenie / czytelność.
"Nowe?" = czy pojawiło się po 8892bba. Wszystkie poniżej: NIE (stare, bez zmiany po poprawce).

### F1 (1) Plik nowy w katalogu zignorowanym przez .gitignore nie jest widoczny. Nowe?: NIE
Wejście: prawdziwy `.gitignore` repo (zawiera m.in. `reports/`, `coverage/`, `node_modules/`, `.stryker-tmp/`, `.idea/`,
`.vscode/`) + `.gitattributes`; po pobraniu pojawia się `src/reports/Evil.gs` (Apps Script dopuszcza nazwy z ukośnikiem,
clasp zapisuje je jako podkatalogi; wszystkie pliki projektu wykonują się w jednej przestrzeni globalnej).
Oczekiwane: `changes` niepuste (`?? src/reports/Evil.gs`) i patch. Faktyczne: `changes=''`, `patch=''` (STARE i NOWE),
dla wszystkich sześciu katalogów (t5.js). Kontrola: `src/Evil.gs` poza ignorowanym katalogiem daje `?? src/Evil.gs`.
Przyczyna: `git status --porcelain` domyślnie pomija ignorowane (`!!` nie wypisywane bez `--ignored`), a `.git/info/exclude`
i `core.excludesFile` działają tak samo (sprawdzone dla info/exclude: ukryty).
Zakres szkody: w workflow deployu (`deploy-apps-script.yml`, krok porównania po `clasp push`) pobrany projekt zawiera tylko to,
co wypchnięto, więc ryzyko tam jest małe; kontrola jest jednak deklarowana jako dowód "dokładnie tego, co wypchnęliśmy".
Poprawka: `git status --porcelain -z --no-renames --ignored=matching` albo `-uall --ignored` i traktować `!!` jak `??`;
dla patcha `git -c core.excludesFile= ...`/`add -N -f`.

### F2 (1) Glob w nazwie śledzonego pliku bez końcowej nowej linii "zamiata" do indeksu inny plik. Nowe?: NIE
Wejście (Windows, `[` jest dozwolone w nazwie): w repo `src/a[1].gs` o treści `x` (bez `\n`) i `src/a1.gs` o treści
`good\n`; po pobraniu `src/a[1].gs` = `x\n` (przejdzie), a `src/a1.gs` = `EVIL();\n` (realny drift).
Oczekiwane: `changes=' M src/a1.gs'`. Faktyczne: `changes=''`, `patch=''` (STARE i NOWE). Kontrola bez pliku `a[1].gs`:
poprawnie ` M src/a1.gs`.
Linux: to samo z plikiem o nazwie `src/*.gs` (zamiata wszystkie pliki `.gs`; sprawdzone, `changes=''`), `?` analogicznie.
Przyczyna: `git add -- f` w `normalizeIndexTrailingNewline` (linia 126) traktuje `f` jak pathspec z globem; literalna zgodność
nie wyklucza dopasowania globem do innych plików. Ten sam błąd klasy dotyczy `git add -N -- untracked` i `git reset -q --`
(linie 152, 154), tam bez skutku dla wykrycia, bo `changes` jest liczone wcześniej.
Realność: wymaga śledzonego pliku z `[ ] * ?` w nazwie ORAZ braku końcowej nowej linii w repo, więc niska; łatwa poprawka:
`git --literal-pathspecs add -- f` (ew. `:(literal)` jako prefiks pathspecu) we wszystkich trzech miejscach.

### F3 (1) Typ pliku: dowiązanie symboliczne w repo zastąpione zwykłym plikiem przechodzi jako "zmiana końcowej nowej linii". Nowe?: NIE
Wejście: w indeksie `src/L.gs` jako 120000 z celem `Other.gs` (bez `\n`); po pobraniu `src/L.gs` jest zwykłym plikiem o treści
`Other.gs\n`. `git status` pokazuje ` T`. Oczekiwane: drift. Faktyczne: `changes=''` (STARE i NOWE), bo
`normalizeIndexTrailingNewline` uznaje `git show :f` (cel dowiązania) + `\n` == treść pliku i wykonuje `git add`, co
zmienia typ w indeksie (`T `, odfiltrowane przez `e[1] !== ' '`). Kontrola z inną treścią: poprawnie ` T`. To samo przy
`core.symlinks=false` (wtedy ` M`).
Realność: wymaga śledzonego `.gs` będącego dowiązaniem, więc niska. Poprawka: w normalizacji sprawdzać tryb wpisu
(`git ls-files -s -z`, pominąć 120000 i zmiany trybu 100755/100644) albo po normalizacji zweryfikować `git diff --cached
--raw` dla tej ścieżki (tylko ta sama para trybów).

### F4 (1) Nieprawidłowy UTF-8: różne bajty, równe po dekodowaniu. Nowe?: NIE
Wejście: w repo `src/Bin.gs` = bajty `61 FF`; po pobraniu `61 FE 0A`. Oczekiwane: drift. Faktyczne: `changes=''`
(STARE i NOWE). Przyczyna: porównanie `readFileSync(p,'utf8') === indexed + '\n'` (linia 126) po dekodowaniu `spawnSync(...
encoding:'utf8')`; obie strony dają U+FFFD. Realność: Apps Script oddaje UTF-8, więc znikoma. Poprawka: porównywać
bufory (`encoding: 'buffer'`, `Buffer.equals`). BOM, `a`->`a\r`, `a`->`a\r\n`, `a`->`a\n\n`, pusty->`\n`, `a\n`->pusty:
wszystkie poprawnie zatrzymane.

### F5 (1) Brak `src/appsscript.json` przełącza układ na "katalog główny" i usunięcie manifestu nie jest widoczne. Nowe?: NIE
Wejście: po pobraniu usunięty tylko `src/appsscript.json` (`.gs` bez zmian). Oczekiwane: ` D src/appsscript.json`.
Faktyczne: `changes=''` (STARE i NOWE). Przyczyna: `sourceDir()` (linia 93) wybiera układ po istnieniu pliku w katalogu
roboczym PO pobraniu, więc brak manifestu zmienia pathspec na `*.gs` + `appsscript.json` (tylko katalog główny), a
`Version.gs` nie jest przywracany z `src/`. Usunięcie całego `src/` jest wykrywane (` D src/Kod.gs` przez `*.gs`), zmiana
treści manifestu też. Realność: clasp pull zwykle nie usuwa lokalnych plików, a manifest zawsze istnieje w projekcie, więc
niska. Poprawka: układ wybierać z indeksu (`git ls-files --error-unmatch src/appsscript.json`), nie z katalogu roboczego.

### F6 (3, utwardzenie) Konfiguracja i środowisko gita sterują wynikiem. Nowe?: NIE
Wymagają kontroli nad runnerem/środowiskiem, nie nad danymi, więc to utwardzenie, nie obejście:
- `status.showUntrackedFiles=no` (zwykły `git config` w repo): nowy plik `src/New.gs` niewidoczny, `changes=''`;
- `GIT_LITERAL_PATHSPECS=1` albo `GIT_NOGLOB_PATHSPECS=1`: pathspec `src/*.gs` przestaje być globem, `git status` nic nie
  zwraca, zmodyfikowany `src/Kod.gs` daje `changes=''`;
- `core.fsmonitor`: nie udało mi się zbudować działającego haka w tym środowisku (git uruchamiał skrypt jako binarkę), więc
  NIE zweryfikowane; ryzyko analogiczne (hak może ukryć zmiany w katalogu roboczym);
- `assume-unchanged` / `skip-worktree` w indeksie ukrywają modyfikację (zweryfikowane; wymaga ustawienia flag w indeksie);
- `GIT_DIR` wskazujące nieistniejący katalog: błąd (zamknięte bezpiecznie).
Bez wpływu (sprawdzone, wynik identyczny, poprawny): `core.quotePath`, `status.renames=copies`, `diff.renames`,
`core.autocrlf`, `status.branch=true` (nie psuje filtra `e[1]`), `status.relativePaths=false`, `core.untrackedCache`,
`GIT_ICASE_PATHSPECS`, `GIT_GLOB_PATHSPECS`, `GIT_OPTIONAL_LOCKS`.
Poprawka zbiorcza: wywoływać git z `-c status.showUntrackedFiles=all -c core.fsmonitor=false -c core.quotePath=false`,
`--literal-pathspecs` zastąpić jawnym `--glob-pathspecs`, czyścić `GIT_*` (poza `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_SYSTEM`) w `env` przekazywanym do `execFileSync`/`spawnSync`.

### F7 (2, fałszywa odmowa/błąd, bez skutku bezpieczeństwa) Nowe?: NIE
- Katalog o nazwie `*.gs` (np. `src/evil.gs/readme.txt`): `normalizeTrailingNewline` (linia 107) kończy się
  `EISDIR` zamiast wynikiem (STARE i NOWE). Kończy się czerwono, więc bezpiecznie.
- Patch większy niż 1 MB (`maxBuffer` domyślny `execFileSync`): `spawnSync git ENOBUFS` zamiast wyniku z patchem
  (STARE i NOWE; `main()` łapie błąd i kończy kodem 1). Poprawka: `maxBuffer` w `git()` (np. 256 MB).
- Nazwa pliku z nieprawidłowym UTF-8 (Linux): `ENOENT` (zniekształcona nazwa po dekodowaniu); bezpiecznie, błąd.
- Plik śledzony o nazwie `1:foo.gs` w układzie katalogu głównego: `git show ':1:foo.gs'` jest czytane jako etap 1 pliku
  `foo.gs`, normalizacja pominięta, czysta różnica końcowej nowej linii daje fałszywy stop (STARE i NOWE). Poprawka: `git show`
  z `:./` ani `:0:` jest tu nie do użycia; użyć `git cat-file blob :0:<path>` po `ls-files -s -z` (mamy hash) albo
  `git cat-file --batch`.
- Zmiana wyłącznie przez CRLF przy `.gitattributes` `* text=auto eol=lf`: `changes` niepuste, `patch` PUSTY (status mówi `M`,
  `git diff` nic nie pokazuje). Zatrzymuje (poprawnie), ale raport ma pusty patch (czytelność, (3)).

### F8 (3) Efekty uboczne normalizacji poza drzewem (nie obejście)
`normalizeTrailingNewline` (linie 105-109) czyta i zapisuje przez dowiązania: zweryfikowano, że `src/Kod.gs` będące dowiązaniem
do pliku poza katalogiem dopisuje `\n` w pliku docelowym (`secret-no-newline` -> `secret-no-newline\n`), a sama kontrola
zgłasza ` T`. To dokładnie klasa "kod, który zapisuje poza drzewem". Poprawka: `lstat`, pominąć dowiązania, nie
dotykać plików o `nlink > 1`.

### Poza deklarowanym zakresem (informacyjnie, bez zmian względem wcześniej)
- Pathspec obejmuje tylko `*.gs` i `appsscript.json`: plik `src/Page.html` / `src/Evil.js` dodany w projekcie jest niewidoczny
  (`changes=''`, sprawdzone). Jeśli Apps Script ma być kontrolowany w całości, to luka (HTML Service jest wykonywalny).
- `Version.gs` jest przywracany z indeksu przed porównaniem, więc jego treść nie jest weryfikowana w trybie compare
  (świadome; tryb `--drift` porównuje go w całości).

## Sprawdzone bez znalezisk (wynik identyczny w STAREJ i NOWEJ, zgodny z oczekiwaniem)
Baseline czysty; sama brakująca końcowa nowa linia w repo przepuszczona; realna zmiana treści zatrzymana; usunięcie pliku
(` D`), nowy plik (`??`), przemianowanie w katalogu roboczym (` D` + `??`), przemianowanie w indeksie z modyfikacją (stare
`RM a -> b`, nowe `AM b`: oba zatrzymują), kopia (`??`), nieśledzony katalog z `.gs` (wpis na poziomie pliku), konflikt scalenia `UU`,
zmiana manifestu; nazwy: spacja wewnątrz i wiodąca, NBSP, `zażółć`, U+200B, `-dash`, `#`, `'`, `$`, `,`, `[1]`, `*`, `?`,
`"`, tab, nowa linia (Linux) — wszystkie poprawnie (wykrycie + przepuszczenie samej nowej linii + plik nieśledzony);
`status.branch=true` nie wprowadza wpisu `##` do wyniku; `-z` z `--no-renames` nie dzieli wpisów przemianowania.
Nie testowane: submoduły/gitlinki (nazwa `*.gs` dla submodułu nierealna), złącza Windows, twarde dowiązania, `core.fsmonitor`
(hak nie działał), wpisy `!!` (domyślnie niewypisywane; patrz F1).

## Zestawienie

| # | Rodzaj | Wejście (skrót) | Nowe? |
|---|--------|-----------------|-------|
| F1 | (1) obejście | nowy `.gs` w katalogu z `.gitignore` (`reports/`, `coverage/`, `node_modules/` ...) | NIE |
| F2 | (1) obejście | śledzony plik z `[1]`/`*`/`?` w nazwie, bez `\n` w repo, "zamiata" inny plik przez `git add` | NIE |
| F3 | (1) obejście | dowiązanie w repo -> zwykły plik o treści `cel\n` | NIE |
| F4 | (1) obejście | nieprawidłowy UTF-8, równość po dekodowaniu | NIE |
| F5 | (1) obejście | brak `src/appsscript.json` zmienia układ; usunięcie manifestu niewidoczne | NIE |
| F6 | (3) utwardzenie | `status.showUntrackedFiles=no`, `GIT_LITERAL/NOGLOB_PATHSPECS`, flagi indeksu | NIE |
| F7 | (2)/(3) błąd/czytelność | katalog `*.gs` (EISDIR), patch >1 MB (ENOBUFS), `1:foo.gs`, pusty patch przy CRLF | NIE |
| F8 | (3) efekt uboczny | zapis przez dowiązanie poza drzewo | NIE |

Zmiana 48ee2ab sama: brak nowych wad; naprawia fałszywe stopy i błędy dla nazw spoza ASCII/ze spacją/tabem/nową linią.
