# Przegląd „spróbuj to obejść”: maxBuffer w apps-script-compare.js (#318, commit bc19810 względem 1607f42)

Zakres: tylko odczyt repozytorium; eksperymenty w katalogu `scratchpad/obejscie` (kopie `old/` = 1607f42, `new/` = bc19810, skrypty `e1.js` do `e12.js`, `h.js`) oraz, dla zachowania Linuksa, w tymczasowym katalogu w WSL (usunięty). Środowiska: Windows (node 24.15.0, git 2.56.1) i Linux/WSL (node 24.15.0, git 2.43.0; Linux jest środowiskiem CI). Zmienne `GIT_*` usunięte w `h.js`.

Zmiana w skrócie: jedynym diffem w `scripts` jest stała `GIT_MAX_BUFFER = 256 MiB` użyta w `git()` (execFileSync) i w `spawnSync('git', ['show', ':' + f])`. Test `maxBuffer` liczy bajty (potwierdzone: blob 255 MiB przechodzi, 256 MiB + 19 B już nie).

## Podsumowanie

Zmiana nie wprowadza żadnego nowego sposobu na przepuszczenie prawdziwego driftu. Zawęża dawne okno 1 MiB do 256 MiB. Znalazłem jednak cztery problemy, wszystkie ISTNIEJĄCE PRZED zmianą (zweryfikowane na `old/`), z których zmiana nie usuwa dwóch (F1, F2), a F3 i F4 pozostają, tylko z progiem przesuniętym z 1 MiB na 256 MiB.

| nr | rodzaj | wprowadzone zmianą? | wynik |
|----|--------|---------------------|-------|
| F1 | fałszywy brak driftu (przepuszcza prawdziwy drift) | nie, istnieje w 1607f42; okno przesunięte z ok. 1 MiB na ok. 256 MiB | kod sprawdza `shown.status`, ale nie `shown.error` |
| F2 | fałszywy brak driftu | nie, istnieje w 1607f42; zmiana go nie dotyka | dekodowanie UTF-8 zlewa różne bajty |
| F3 | wyjątek zamiast raportu | nie; próg przesunięty z 1 MiB na 256 MiB | diff powyżej 256 MiB: ENOBUFS, brak raportu i patcha, ślad w indeksie |
| F4 | zatrzymuje to, co powinno przepuścić / wyjątek | nie; próg przesunięty | blob powyżej 256 MiB w indeksie: fałszywy drift; plik powyżej 512 MiB: ERR_STRING_TOO_LONG |

## Znaleziska

### F1. `git show` z kodem 0, błędem ENOBUFS i obciętym stdout: usunięcie ogona pliku uznane za „samą różnicę nowej linii”

Gdzie: `apps-script-compare.js:130-135` (`normalizeIndexTrailingNewline`): warunek to `shown.status !== 0`, pole `shown.error` nie jest sprawdzane.

Mechanizm: gdy blob jest nieco większy niż `maxBuffer` (o rząd kilkudziesięciu KiB), Node na Linuksie kończy `spawnSync` z `error.code = 'ENOBUFS'`, a git zdążył już wyjść, więc `status` to 0, a stdout jest obcięty (zostaje w potoku część ogona). Dalej `indexed` to obcięty prefiks P bez końcowej nowej linii; jeśli katalog roboczy ma dokładnie `P + '\n'`, kod wykonuje `git add` wersji roboczej do indeksu. Prawdziwy drift (brak ogona Q w katalogu roboczym) znika, a indeks traci ogon (HEAD go ma, ale kontrola porównuje tylko katalog roboczy z indeksem, a wpisy „tylko w indeksie” są filtrowane).

Wejście (stan przed zmianą, rzeczywisty): repo z `src/Big.gs` = 1 114 576 B znaków `a` (bez końcowej nowej linii) w commicie; katalog roboczy = 1 114 112 znaków `a` + `\n` (brak 464 B ogona). Wynik oczekiwany: drift. Wynik rzeczywisty (Linux, `old/`, `e5.js`): `{ 'NO DRIFT (bypass)': 4, 'EXCEPTION ENOBUFS': 56 }` na 60 prób. Przy okazji statystyki `git show` (`e3.js`, `e4.js`, Linux, limit 1 MiB): na 720 prób 140 miało status 0 z ENOBUFS, z czego 14 z obciętym stdout (np. długość 1 114 112 B z blobu 1 148 576 B). Na Windows status zawsze `null` (nie obserwowano obejścia), więc to jest wada zależna od platformy, istotna dla CI na Linuksie.

Po zmianie: ten sam kod, więc okno istnieje na progu 256 MiB. Dowody:
- Linux, `new/`, `e6.js`: dla blobu 268 455 456 B (limit + 20 000) status 0 z ENOBUFS wystąpił 3/40 razy (w tych próbach stdout był pełny, więc bezpieczny). Obciętego stdout ze statusem 0 w ok. 360 próbach przy 256 MiB nie złapałem (wynik rzadszy i wolniejszy do zmierzenia; skończyłem pomiar po limicie czasu, więc „nie zaobserwowano” nie znaczy „niemożliwe”).
- Ścieżka kodu zweryfikowana atrapą zgodną z zaobserwowanym zachowaniem (`e12.js`, Windows, `old/` i `new/`): `spawnSync` zwracający `status 0`, `error ENOBUFS`, stdout obcięty do prefiksu P. Wynik w obu wersjach: `changes: ""`, indeks po kontroli nie ma ogona Q. Atrapa dowodzi samej luki w warunku, nie częstości.

Ocena: istnieje przed zmianą; zmiana przesuwa okno z ok. 1 MiB na ok. 256 MiB (pliki, jakich Apps Script nie przechowuje), więc praktyczne ryzyko spada, ale luka w logice zostaje. Naprawa (nie wykonana, tylko odczyt): `if (shown.error || shown.status !== 0) continue;` oraz test z atrapą status 0 + ENOBUFS + obcięty stdout. Uwaga: repozytoryjny test „gdy git show kończy się niepowodzeniem” używa atrapy `status: 128`, więc przypadku status 0 + error nie pokrywa.

### F2. Nieprawidłowy UTF-8: różne bajty, ten sam napis, brak driftu

Gdzie: `normalizeTrailingNewline` (`:111-119`, odczyt `utf8`, zapis przepisany) i `normalizeIndexTrailingNewline` (`:130-135`, `encoding: 'utf8'` w `git show` oraz `readFileSync(p, 'utf8')`). Dekodowanie zamienia każdą nieprawidłową sekwencję na U+FFFD, więc dwa różne pliki dają ten sam napis.

Wejście 1 (`e8.js`): indeks `78 ff 79` (bez końcowej nowej linii), katalog roboczy `78 fe 79` (też bez nowej linii; inny bajt). Wynik rzeczywisty w `old/` i `new/`: `changes: ""`; indeks po kontroli zawiera wersję roboczą (`78 ef bf bd 79 0a`). Oczekiwane: drift.

Wejście 2 (`e7.js`): indeks `78 ff 79`, katalog roboczy to poprawny UTF-8 `x` U+FFFD `y` + `\n`: `changes: ""` w obu wersjach.

Ocena: istnieje przed zmianą (identyczny wynik w `old/` i `new/`), niezwiązane z rozmiarem, zmiana go nie dotyka. Praktyczne ryzyko niskie (pliki Apps Script są poprawnym UTF-8), ale kontrola deklaruje „każda inna różnica ma być zgłoszona”. Naprawa: czytać i porównywać bajty (`encoding: 'buffer'`, `fs.readFileSync(p)` bez kodowania, `Buffer.equals`, test końca przez ostatni bajt 0x0a) zamiast napisów.

### F3. Diff powyżej 256 MiB: wyjątek zamiast raportu, brak patcha, ślad w indeksie

Gdzie: `compare()` `:159-163`, `git(cwd, ['--no-pager', 'diff', ...])` przy limicie 256 MiB; `git reset` na `:163` jest po wyjątku, więc nie wykona się.

Wejście (`e9.js`): zmieniony śledzony plik po 130 MiB (stare i nowe wiersze razem ok. 260 MiB) plus nieśledzony `Nowy.gs`. Wynik rzeczywisty: `compare()` rzuca `spawnSync git ENOBUFS`; po wyjątku `git status` pokazuje ` A src/Nowy.gs` (intent-to-add nie został cofnięty). Przy 100 MiB (diff 211 MB) działa poprawnie: `changes` i pełny patch. Z CLI (`e10.js`, `new/`): kod wyjścia 1, stderr `[apps-script-compare] FAIL: spawnSync git ENOBUFS`, brak pliku podsumowania i brak patcha.

Ocena: kończy się zatrzymaniem (kod 1), więc zgłasza drift, ale bez raportu, listy plików i patcha, które kontrola obiecuje. Istniał przed zmianą dla diffu powyżej 1 MiB; zmiana poprawia sytuację (próg 256 MiB), nie wprowadza nowego problemu. Pozostaje brak sprzątania intent-to-add (`try/finally`) i brak przechwycenia ENOBUFS dla patcha (np. zapis patcha bezpośrednio do pliku przez `--output` albo `stdio` do pliku).

### F4. Rozmiary graniczne: blob powyżej 256 MiB i plik powyżej 512 MiB

- Blob w indeksie powyżej 256 MiB bez końcowej nowej linii, katalog roboczy = blob + `\n` (`e1.js`, Windows, `new/`): 255 MiB daje `changes: ""` (poprawnie), 256 MiB, 257 MiB i 300 MiB dają ` M src/Big.gs` (fałszywy drift; powinno przejść). Kierunek bezpieczny (fail closed), próg przesunięty z 1 MiB (w `old/`: 1,5 MiB już daje fałszywy drift, 0,5 MiB nie).
- Plik w katalogu roboczym 520 MiB (`e11.js`): `normalizeTrailingNewline` rzuca `ERR_STRING_TOO_LONG` (limit V8 0x1fffffe8 znaków), czyli wyjątek zamiast raportu. Niezależne od zmiany; maxBuffer 256 MiB nie może dać napisu dłuższego niż limit V8 (256 MiB bajtów to najwyżej 268 435 456 znaków, poniżej 536 870 888).

Ocena: realnie nieosiągalne dla projektu Apps Script; przy okazji zapisane, bo kontrola obiecuje raport.

## Sprawdzone, bez znaleziska

- Brak obcięcia po stronie `execFileSync`: przekroczenie limitu zawsze rzuca (ENOBUFS), nie zwraca skróconego wyniku; `compare()` nigdy nie zwraca obciętego patcha (`e9.js`, 130 MiB: wyjątek).
- Diff 100 MiB na stronę (211 MB patcha) z nieśledzonym plikiem: pełny wynik, stan indeksu po `reset` czysty (`e9.js`).
- Blob 100 MiB i 255 MiB bez końcowej nowej linii, katalog roboczy tylko z dodaną nową linią: poprawnie brak driftu, czas ok. 1 s i 2 s (`e1.js`); pamięć bez problemu.
- Blob dokładnie na granicy: długość równa limitowi daje status 0 i pełny stdout; limit + 1 B daje ENOBUFS (Windows: status null; Linux: status 0 lub null, stdout pełny przy najbliższych rozmiarach) (`e3.js`).
- Rozmiar w bajtach, nie znakach (wielobajtowe znaki nie zmieniają granicy).
- Windows: status 0 z ENOBUFS i obciętym stdout nie wystąpił w żadnej próbie (status zawsze `null`); wada F1 dotyczy zachowania Linuksa (CI).
- `stderr` też podlega maxBuffer, ale ostrzeżenia gita o końcach linii mają setki bajtów; 256 MiB niemożliwe do osiągnięcia.
- `git show :plik` z kodem różnym od 0 i pełnym stdout (np. wpis nierozwiązanego konfliktu: błąd „not at stage 0”): plik pominięty, a `git status` zgłasza drift (`UU`), czyli kierunek bezpieczny, zgodny z opisem testu. Tej ścieżki nie uruchomiałem z prawdziwym konfliktem, wynika z odczytu kodu (`:131`, `:155-156`); jedyny dowód wykonaniem to atrapa z `status: 128` w teście repozytorium.
- `pull()` (`:81-94`) używa `spawnSync` bez maxBuffer (limit domyślny 1 MiB), ale to nie jest git i nie wchodzi w zakres zmiany; wynik `clasp pull` to lista plików, setki bajtów.
- `apps-script-drift.js` ma ten sam limit 256 MiB (`:31`, `:175`); poza zakresem zmiany, nie badane.
- Nie sprawdzałem: wpływu `core.autocrlf`/`.gitattributes` na porównanie `git show` z plikiem roboczym (niezwiązane z rozmiarem) oraz `assume-unchanged`/`skip-worktree` (nie występuje w świeżym checkoutcie CI).

## Skrypty (w tym samym katalogu)

`h.js` (pomocnik: repo testowe, ładowanie `old`/`new`), `e1.js` (blob bez nowej linii, różne rozmiary), `e2.js`/`e3.js`/`e4.js`/`e6.js` (zachowanie `spawnSync git show` wokół limitu), `e5.js` (F1 na Linuksie, `old`), `e12.js` (F1, atrapa), `e7.js`/`e8.js` (F2), `e9.js`/`e10.js` (F3), `e11.js` (F4).
