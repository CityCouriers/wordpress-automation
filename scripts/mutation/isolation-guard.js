'use strict';

// Bramka startu mutantów w tej gałęzi pilota: ZAWSZE odmawia. Status pilota to `no-go-izolacja`
// (audyty #238), a skończona sonda (isolation-probe.js) nie może być upoważnieniem do startu:
// nie ma tu zmiennej, pliku ani flagi, które by tę odmowę zdejmowały, bo każdą taką deklarację
// da się sfałszować (także zmienną środowiskową typu „MUTATION_ISOLATED=1”).
// Start mutantów wymaga dowodu MECHANIZMU izolacji dla całego drzewa procesów (np. kontener bez
// sieci, ograniczony mount i UID, jawna polityka systemu plików) w specyfikacji joba z #253;
// ta gałąź go nie zawiera, więc narzędzia uruchamiające Stryker w niej nie startują.
function refuseStart(tool) {
  console.error(
    `no-go-izolacja: ${tool} nie startuje mutantów w tej gałęzi pilota. ` +
    'Mutacje uruchamia się wyłącznie w środowisku z wymuszoną izolacją całego drzewa procesów ' +
    '(kontener bez sieci, ograniczony mount i UID, bez HOME i sekretów) zdefiniowanym w #253; ' +
    'sonda scripts/mutation/isolation-probe.js jest tylko diagnostyką i nie zastępuje tego dowodu.'
  );
  process.exit(3);
}

module.exports = { refuseStart };
