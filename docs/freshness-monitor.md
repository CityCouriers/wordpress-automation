# Niezależny alert świeżości zewnętrznego źródła (#295)

Sygnał z #197 (formuła w arkuszu, `src/SourceFreshness.gs`) nikogo nie budzi: widzi go tylko ten, kto
otworzy plik. Ten mechanizm dostarcza brakujący element: **niezależny kanał ostrzegawczy**, który działa
także wtedy, gdy wszystkie wyzwalacze Apps Script stoją (19–26.09.2026, #198), nikt nie otwiera arkusza
i gdy sam projekt Apps Script nie istnieje albo nie ma uprawnień.

Repozytorium jest **publiczne**, więc dostarcza wyłącznie generyczny kod (`scripts/freshness-monitor/`),
szablon workflow (`docs/freshness-monitor/workflow.template.yml`), testy na danych syntetycznych i tę
dokumentację. Harmonogram, sekrety, adresaci, identyfikator pliku sygnałowego, konfiguracja i stan należą
do **prywatnej instalacji** i nigdy nie trafiają tutaj.

## Wybór architektury

Rozważone były trzy drogi: (a) odczyt świeżości z zewnętrznego harmonogramu, (b) porównanie najwyższego
identyfikatora rekordu w źródle i w arkuszu, (c) kanał już istniejący w repo. **Wybrane: (a) uruchamiane
przez (c)**, czyli sprawdzacz w GitHub Actions w prywatnym repozytorium instalacji (jedyny niezależny od
Google harmonogram, który repo już ma). Publiczne repo nie nadaje się na miejsce przebiegów: publiczne logi
i historia przebiegów ujawniałyby każdemu, że przepływ zgłoszeń stoi.

**(b) jest odłożone do osobnego zgłoszenia.** Jest silniejszym sygnałem (nie myli dnia bez zgłoszeń z
zerwanym przepływem), ale wymaga odczytu po stronie źródła, czyli zmiany na produkcyjnym WordPressie i
zgody właściciela, a sprawdzacz musiałby trzymać poświadczenie do WordPressa. Kryterium startu (b): po co
najmniej 30 dniach pracy etapu (a) więcej niż 2 fałszywe alarmy `ALERT_STALE` na miesiąc albo źródło z
przerwami dłuższymi niż twardy limit. Progu w (a) nie skracamy, żeby udawać (b).

Sprawdzacz czyta **znacznik ostatniego rekordu** (to samo wejście `lastTimestamp`, które ma formuła z
#197) i liczy wiek własnym zegarem. Nie czyta wyniku formuły: zależy on od ustawienia przeliczania pliku,
a odczyt `NOW()` przez Sheets API v4 nie został zmierzony. Formuła z #197 zostaje bez zmian jako sygnał dla
człowieka; sprawdzacz jest drugim, niezależnym liczeniem, nie jej zamiennikiem.

### Zasada minimalnych uprawnień: plik sygnałowy

Tożsamość sprawdzacza **nie ma dostępu do arkusza z wierszami zgłoszeń**. Czyta osobny, mały plik
sygnałowy z jedną komórką (np. `MAX` znacznika sprowadzone z arkusza źródłowego przez `IMPORTRANGE`).
Wyciek poświadczeń sprawdzacza ujawnia więc jeden znacznik czasu, nie dane osobowe. Awaria `IMPORTRANGE`
(cofnięta zgoda, błąd) daje błąd odczytu, czyli `ALERT_ERROR`, a nie ciszę. Czytnik
(`sheets-reader.js`) odrzuca przy tworzeniu zakres szerszy niż jedna komórka, a `read()` nie przyjmuje
żadnego argumentu.

Komórka sygnałowa ma zawierać znacznik jako **tekst `RRRR-MM-DD GG:MM:SS` w strefie instalacji**, np.
`=TEXT(MAX(IMPORTRANGE(...)); "yyyy-mm-dd hh:mm:ss")` (czytnik prosi o `FORMATTED_VALUE`). Tekst w innym
formacie to `ALERT_ERROR` (`MARKER_INVALID`), nie zgadywanie.

## Dwie warstwy semantyki

Słownik z #197 (`ACTIVE`, `STALE`, `ERROR`) zostaje bez zmian i obejmuje **tylko surowy wiek**. Polityka
alarmowania jest osobną warstwą nad nim, a testy obu warstw są rozdzielone.

**Warstwa 1: świeżość surowa** (`freshness.js`). `rawAge` to różnica między chwilą bieżącą a znacznikiem w
pełnych sekundach **czasu ściennego strefy instalacji**, zaokrąglana od zera jak `ROUND`, dokładnie jak w
`sourceFreshness_()` (`src/SourceFreshness.gs:41`). W noc zmiany czasu różnica jest o godzinę większa albo
mniejsza od rzeczywistej (README, sekcja „Świeżość zewnętrznego źródła”); to odchylenie ±1 h jest
zaakceptowane i zachowane świadomie. `test/freshness-monitor-layer1.test.js` porównuje stany z funkcją z
`.gs` na całej tabeli przypadków 1–10 z #197 (`test/helpers/freshness-cases.js`, ta sama tabela co w
`test/source-freshness.test.js`) oraz wokół zmiany czasu (marzec i październik). Jedyne rozszerzenie
względem #197: sprawdzacz ma stan `ERROR` także dla nieudanego odczytu.

**Warstwa 2: polityka alarmowania** (`assessment.js`) daje `alertLevel`:

| `alertLevel` | kiedy |
| --- | --- |
| `OK` | brak alarmu |
| `ALERT_STALE` | wiek w godzinach pracy (`workingHoursAge`) przekracza próg **albo** `rawAge` przekracza twardy limit bezwzględny |
| `ALERT_ERROR` | odczyt się nie powiódł (`READ_FAILED`) albo warstwa 1 zwróciła `ERROR` (`MARKER_INVALID`: znacznik pusty, niepoprawny, z przyszłości) |

- **`workingHoursAge`** liczy tylko godziny okna pracy źródła (dni tygodnia 1–7, godziny `HH:MM`, strefa
  instalacji, opcjonalna lista dni wolnych `RRRR-MM-DD`) w czasie ściennym. Początek okna włącznie, koniec
  wyłącznie. Znacznik z piątku 16:00 oceniany w poniedziałek 09:00 ma 3 h pracy, nie 65 h. Godziny pracy
  liczą się w tym samym czasie ściennym co warstwa 1: godzina pominięta wiosną (02:00–03:00) liczy się
  jako godzina okna, a powtórzona jesienią raz. Przy oknie obejmującym tę godzinę wynik bywa więc o godzinę
  większy niż rzeczywisty (test 6).
- **Twardy limit bezwzględny** (domyślnie 96 h) liczy się w `rawAge`, czyli **razem z weekendami i
  świętami**, i alarmuje niezależnie od okna i listy dni wolnych. Chroni przed zgniłą listą świąt i błędnie
  ustawionym oknem. Wokół zmiany czasu dziedziczy odchylenie ±1 h z warstwy 1.
- **Alarm dochodzi w godzinach pracy.** `ALERT_STALE` z progu w godzinach pracy poza oknem jest
  **odroczony** (`deferred`) do jego otwarcia. `ALERT_STALE` z twardego limitu i `ALERT_ERROR` nie czekają.
- **Źródło bez ruchu**: źródło, w którym prawidłowe przerwy przekraczają twardy limit, daje alarm ciągły
  (z treścią wskazującą limit bezwzględny). Dla takiego źródła sygnał wieku się nie nadaje; jedyną drogą
  jest (b).
- **Czego alarm nie mówi.** `STALE` znaczy wyłącznie, że od progu nie pojawił się nowszy rekord. Nie jest
  potwierdzeniem awarii transportu danych ani nie odróżnia dnia bez zgłoszeń od zerwanej integracji.
  Treść wiadomości mówi „brak nowych wpisów od N godzin”, nie „przepływ uszkodzony”. `ALERT_ERROR` ma
  odmienną treść („nie udało się sprawdzić”).

Odczyt znacznika jest ponawiany w obrębie jednego przebiegu (2 próby w odstępie co najmniej 60 s), więc
chwilowy błąd sieci nie daje `ERROR`.

### Kalibracja progu

Próg w godzinach pracy to **co najmniej 1,5 raza najdłuższa zaobserwowana prawidłowa przerwa w godzinach
pracy z ostatnich 3 miesięcy**. Kalibracja używa wyłącznie znaczników czasu rekordów (bez treści).
`calibration.js` (`calibrateThreshold`) liczy ją z listy znaczników i zwraca najdłuższą przerwę oraz
próg zaokrąglony w górę do pełnej godziny. Uruchamia ją człowiek raz; **wynik trafia do konfiguracji
instalacji, nie do repozytorium**.

## Konfiguracja

Konfiguracja jest sekretem instalacji (JSON w `FRESHNESS_MONITOR_CONFIG`). Walidacja jest fail-closed:
nieznane pole, zły typ albo wartość spoza zakresu kończą przebieg kodem 2 i komunikatem z samą nazwą pola.

| pole | znaczenie |
| --- | --- |
| `label` | neutralna etykieta źródła, `[a-z0-9-]`, do 40 znaków (np. `zrodlo-1`; nigdy nazwa klienta ani formularza) |
| `timeZone` | strefa instalacji (IANA) |
| `rawThresholdHours` | próg surowy warstwy 1, wspólny parametr z formułą z #197 |
| `workingHoursThresholdHours` | próg w godzinach pracy |
| `hardLimitHours` | twardy limit bezwzględny, domyślnie 96 |
| `window` | `{ "days": [1,2,3,4,5], "start": "08:00", "end": "18:00" }` (1 = poniedziałek, 7 = niedziela) |
| `holidays` | lista dni wolnych `RRRR-MM-DD`, domyślnie pusta |
| `reminderWorkingHours` | przypomnienie po tylu godzinach pracy od ostatniej potwierdzonej wiadomości, domyślnie 24 |
| `retryDelayMs` | odstęp między dwiema próbami odczytu, co najmniej 60000 |

**Przypomnienie liczy się w godzinach pracy** (specyfikacja: „minęło 24 h w godzinach pracy”), a nie w
godzinach zegarowych: przy oknie 08–18 przypomnienie wypada po około 2,4 dnia roboczego od ostatniej
wiadomości. Kto chce rzadszych albo częstszych przypomnień, zmienia `reminderWorkingHours`.

## Stan i dostarczanie wiadomości

Sprawdzacz ma **mały, trwały stan per źródło**, bo jedna wiadomość przy przejściu, przypomnienie i
wiadomość o powrocie wymagają pamięci. Stan to jeden plik JSON (`{"sources": {"<etykieta>": {...}}}`) na
osobnej, sierocej gałęzi `monitor-state` w prywatnym repozytorium instalacji (`git-store.js`): trwały (nie
wygasa jak artefakt), spójny (zapis to commit na wersji z odczytu wypchnięty bez siły; non-fast-forward to
konflikt), audytowalny (historia gałęzi to dziennik zdarzeń alarmowych), bez dodatkowego sekretu.

### Schemat stanu (tylko te pola, nic więcej)

| pole | znaczenie |
| --- | --- |
| `lastObservedState` | `OK`, `ALERT_STALE` albo `ALERT_ERROR` z ostatniego przebiegu |
| `lastObservedAt` | chwila przebiegu, który to ustalił |
| `lastNotifiedState` | stan, o którym **potwierdzono** wysłanie wiadomości |
| `lastNotifiedAt` | chwila **potwierdzonej** wysyłki |
| `lastNotifiedKey` | klucz (`<messageId>:<rodzaj>`) ostatniej zapisanej wiadomości |
| `messageSeq` | monotoniczny licznik: największy numer zapisanej wiadomości, nie maleje, numer nie jest używany ponownie |
| `eventId` | `messageId` ostatniej wiadomości typu przejście do `ALERT_*`; puste w `OK` |
| `undeliveredSince` | chwila, od której czeka niedostarczona wiadomość (puste, gdy brak) |
| `lastSuccessfulCheckAt` | chwila ostatniego przebiegu, który zdołał odczytać znacznik i ocenić stan (puls dla kontroli życia) |

Stan nie zawiera znacznika źródła, treści, adresów ani identyfikatorów plików. Plik, którego sprawdzacz nie
rozumie (zły JSON, brakujące albo obce pole, zły typ), kończy przebieg czerwono i **nie jest nadpisywany**.
Konfiguracja (próg, okno, dni wolne) nie jest częścią stanu: każdy przebieg ocenia według bieżącej
konfiguracji, więc jej zmiana i opóźnienie harmonogramu nie psują ewidencji.

### Kontrakt dostarczenia: co najmniej raz

Wybrany kontrakt to **at-least-once**, nie „dokładnie raz”. Poprawność nie opiera się na tym, że przebiegi
nie działają równolegle: `concurrency` w szablonie je szereguje, ale kontrakt obowiązuje także wtedy, gdy
zawiedzie (ręczne uruchomienie, błąd konfiguracji, inne repozytorium).

- **G1: brak utraty alarmu i ewidencja.** `lastNotified*`, `lastNotifiedKey` i `messageSeq` zmieniają się
  wyłącznie po potwierdzonym przyjęciu wiadomości przez kanał. Stan wymagający wiadomości, który trwa w
  chwili oceny, wywoła ją w tym albo następnym przebiegu. Ujęcie jest o stanie, nie o historii: gdy
  `ALERT_*` ustąpił do `OK`, zanim jakikolwiek przebieg zdołał go dostarczyć, wiadomość nie wychodzi (błysk
  zostaje w historii gałęzi). Potwierdzona wiadomość jest zapisywana w stanie, także po konflikcie zapisu,
  z dwoma wyjątkami, w których jest już rozliczona: stan zawiera **tę samą logiczną wiadomość** (ten sam
  klucz) albo wiadomość **późniejszą** (większy `messageSeq`).
- **G2: duplikaty dopuszczone w dokładnie dwóch sytuacjach.** (i) Wysyłka potwierdzona, a commit stanu nie
  powstał (awaria, ubity przebieg, wyczerpane próby): ponowienie ma **ten sam `messageId` i klucz** co
  oryginał. (ii) Dwa równoległe przebiegi czytają ten sam zatwierdzony stan, zanim którykolwiek zapisze, więc
  oba wysyłają. Oceny zgodne dają duplikat z tym samym `messageId` i kluczem; oceny różne (`ALERT_STALE` i
  `ALERT_ERROR` z tej samej rewizji) dają dwie różne wiadomości z tym samym numerem, ale różnymi kluczami
  (`<messageId>:ALERT_STALE`, `<messageId>:ALERT_ERROR`); obie są potwierdzone i rozliczane według kroku 6.
  Wiadomość nie ma dopisku „powtórka”: przebieg nie może wiedzieć, czy poprzednia dotarła.
- **Tożsamość wiadomości to klucz, nie numer.** Dwie różne wiadomości mogą mieć ten sam numer, a nie mogą
  mieć tego samego klucza.
- **G3: dokładnie jedna wiadomość w zwykłym przypadku.** Przy przebiegach szeregowanych i bez awarii między
  wysyłką a commitem wychodzi dokładnie jedna wiadomość na przejście.
- **Reguła odtwarzania identyfikatorów.** `messageId = <etykieta>#<messageSeq + 1>`, gdzie `messageSeq` to
  wartość z ostatniego commitu; klucz idempotencji to `<messageId>:<rodzaj>` (`ALERT_STALE`, `ALERT_ERROR`,
  `REMINDER`, `RECOVERY`). Identyfikator jest funkcją wyłącznie zatwierdzonego stanu, więc żaden nie żyje w
  pamięci przebiegu, który mógł nie zostać zapisany. Rodzaj wchodzi do klucza, bo po nieudanym zapisie
  następny przebieg może potrzebować innej wiadomości pod tym samym numerem.
- **Dlaczego nie „dokładnie raz”.** Wymagałoby to commitu rezerwacji przed wysyłką i kanału z kluczem
  idempotencji, który **honoruje odbiorca**. Bez tego rezerwacja zamienia duplikat w utratę alarmu
  (rezerwacja zapisana, wysyłka nie wyszła), a okno między wysyłką a potwierdzeniem zapisu zostaje. Kanały
  instalacji zwykle nie dają idempotencji po stronie odbiorcy, a dla alarmu utrata jest gorsza niż duplikat.
  Wariant z rezerwacją jest osobnym zgłoszeniem.

### Protokół przebiegu (kolejność jest wymaganiem; `monitor.js`)

1. **Odczyt stanu** wraz z wersją (commit, od którego zależy zapis). Nieudany odczyt to czerwony przebieg;
   nic nie jest wysyłane w ciemno.
2. **Odczyt znacznika** (2 próby) i ocena obu warstw.
3. **Wyznaczenie wiadomości wyłącznie ze stanu z kroku 1 i oceny z kroku 2**: przejście (`lastNotifiedState`
   ≠ bieżący), przypomnienie (stan trwa, a od `lastNotifiedAt` minęło `reminderWorkingHours` godzin pracy),
   powrót (`OK`, a `lastNotifiedState` było `ALERT_*`). Brak należnej wiadomości: zapis samych pól obserwacji.
   Wiadomość odroczona (ALERT_STALE z progu godzin pracy poza oknem) nie jest wysyłana; `undeliveredSince`
   trwa wtedy bez zmian.
4. **Wysyłka z kluczem.** Potwierdzenie przyjęcia przez kanał jest warunkiem zapisu wiadomości. Brak
   potwierdzenia: commit stanu z `undeliveredSince` (jeśli puste), **bez** zmiany `lastNotified*` i
   `messageSeq`; przebieg czerwony; następny wyznaczy ten sam `messageId` i ponowi. Jeśli do następnego
   przebiegu ocena wróciła do stanu, którego dotyczy `lastNotifiedState`, `undeliveredSince` jest czyszczone
   bez wiadomości.
5. **Zapis stanu jednym commitem** na wersji z kroku 1: pola obserwacji i, po potwierdzonej wysyłce,
   `lastNotifiedState`, `lastNotifiedAt`, `lastNotifiedKey`, `messageSeq` + 1, `eventId` i wyczyszczone
   `undeliveredSince`. Odrzucenie jako non-fast-forward to **konflikt**.
6. **Po konflikcie**: ponowny odczyt stanu i ponowna ocena kroku 3 na świeżym stanie. Wiadomość już wysłana
   w tym przebiegu (numer n, klucz k) porównuje się ze świeżym stanem **po kluczu, nie po samym numerze**:
   (a) `lastNotifiedKey` równy k: ta sama wiadomość jest już zapisana, nie zapisuje się jej ponownie;
   (b) `messageSeq` większy od n: zapisana jest wiadomość późniejsza, starszej się nie zapisuje, żeby
   ewidencja się nie cofnęła; (c) w pozostałych przypadkach, także gdy świeży stan ma **inną** wiadomość pod
   tym samym numerem, wiadomość **jest zapisywana na świeżym stanie** z własnym kluczem, a `messageSeq` to
   większy z (świeży, n). Najwyżej 3 próby commitu; po wyczerpaniu przebieg jest czerwony i stan zostaje
   niezmieniony (wysłana wiadomość może wyjść ponownie w następnym przebiegu: sytuacja (i) z G2).

Status przebiegu jest uczciwy: przebieg jest czerwony (kod wyjścia 1), dopóki `alertLevel` to `ALERT_*`,
niezależnie od dedupu, a także przy każdym problemie protokołu (`STATE_READ_FAILED`, `SEND_FAILED`,
`STATE_WRITE_FAILED`, `COMMIT_EXHAUSTED`).

## Kanał dostarczenia

Kanał (e-mail, komunikator) i adresat należą do instalacji i są jej sekretami. **Kanał nie może być
`MailApp` z Apps Script** (to wyzwalacz tego samego projektu, który staje razem z resztą). **Powiadomienie
GitHuba o nieudanym przebiegu nie jest kanałem gwarantowanym:** zależy od ustawień konta odbiorcy, nie ma
potwierdzonego odbioru i nie powstaje, gdy przebiegu nie ma. Może być dodatkiem, ale nie liczy się do
kryteriów akceptacji; te liczą się wyłącznie dla kanału z potwierdzeniem przyjęcia wiadomości.

Domyślny nadawca (`webhook-sender.js`) wysyła POST JSON na adres z `ALERT_WEBHOOK_URL` (tylko `https`),
z nagłówkiem `Idempotency-Key`; potwierdzeniem jest odpowiedź 2xx. Instalacja z innym kanałem podstawia
własnego nadawcę o interfejsie `send(message)` → `{ confirmed: true }` po potwierdzonym przyjęciu.

## Kto pilnuje sprawdzacza (wariant W1, decyzja właściciela z 17.11.2026)

Wyłączony harmonogram nie wyda ani przebiegu, ani czerwonego statusu, ani wiadomości, więc **sprawdzacz nie
może sam zgłosić własnej śmierci**. Kontrolę wykonuje **niezależny od GitHuba i Google proces instalacji**,
który już działa stale: co godzinę czyta `lastSuccessfulCheckAt` i `undeliveredSince` ze stanu i alarmuje
własnym, potwierdzanym kanałem, gdy ostatnie życie jest starsze niż termin (domyślnie 6 godzin pracy albo
26 godzin bezwzględnie). Tygodniowa wiadomość o życiu może zostać, ale jako dodatek, nie zabezpieczenie.

Repozytorium dostarcza czystą ocenę tej kontroli (`liveness.js`) i wejście
`node scripts/freshness-monitor/cli.js liveness --state <plik>` (kod 0: OK, 1: alarm, 2: błąd
konfiguracji), z konfiguracją w `FRESHNESS_LIVENESS_CONFIG` (`label`, `timeZone`, `window`, `holidays`,
`deadWorkingHours`, `deadHardHours`). Plik stanu proces instalacji pobiera sam (np. `git fetch` gałęzi
`monitor-state` i `git show FETCH_HEAD:state.json`); **nieudane pobranie stanu jest alarmem po stronie
tego procesu** (kod wyjścia i kanał to jego sprawa). Alarm powstaje, gdy: brak stanu albo pulsu
(`NO_STATE`, `NO_HEARTBEAT`), plik nie do odczytu (`STATE_INVALID`), puls z przyszłości
(`HEARTBEAT_INVALID`), puls starszy niż termin (`HEARTBEAT_STALE`), niedostarczona wiadomość starsza niż
termin (`UNDELIVERED_STALE`). Dostarczenie i deduplikacja alarmu tej kontroli należą do procesu instalacji
(poza tym repozytorium).

## Prywatność i repo publiczne

Alert, log, stan i komunikaty błędów zawierają **wyłącznie**: neutralną etykietę źródła z konfiguracji,
stan, wiek w pełnych godzinach, próg, chwilę przebiegu i `eventId`. Żadnej treści wierszy, danych
osobowych, nazw klientów, identyfikatorów plików Google, adresów URL ani adresów e-mail w repo, logach,
stanie, wiadomościach i wyjątkach. Błąd HTTP jest raportowany jako sam kod (np. 403), bez adresu żądania
(adres zawiera identyfikator pliku, a maskowanie sekretów w logach nie obejmuje jego pochodnych, np. po
zakodowaniu URL). Pilnują tego testy 18–21 (`test/freshness-monitor-privacy.test.js`). W repozytorium
publicznym nie powstają przebiegi tego workflow, tylko szablon i testy.

## Instalacja w prywatnym repozytorium (zadanie właściciela instalacji)

Instalacja, test na kopii i wdrożenie nie są częścią tego repozytorium i wymagają zgody właściciela.

1. Plik sygnałowy: osobny mały plik z jedną komórką znacznika jako tekst `RRRR-MM-DD GG:MM:SS` (patrz
   „Zasada minimalnych uprawnień”). Tożsamość sprawdzacza dostaje do niego dostęp do odczytu i **do
   niczego więcej**.
2. W prywatnym repozytorium: skopiuj `docs/freshness-monitor/workflow.template.yml` do
   `.github/workflows/`, wstaw pełny SHA zaudytowanego commitu tego repozytorium w kroku pobrania kodu i
   dodaj krok wystawiający `GOOGLE_ACCESS_TOKEN` (uwierzytelnienie Google instalacji, akcja przypięta do
   SHA, #232). Uprawnienia: `contents: write` tylko dla tego jednego joba.
3. Sekrety repozytorium: `FRESHNESS_MONITOR_CONFIG`, `SIGNAL_FILE_ID`, `SIGNAL_RANGE`, `ALERT_WEBHOOK_URL`
   (oraz to, czego wymaga krok uwierzytelnienia Google).
4. Kalibracja progu (`calibrateThreshold`) na znacznikach z ostatnich 3 miesięcy; wynik do
   `FRESHNESS_MONITOR_CONFIG`.
5. Niezależna kontrola życia (W1) w procesie instalacji, który działa stale; potwierdzony odbiór
   alarmu u adresata.
6. Harmonogram GitHuba też może stanąć (wyłączenie workflow przez człowieka, zmiana uprawnień, wygasły
   sekret, spóźnione albo pominięte uruchomienia `schedule`): wykrywa to kontrola życia z punktu 5.

## Testy na kopii (przypadki 22–29): do wykonania przez właściciela instalacji

Do wykonania na **kopii** pliku źródłowego i pliku sygnałowego, z osobną tożsamością testową sprawdzacza,
adresatem testowym i osobną gałęzią stanu. **Status: niewykonane** (wymagają prawdziwych plików Google,
prywatnego repozytorium testowego i zgody właściciela; nie są częścią PR z kodem).

| # | przypadek | oczekiwanie |
| --- | --- | --- |
| 22 | martwe wyzwalacze: w projekcie Apps Script kopii nie ma żadnego wyzwalacza (zapis listy w wyniku), znacznik starszy niż próg | alert u adresata testowego w ciągu jednego interwału harmonogramu (główny przypadek całego zgłoszenia) |
| 23 | nowy znacznik w kopii źródłowej | wiadomość o powrocie; **zmierzyć i zapisać opóźnienie propagacji `IMPORTRANGE`** (wchodzi do marginesu progu) |
| 24 | cofnięcie zgody `IMPORTRANGE` albo dostępu tożsamości sprawdzacza | `ALERT_ERROR` z właściwą treścią, nie `ALERT_STALE`, nie cisza; po przywróceniu wiadomość o powrocie |
| 25 | tożsamość sprawdzacza próbuje odczytać kopię arkusza z wierszami | odmowa dostępu (dowód zasady minimalnych uprawnień) |
| 26 | unieważniony sekret odczytu; unieważniony sekret kanału | przebieg czerwony i `ALERT_ERROR`; przy kanale: `lastNotified*` bez zmiany, `undeliveredSince` ustawione i widoczne dla kontroli życia |
| 27 | wyłączony harmonogram | brak przebiegów; niezależna kontrola (W1) zgłasza brak życia w swoim terminie, a odbiór potwierdza adresat testowy |
| 28 | powiadomienia GitHuba o nieudanym przebiegu | opisać, kto je dostaje i czy dochodzą (nie wchodzi do kryteriów akceptacji) |
| 29 | przegląd logów przebiegów kopii | brak identyfikatorów plików, adresów, e-maili i treści wierszy (grep po pełnym logu, wynik wklejony do wyniku testu) |

**Opóźnienie propagacji pliku sygnałowego: niezmierzone.** Wartość trafia tutaj po przypadku 23; do tego
czasu margines progu nie zawiera poprawki na propagację `IMPORTRANGE`.

## Użycie

```
node scripts/freshness-monitor/cli.js check
node scripts/freshness-monitor/cli.js liveness --state <plik>
```

Kody wyjścia `check`: 0 zielony, 1 czerwony (alarm albo problem protokołu), 2 błąd konfiguracji. Wejście
(`FRESHNESS_MONITOR_CONFIG`, `SIGNAL_FILE_ID`, `SIGNAL_RANGE`, `GOOGLE_ACCESS_TOKEN`, `ALERT_WEBHOOK_URL`,
`STATE_REPO_DIR`) pochodzi ze środowiska; na wyjście trafiają tylko stałe kody i linie z pól o stałym
kształcie. Kod wymaga Node 20 lub nowszego i nie ma zależności.
