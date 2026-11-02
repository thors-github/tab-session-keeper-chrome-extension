# Tab Session Keeper 1.2.1

[English instructions](README.md)

Lokale Chrome-Erweiterung für ausgewählte Tabs: Hintergrundanfragen oder unterstützte native Verlängerungsmethoden halten ihre Sitzung aktiv. Formulare und Seitenzustand bleiben erhalten. Gespeicherte Website-Regeln aktivieren passende offene Tabs auch nach einem Browser-Neustart wieder.

## Installieren und aktualisieren

1. `tab-session-keeper-1.2.1.zip` in einen dauerhaften Ordner entpacken.
2. `chrome://extensions` öffnen und **Entwicklermodus** einschalten.
3. **Entpackte Erweiterung laden** wählen und den Ordner mit `manifest.json` auswählen.
4. Tab Session Keeper über das Erweiterungsmenü anheften.

Benötigt wird Chrome 120 oder neuer. Zur Installation sind weder Node.js noch ein Build-Schritt erforderlich.

**Bestehende entpackte Installation aktualisieren:** Dateien im **gleichen bereits von Chrome geladenen Ordner** ersetzen, anschließend auf der Erweiterungskarte **Neu laden** anklicken. Erweiterung nicht entfernen und Ordnerpfad beibehalten: So bleiben ID und lokale Website-Regeln erhalten. Vorübergehende Tab-Aktivierungen und Ausnahmen werden beim Neuladen zurückgesetzt.

Die Oberfläche folgt der Chrome-Sprache: Deutsch bei deutscher Oberfläche, sonst Englisch. Vorhandene deutsche Laufzeitmeldungen erscheinen über den aktuellen Übersetzungskatalog. Das Toolbar-Symbol zeigt die kompakte metallische **Eisenwächter**-Maske: neutrale Augen bei Inaktivität, rote Augen bei ausführbarem Keep-alive. Im normalen aktiven Betrieb erscheint zusätzlich **An** auf Deutsch beziehungsweise **On** auf Englisch. **!** hat bei Warnungen Vorrang, auch bei pausierter Anmeldung; ausgeschaltete Tabs haben kein Badge.

## Tab aktivieren oder Website merken

Website öffnen, anmelden und das Erweiterungssymbol anklicken. **Keep-alive für diesen Tab** einschalten. Unter **Intervall & Adresse** 1–60 Minuten einstellen und **Einstellungen übernehmen** wählen. **Jetzt testen** führt sofort eine Aktion aus. Das Popup zeigt Methode, tatsächlichen Abstand, letzte Ergebnisse und nächsten Versuch.

Die Tab-Aktivierung endet beim Schließen, Wechsel auf einen anderen Ursprung oder Chrome-Neustart. Navigation innerhalb desselben Ursprungs bleibt unterstützt. Chrome-interne Seiten, der Web Store und andere geschützte Seiten sind ausgeschlossen.

**Für diese Website merken** speichert Ursprung, Intervall und optionale Adresse. Chrome fragt den Website-Zugriff ab. Die Regel gilt für alle Pfade desselben Ursprungs aus Protokoll, Host und Port; Subdomains sind getrennt. Wiederhergestellte und später geöffnete passende Tabs werden erneut aktiviert. Die Erweiterung öffnet selbst keine Tabs. Ungeladene, verworfene oder eingefrorene Dokumente warten, bis Chrome sie ausführen kann.

Das Zahnrad öffnet die Regelverwaltung. Dort Regeln bearbeiten, ausschalten oder löschen. Eine einzelne Tab-Ausnahme hat bis zur Tab-Schließung oder zum Neustart Vorrang. Entzogener Website-Zugriff pausiert die gespeicherte Regel; Zugriff nur bewusst erneut erlauben.

## Automatische Anwendungsprofile

Für automatische Erkennung die **Keep-alive-Adresse leer lassen**. Eine ausdrücklich eingetragene Adresse desselben Ursprungs wählt immer eine normale GET-Anfrage, auch bei einer erkannten Anwendung.

| Profil | Aktion | Höchster Abstand |
| --- | --- | --- |
| Allgemeine Website | Gleichursprüngliches GET der aktuellen Adresse ohne Fragment | Eingestelltes Intervall |
| BeyondTrust-Webkonsole | Neutrales, nicht weitergereichtes `mousemove` direkt am Fenster der Seite | 1 Minute |
| Apache Guacamole | Native authentifizierte `request()`-Anfrage an `api/session/tunnels` | 5 Minuten |
| Proxmox VE | Native Ticket-Anfrage mit anschließendem `updateLoginData()` des Workspace | 15 Minuten |

Der tatsächliche Abstand ist der kleinere Wert aus Einstellung und Profilgrenze. Die gespeicherte Einstellung bleibt erhalten. Erkennung erfordert bekannte Seitenmerkmale und native Funktionen; ein Produktname allein reicht nicht. Erkannte Anwendungen warten während des Starts oder pausieren bei nicht unterstützter Anmeldung beziehungsweise fehlenden erforderlichen Funktionen; ihre statische Startseite wird nicht ersatzweise angefragt.

**BeyondTrust:** Das unterstützte `/console`-Profil wartet während des Anwendungsstarts und benötigt den angemeldeten Kopfbereich. Eine Anmeldemaske pausiert es. Das Signal richtet sich ans Fenster und sendet weder Klicks noch Tasten- oder Mausereignisse an eine Fernsteuerungsfläche. Bei einer zuvor untersuchten angemeldeten Produktversion wurde die Ausführung des vorhandenen Aktivitäts-Handlers beobachtet. Das beweist weder den Grund eines früheren Logouts noch eine stundenlange Produktionslaufzeit.

**Guacamole:** Eine lesende authentifizierte native Sitzungsanfrage verlängert die serverseitige Inaktivitätsfrist. Methoden zur Token-Rotation werden bewusst vermieden: Eine verspätete Antwort könnte sonst eine neuere Anmeldung überschreiben. Die Erweiterung verändert weder Token noch Anmeldezustand der Seite. Anonyme und abgemeldete Sitzungen sind ausgeschlossen. Benutzername, Token und Tunnel-Antwort gelangen nicht zum Erweiterungs-Worker.

**Proxmox VE:** Unterstützt wird ein vorhandenes normales Web-Sitzungsticket. Eine verspätete Antwort wird nach Abmeldung, Kontowechsel, Ticketwechsel oder Profilwechsel verworfen. API-Token-Anmeldung, unvollständige TFA, abgemeldete Sitzungen und fehlende Workspace-Funktionen sind ausgeschlossen. Der native Workspace übernimmt neues Ticket und CSRF-Zustand. Die Erweiterung beginnt keine neue Anmeldung.

Guacamole und Proxmox wurden mit quellengestützten lokalen Testnachbildungen geprüft, **nicht an echten Installationen**. Festgelegte Primärquellen: [Guacamole-Anmeldedienst](https://github.com/apache/guacamole-client/blob/31d2a6f6accc5ed4fecd491c30fc51728db940eb/guacamole/src/main/frontend/src/app/auth/service/authenticationService.js), [Guacamole-Sitzungszugriff](https://github.com/apache/guacamole-client/blob/31d2a6f6accc5ed4fecd491c30fc51728db940eb/guacamole/src/main/java/org/apache/guacamole/rest/session/SessionResource.java), [Guacamole-Seitenstruktur](https://github.com/apache/guacamole-client/blob/31d2a6f6accc5ed4fecd491c30fc51728db940eb/guacamole/src/main/frontend/src/index.html), [Proxmox-Workspace](https://github.com/proxmox/pve-manager/blob/c79d601b09c00f1b7a7d0ef7ec0fc9326038298e/www/manager6/Workspace.js), [Proxmox-Anmeldefunktionen](https://github.com/proxmox/proxmox-widget-toolkit/blob/d353f9466dee3e6c35a8af26e83899a6a580169c/src/Utils.js).

## Ergebnisse und Grenzen

Eine erfolgreiche Anfrage bestätigt einen HTTP-Aufruf; ein Aktivitätsergebnis bestätigt das lokale Auslösen; ein Verlängerungsergebnis bestätigt den Abschluss der gewählten nativen Methode. Keines garantiert eine stundenlange Anmeldung. Die Website entscheidet weiterhin über feste Ablaufzeiten, erforderliche Anmeldung und MFA. Abgelaufene oder beim Browserende gelöschte Sitzungen können eine neue Anmeldung verlangen. Cookie-Sitzungen können zwischen Tabs geteilt sein.

HTTP 401/403, Weiterleitungen und native Anmeldefehler pausieren den Tab. Website prüfen beziehungsweise anmelden und **Fortsetzen** wählen. Netzwerkfehler werden im regulären Intervall erneut versucht. Aktionen haben 15 Sekunden Zeitlimit; Chrome kann sie verzögern. Eine noch laufende native Aktion hält eine Sperre in der Seite, damit Folgeversuche keine parallele Verlängerung beginnen.

Chrome muss laufen und der Rechner wach sein. Alarme können verzögert werden. Schutz vor automatischem Verwerfen verhindert nicht jedes Einfrieren. Die Erweiterung kann serverseitige Sitzungsregeln nicht ändern.

## Datenschutz und Berechtigungen

Es gibt keinen Erweiterungsserver, keine Telemetrie und keine Übertragung an einen Erweiterungsanbieter. HTTP- und native Anfragen gehen an den Ursprung der ausgewählten Seite. Native Anmeldedaten bleiben im eigenen Anwendungskontext der Seite und ihren normalen Anfragen; sie werden weder an den Worker zurückgegeben noch in Einstellungen, Verlauf oder Protokollen der Erweiterung gespeichert. Gespeichert werden Regeln und begrenzte Ausführungsmetadaten.

- `activeTab` und `scripting`: Gewählte Aktion nach bewusster Aktivierung ausführen.
- `storage`: Lokale Website-Regeln und Tab-Zustand der Browsersitzung.
- `alarms`: Ausführung auch bei ruhendem Erweiterungs-Worker planen.
- Optionaler Website-Zugriff: Beim dauerhaften Merken angefragt. Chrome kann technisch mehr als einen Port freigeben; die Erweiterung prüft zusätzlich den genauen Ursprung.

Die transparenten inaktiven/aktiven Eisenwächter-Symbole einschließlich Quellenhinweisen liegen in `icons/`. Das breite Gesicht und die kurzen Hörner lassen die roten Augen auch in Toolbar-Größe erkennen. Sie funktionieren ohne Bilddienst zur Laufzeit.

## Entwicklung und Prüfung

Mit Node.js 20 oder neuer:

```sh
npm install
npm test
npx playwright install chromium
npm run test:browser
npm run test:browser:bt
npm run test:browser:profiles
npm run package
```

Die Tests verwenden Dummy-Anmeldedaten, lokale HTTP-Seiten und getrennte temporäre Chromium-Profile. Geprüft werden Inaktivitätsablauf gegen Kontrollsitzung, echte Ereignisse von der isolierten Erweiterungsumgebung zur Hauptseite, Guacamole-Sitzungszugriff ohne Anmeldemutation, native Proxmox-Zustandsübernahme, Abmeldung beziehungsweise Kontowechsel während laufender Anfragen, ausgeschlossene Anmeldearten, fehlender Export von Anmeldedaten, ausbleibende Fernsteuerungseingaben, Timeout und Parallelität sowie echter Worker-Neustart und Browser-Neustart. Deutsch, Englisch und Rückfall auf Englisch sind durch eine Testmatrix abgedeckt. Sprach-Screenshots verwenden eine reine Testsimulation der Chrome-Kataloge, wenn macOS die Chromium-Sprachparameter ignoriert. Die Sprache des Nutzerbrowsers wird nicht verändert.

Für automatisierte Funktionstests erhält nur eine temporäre Erweiterungskopie Zugriff auf die lokale Testadresse. Ein zusätzlicher Durchlauf mit unverändertem Produktionsmanifest prüft echte Toolbar-Aktivierung und `activeTab`. Native Annahme der optionalen Berechtigungsabfrage, Betriebssystem-Ruhezustand und echte Guacamole-/Proxmox-Kompatibilität bleiben manuelle Prüfungen. Screenshots landen außerhalb des Projekts im temporären Betriebssystemordner.

Die Paketierung erstellt im übergeordneten Ordner `tab-session-keeper.zip` und `tab-session-keeper-1.2.1.zip`. Enthalten sind ausschließlich Produktionsdateien, beide Sprachkataloge, Symbole und Dokumentation; keine Entwicklungsabhängigkeiten oder Tests.
