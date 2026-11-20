/**
 * Informacja o wdrożonej wersji, wyświetlana w menu arkusza.
 *
 * NIE EDYTUJ RĘCZNIE. Workflow „Deploy to Apps Script” nadpisuje ten plik tuż
 * przed `clasp push` danymi z GitHuba (tag release'u, commit, data, kto).
 * W repozytorium trzymamy tylko wartości zastępcze, więc źródłem numeru
 * wersji pozostają GitHub Releases. Drift check porównuje ten plik w całości z kanonicznym zapisem (nie dopisuj tu kodu).
 */
const DEPLOYED_VERSION = {
  tag: 'dev',
  commit: '',
  deployedAt: '',
  deployedBy: ''
};
