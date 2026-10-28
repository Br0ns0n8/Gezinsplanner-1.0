# Gezinsplanner met eigen server (testversie)

De app (map `public/`) praat nu met een eigen server (`server.js`). Daardoor kunnen gezinnen
echt samen testen: inloggen met een eigen account, dezelfde gegevens zien en elkaar bellen.

## Wat is er nieuw
- **Accounts per gezin.** Inloggen met gezinscode + accountnaam + eigen code.
  Nieuw gezin aanmaken: de maker wordt beheerder (wachtwoord minstens 8 tekens).
  Meedoen: met de uitnodigingscode, eigen naam en eigen code (minstens 4 tekens).
- **De server bepaalt de rechten**, niet de telefoon. Een kind kan met een aangepaste app
  zichzelf geen beheerder maken: de server draait zulke wijzigingen terug.
- **Delen tussen telefoons.** Wijzigingen komen binnen een paar tellen bij de anderen aan.
- **Bellen**: de server geeft alleen de verbindingsberichten door. Beeld en geluid gaan
  rechtstreeks tussen de telefoons. Wie er belt wordt door de server vastgesteld.
- Codes worden met scrypt opgeslagen (niet leesbaar). Na 8 foute pogingen per account
  (of 30 per IP-adres) wordt inloggen 15 minuten geblokkeerd.
- Beheerder kan: codes van anderen resetten, een nieuwe uitnodigingscode maken, alle
  gegevens downloaden en het hele gezin verwijderen. Iedereen kan de eigen code wijzigen.
- De privacytekst (blok `LEGAL` in `index.html`) is aangepast aan deze server (versie 1.1).
  **Laat die lezen en vul de contactgegevens in voordat je andere gezinnen uitnodigt.**

## Starten op je computer
Je hebt alleen Node 20 of nieuwer nodig. Er zijn geen pakketten om te installeren.

    node server.js          # daarna: http://localhost:8080

Camera, microfoon en de service worker werken alleen via **https** (of op `localhost`).
Voor testen met telefoons moet de server dus achter https staan (zie hieronder).

## Online zetten
Je hebt een host nodig waar een Node-programma blijft draaien, met een **blijvende schijf**.
De gegevens staan in `DATA_DIR/db.json`. Op hosts met een tijdelijke schijf (zoals de gratis
laag van Render) verdwijnen de gegevens bij elke herstart. Kies dus een host met een volume
(bijvoorbeeld Fly.io, Railway of een eigen VPS).

Met Docker:

    docker build -t gezinsplanner .
    docker run -d -p 8080:8080 -v gezinsplanner-data:/data -e TRUST_PROXY=1 gezinsplanner

Instellingen (omgevingsvariabelen):
| Naam | Betekenis |
|---|---|
| `PORT` | poort, standaard 8080 |
| `DATA_DIR` | map voor gegevens, standaard `./data` (op een volume zetten) |
| `SECRET` | geheim voor inlogtokens. Laat leeg: dan wordt er een gemaakt en bewaard in `DATA_DIR` |
| `TRUST_PROXY=1` | zet aan achter een proxy met https, zodat het echte IP-adres wordt gebruikt |
| `TURN_URL`, `TURN_SECRET` | optioneel, voor bellen op moeilijke netwerken (zie hieronder) |

Draai **precies één kopie** van de server: live verbindingen en de blokkades staan in het geheugen.

## Bellen op moeilijke netwerken
De app gebruikt een openbare STUN-server. Dat werkt op veel wifi-netwerken, maar niet overal
(bijvoorbeeld sommige mobiele netwerken en bedrijfsnetwerken). Daarvoor heb je een TURN-server
nodig, bijvoorbeeld coturn met `use-auth-secret`. Zet dan `TURN_URL` (bijvoorbeeld
`turn:jouwserver.nl:3478`) en `TURN_SECRET`; de server deelt tijdelijke inloggegevens uit.

## Tests
    npm test
- `test/server.test.js`: accounts, rechten, delen, live berichten, bellen-berichten, bestanden.
- `test/client-smoke.js`: draait de echte app-code met een nagebootste browser tegen de server.
Dit vervangt niet het testen op echte telefoons.

## Bekende beperkingen (eerlijk)
- **Gelijktijdig wijzigen**: de app stuurt nog steeds de hele stand op, de laatste wijziging wint.
  Als twee mensen binnen een halve seconde iets aanpassen, kan één wijziging verloren gaan.
- **Rechten zijn grof**: de server controleert per onderdeel en voor kinderen ook per eigen
  taak, punt, wens, contact en beloningsverzoek. Binnen een onderdeel is er geen
  controle op de inhoud (bijvoorbeeld de hoogte van punten die een ouder instelt).
- **Offline** werkt de app alleen als het scherm; wijzigingen worden niet bewaard tot er weer verbinding is.
- **Geen e-mail**: wie zijn code kwijt is, vraagt een ouder of beheerder om een nieuwe.
  Een beheerder die zijn eigen code vergeet kan alleen door een andere beheerder worden geholpen.
- **Niet end-to-end versleuteld**: wie de server beheert kan de gegevens technisch lezen.
- De gegevens staan in één bestand. Prima voor een paar gezinnen, niet voor honderden.
- Bellen is een proefversie en nog niet op echte telefoons getest.
- Voor kinderen volstaat een code van 4 tekens. Dat is bewust makkelijk; de blokkade na foute
  pogingen beschermt tegen gokken, maar het blijft een eenvoudige code.

## Bestanden
- `server.js` de server (alles in één bestand, geen pakketten)
- `public/` de app: `index.html`, `net.js` (verbinding met de server), `sw.js`, `manifest.webmanifest`, `icons/`
- `Dockerfile`, `package.json`, `test/`
