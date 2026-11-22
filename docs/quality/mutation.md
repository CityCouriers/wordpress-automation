# Testy mutacyjne plików `src/*.gs` (próba na Linuksie)

Zgłoszenie: #253 (następca pilota z #234). Status: **próba, niewymagana i niczego niewstrzymująca**.
Wymagany job na PR (#254) i przebieg tygodniowy (#255) są poza zakresem. Mutacje biegną wyłącznie na Linuksie,
w CI tego repozytorium, nigdy na komputerze lokalnym.

Test mutacyjny psuje kod na próbę (np. `||` na `&&`, `>=` na `>`, usuwa blok) i sprawdza, czy jakikolwiek test to
zauważy. Mutant, który przeżył, to miejsce, w którym kod można popsuć, a testy zostaną zielone. Pokrycie linii tego nie
pokazuje: linia może się wykonać i nic nie sprawdzać.

## Kontrakt izolacji (z #234, bez zmian)

Mutanty wykonują zmutowany kod, więc przed ich startem muszą być spełnione warunki, a nie deklaracje:

| Warunek | Jak jest wymuszony | Jak jest sprawdzony przed mutantami |
| --- | --- | --- |
| Brak sieci | kontener z `--network none` | w `/proc/net/dev` i `os.networkInterfaces()` jest tylko `lo`, brak tras w `/proc/net/route`; sonda: połączenia z 5 adresami (IPv4, IPv6, adres metadanych) i rozwiązanie nazwy muszą się nie udać |
| Zapis tylko w katalogu przebiegu | `--read-only`, jedyne zapisywalne montowanie to `/work` oraz `/tmp` (tmpfs) | `/proc/self/mountinfo`: katalog główny `ro` i jeden; `/work` jedno, `rw`, ze źródłem kończącym się na `/mutation-run`; każdy inny punkt tylko z tabeli (typ systemu plików: `/proc` proc, `/dev` tmpfs, `/dev/pts` devpts, `/tmp` tmpfs...; `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf` tylko z katalogu kontenera), podmontowania pod `/proc` i `/sys` tylko typów systemowych, a tmpfs tam wyłącznie na zamkniętej liście ścieżek maskowanych przez kontener (`MASKED_PATHS`); wszystko inne (HOME, gniazdo dockera, katalog hosta pod `/dev`) to odmowa; sonda: utworzenie pliku w `/`, `/etc`, `/usr`, `/var`, `/root` i w HOME musi być odmówione |
| Odczyt tylko w katalogu przebiegu | brak innych montowań | sonda: znane ścieżki hosta i plik kontrolny hosta podany przez workflow muszą być niewidoczne |
| Brak uprawnień | `--user 1000:1000`, `--cap-drop ALL`, `--security-opt no-new-privileges`, domyślny seccomp | `/proc/self/status`: UID i GID (także grupy dodatkowe) ≠ 0, `CapEff`/`CapPrm`/`CapBnd` zerowe, `NoNewPrivs: 1`, `Seccomp: 2` |
| Brak poświadczeń | kontener bez `-e` poza `TZ`, bez `--env-file`; checkout z `persist-credentials: false` | nazwy zmiennych środowiska tylko z allowlisty, żadnych zgodnych z poświadczeniami ani `GIT_*` |
| Testy w ogóle działają | | sonda pozytywna: `load-only.test.js` przechodzi w tym środowisku |

Kod: `scripts/mutation/isolation-guard.js` (fakty), `scripts/mutation/isolation-probe.js` (sondy czynne). Zasady:

- **Fakty czyta proces, który ma uruchomić mutanty**, z `/proc`. Nie ma zmiennej, pliku ani flagi, które zdejmują
  odmowę, a deklaracja (np. `MUTATION_ISOLATED=1`) niczego nie zmienia (test to sprawdza).
- **Sondy czynne idą dopiero po pozytywnej ocenie faktów** i zawsze przed mutantami. Na maszynie bez izolatora fakty
  są złe, więc sondy (zapis, połączenia) w ogóle się nie uruchamiają.
- **Nieudana sonda albo niepewny wynik to odmowa**: kod 3, komunikat `no-go-izolacja`, bez startu mutantów. Narzędzia
  sprawdzają bramkę przed utworzeniem czegokolwiek, więc odmowa nie zostawia nowego `reports/`, kopii cienia ani
  `.stryker-tmp`. Błąd samej sondy (wyjątek, brak odczytu `/proc`) też jest odmową, nie pominięciem. Po przejściu bramki
  `trial.js` usuwa wszystko, co mogło zostać w kopii repozytorium (`reports/`, `.stryker-shadow/`, `.stryker-tmp/`),
  żeby raport pochodził wyłącznie z tego przebiegu.
- Każde narzędzie, które startuje mutanty (`trial.js`, `run-file.js`, `validate-selection.js`, `canary.js`, `zero-check.js`),
  samo wywołuje bramkę. Komendy testowe Strykera (`run-tests.js`, `run-for-mutant.js`) sprawdzają fakty przy każdym
  uruchomieniu, więc surowe `npx stryker run` z konfiguracją repozytorium na maszynie deweloperskiej kończy się odmową już na suchym
  przebiegu. Komenda testowa podana Strykerowi z wiersza poleceń (`--commandRunner.command`) ma pierwszeństwo przed konfiguracją, więc
  bramkę ma też `vm-preload.js`: to jedyna droga, którą zmutowany kod trafia do testów (przekierowanie `src/*.gs` na kopię cienia),
  a sprawdza fakty izolacji przy każdym wczytaniu. Kto ominie `vm-preload.js` własną komendą, nie uruchamia już mutantów tego
  potoku; zakaz uruchamiania Strykera poza izolatorem pozostaje też regułą pracy (`CLAUDE.md`).
- Narzędzia, które mutantów nie startują (`prepare-shadow.js`, `coverage-map.js`), bramki nie mają: pracują na niezmutowanym kodzie.
- Cały łańcuch procesów (Stryker, loader, testy) działa w tym samym kontenerze, z minimalnym środowiskiem (`safe-env.js`).
- Sondy są skończone, więc „nic nie wykryto” nie dowodzi izolacji; dowodem jest mechanizm (flagi kontenera, sprawdzane
  w teście `test/mutation-workflow.test.js`) plus fakty z `/proc` procesu. Sondy łapią błąd konfiguracji, którego
  fakty nie widzą.

Bramka nie sprawdza przestrzeni nazw PID, `--device`, AppArmor ani `--ipc`/`--uts`; te flagi zatrzymuje tylko przypięcie
`docker run` w `test/mutation-workflow.test.js`. Lista `MASKED_PATHS` nie odróżnia katalogu hosta podstawionego dokładnie pod
jedną z maskowanych ścieżek od prawdziwej maski, więc także tu obrona opiera się na przypiętym `docker run`.

**Co NIE jest sprawdzone.** Bramka i workflow były dotąd uruchamiane wyłącznie w testach z atrapami faktów (zapisanymi
na podstawie formatu `/proc` kontenera). Na prawdziwym kontenerze Dockera nie były uruchomione: to zadanie pierwszego
przebiegu (po zgodzie właściciela). Jeśli lista dozwolonych punktów montowania okaże się za wąska, bramka odmówi
(zachowanie bezpieczne), a poprawka listy wymaga osobnego przeglądu.

Jeśli odcięcie sieci okaże się niewykonalne na runnerze, wariant alternatywny wymaga osobnej, jawnej decyzji właściciela
i zmiany kontraktu #234; nie wynika z niczyjej domniemanej zgody.

## Przebieg próby

Workflow `.github/workflows/mutation-trial.yml`, wyłącznie `workflow_dispatch` (nie uruchamia się z PR-a, z pusha ani
z harmonogramu), `permissions: contents: read`, akcje po pełnym SHA, `persist-credentials: false`, bez `secrets.*`,
`environment:` i `pull_request_target`. `test/mutation-workflow.test.js` porównuje polecenie `docker run` słowo w słowo
z kanonicznym (każda dodatkowa flaga, np. `--volumes-from`, `--group-add`, `--add-host`, jest zarzutem), pilnuje, że jest
jedno `docker run` i brak innych poleceń docker poza `pull`, oraz że raporty z katalogu przebiegu (nieufnego po
mutantach) czyta wyłącznie krok zbierający: kopiuje zwykłe pliki `.json` i `.md` (bez dowiązań, z limitem rozmiaru) poza
katalog przebiegu, a podsumowanie i wysyłka artefaktu czytają tylko z tej kopii. Repozytorium z `.npmrc` kończy
przebieg odmową przed instalacją zależności.
Wejścia: `file` (np. `Payloads.gs`), `suite`, `concurrency`. GitHub uruchamia ręcznie tylko workflow obecny na gałęzi
domyślnej, więc pierwsze uruchomienie jest możliwe dopiero po scaleniu pliku (potem uruchomienie z innej gałęzi wykonuje wersję
pliku z tej gałęzi, co wymaga uprawnień zapisu do repozytorium), **i wymaga jawnej zgody właściciela
zapisanej w komentarzu zgłoszenia #253**.

W kontenerze `scripts/mutation/trial.js <Plik.gs>` wykonuje kolejno:

1. bramka izolacji (fakty i sondy), zapis `reports/mutation/isolation.json`,
2. **kontrola zerowa** (`zero-check.js`): kod zinstrumentowany przez Strykera, ale bez aktywnego mutanta, daje ten sam
   wynik i tę samą liczbę testów co kod oryginalny (te same testy `run-tests.js`, bez dwóch testów skanujących
   repozytorium); plik w kopii roboczej Strykera musi mieć ślad instrumentacji (inaczej kontrola byłaby pusta),
3. **kanarek** (`canary.js`): kontrola dodatnia w każdym przebiegu. Stryker mutuje maleńkie źródło
   `scripts/mutation/canary/MutationCanary.gs` tym samym łańcuchem (kopia cienia, instrumentacja, `vm-preload.js`,
   klasyfikacja) i wszystkie jego mutanty muszą zginąć z asercją. Zepsuty `vm-preload.js` daje czerwono na dwa
   sposoby: bez przekierowania źródła test kanarka pada z ENOENT już w przebiegu bez mutanta, a bez wstrzykiwania
   numeru mutanta mutanty ocalałyby,
4. mapa pokrycia (`coverage-map.js`, tylko dla `--suite=per-mutant`),
5. mutanty wskazanego pliku (`run-file.js`) i klasyfikacja,
6. `reports/mutation/summary.json` i `summary.md` (liczby per status, czasy).

Kod wyjścia: 0 przebieg ważny, 2 błędne wywołanie, 3 brak izolacji (bez raportu), 4 kontrola zerowa, kanarek albo
przebieg nieudany.

Zestawy testów (`--suite`): `per-mutant` (domyślny: testy wykonujące linie mutanta, z `coverage-map.js`), `file`
(wszystkie testy pliku z `.quality/mutation-tests.json`), `full` (wszystkie testy dla każdego mutanta; do pomiaru kosztu
i sprawdzianu doboru). Pojedynczy plik źródłowy wskazuje się wejściem `file` workflow, np. `Performance.gs` dla #189.

## Klasyfikacja wyników

Runner `command` uznaje każdy niezerowy kod wyjścia za zabicie mutanta, także awarię preludium. `classify.js` dzieli
zabite i nie liczy „zabitych bez asercji” do wyniku:

| Status | Znaczenie | Liczy się do zabitych |
| --- | --- | --- |
| `killed-assert` | w wyjściu testów jest `AssertionError` i brak błędu programu (`ReferenceError`, `SyntaxError`, `RangeError`, brak modułu) | tak |
| `killed-other` | inny niezerowy wynik (np. `TypeError` z zmutowanego kodu, awaria loadera) | nie |
| `Survived` | żaden test nie padł | nie |
| `Timeout` | przekroczony limit czasu | nie (osobna kategoria) |
| `RuntimeError`, `CompileError` | błąd uruchomienia albo kompilacji mutanta | nie (osobna kategoria) |

Pomiar bez żadnego `killed-assert` jest nieważny (kod 3 z `classify.js`).

## Pliki

| Plik | Zawartość |
| --- | --- |
| `scripts/mutation/` | narzędzia (bramka, sondy, kanarek, kontrola zerowa, dobór testów, klasyfikacja, raporty) |
| `stryker.config.json` | konfiguracja Strykera; komenda testowa `run-tests.js` odmawia poza izolatorem |
| `.quality/mutation-tests.json` | plik źródłowy → pliki testów (z `coverage-map.js`: `node scripts/mutation/tests-map.js write`) |
| `.quality/mutation-baseline.json` | baza mutantów **wyłącznie równoważnych** (schemat w `scripts/mutation/baseline.js`) |

## Baza mutantów równoważnych

Wpis dopuszczalny tylko dla mutanta, który dowiedziono, że nie da się zabić, **po niezależnym audycie** (osobny agent,
nie autor zmiany). Klucz: plik, funkcja oraz dokładna linia źródła przed i po mutacji; wymagane jest uzasadnienie i
odsyłacz do zatwierdzenia w PR (`approval`). Baza startuje pusta. Ocalały mutant spoza bazy jest niezabity i nie ma
wyjątku. Mutanty `StringLiteral` (komunikaty) liczą się jak pozostałe (reguła „każdy zabijalny zabity”), chyba że
właściciel zdecyduje inaczej.

## Testy, które nie oceniają mutantów

`tests-list.js` wyłącza z oceny mutantów `src/*.gs` testy skanujące repozytorium (`repo-identity`, `source-control-chars`)
oraz wszystkie `test/mutation-*.test.js`: sprawdzają narzędzia i granicę izolacji (np. odmowę na maszynie bez
izolatora), więc w kontenerze z izolacją nie mają racji bytu, a kodu `src/*.gs` nie dotykają. Biegną normalnie w CI
(`npm test`, job `validate`), nie w kontenerze mutacji.

## Jak testowane są same narzędzia

Narzędzia z `scripts/mutation/` podlegają regule mutacyjnej jak każdy kod (decyzja właściciela z 2026-11-22). Orkiestratory
(`canary`, `zero-check`, `trial`, `run-file`, `validate-selection`, `run-tests`, `run-for-mutant`, `coverage-map`,
`report`) przyjmują zależności (korzeń, bramka izolacji, uruchamianie procesów, wyjścia, zegar) jako argument
`deps`; testy w `test/mutation-orchestrators.test.js` dają im atrapy i drzewo tymczasowe, więc sprawdzają kolejność
kroków, dokładne argumenty procesów, pliki raportów i kody wyjścia bez uruchamiania Strykera. Wejścia z wiersza poleceń
mają osobne testy z prawdziwym podprocesem (kod 2 przy braku nazwy, kod 3 i `no-go-izolacja` poza izolatorem).
Warunek `require.main === module` pilnują dwa testy: wczytanie modułu nie uruchamia narzędzia, a
`test/helpers/exit-guard.js` zamienia przedwczesne `process.exit(0)` w pliku testowym (skutek zmutowanego warunku) na
porażkę.

Pomiar mutacyjny samych narzędzi (StrykerJS, runner `command`, kopia poza drzewem roboczym; nie jest to pomiar plików
`src/*.gs`, więc nie dotyczy go bramka izolacji) dał 0 ocalałych we wszystkich plikach i żadnego mutanta ze statusem
Timeout (tabela Timeoutów: brak):

| Plik | Zabite | Ocalałe |
| --- | ---: | ---: |
| `isolation-guard.js` | 443 | 0 |
| `isolation-probe.js` | 129 | 0 |
| `report.js` | 191 | 0 |
| `zero-check.js` | 168 | 0 |
| `run-file.js` | 161 | 0 |
| `validate-selection.js` | 150 | 0 |
| `trial.js` | 140 | 0 |
| `baseline.js` | 110 | 0 |
| `tests-map.js` | 95 | 0 |
| `classify.js` | 88 | 0 |
| `coverage-map.js` | 81 | 0 |
| `canary.js` | 80 | 0 |
| `selection.js` | 71 | 0 |
| `lcov.js` | 67 | 0 |
| `run-for-mutant.js` | 45 | 0 |
| `vm-preload.js` | 41 | 0 |
| `prepare-shadow.js` | 28 | 0 |
| `safe-env.js` | 27 | 0 |
| `run-tests.js` | 24 | 0 |
| `tests-list.js` | 22 | 0 |
| `source-name.js` | 6 | 0 |
| `repo-root.js` | 2 | 0 |

Baza mutantów równoważnych pozostaje pusta: żaden mutant nie wymagał uznania za równoważny.

## Ograniczenia

- Dobór testów per mutant to przybliżenie; `validate-selection.js` sprawdza je próbką z całym zestawem.
- Testy czytające `src/*.gs` jako tekst nie oceniają mutantów (widzą w kopii zinstrumentowanej inny tekst).
- Liczby z pilota (Windows, 2026-11-02, np. `Payloads.gs`: 104 zabite z asercją, 65 ocalałych, 5 zabitych bez asercji)
  były diagnostyką bez izolacji; nie są dowodem niczego na Linuksie i zgodność z nimi nie jest warunkiem.
- Wynik pilota z Windowsa nie dowodzi izolacji na Ubuntu; dowodem jest tylko przebieg w CI z powyższą bramką.

## Dowody wymagane przed #254

Przed dopuszczeniem #254 jako wymaganego jobu muszą być zapisane w zgłoszeniu #253: zielona kontrola zerowa i kanarek
na Ubuntu, wynik zepsutego `vm-preload.js` (czerwono), odmowa bramki na sztucznie zepsutej sondzie w CI, liczby
`Payloads.gs`, czas mutanta z wąskim i pełnym zestawem testów oraz jeden pomiar całego pliku (np. `Performance.gs`).
