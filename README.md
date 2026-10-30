# Word Work

En lugn, distraktionsfri ordbehandlare för kulturjournalister och författare.
Du skriver i ett rent fönster utan verktygsfält som stör – med svensk
stavningskontroll, synonymer, läsbarhetsanalys, versionshistorik och export
till Word. Det finns också en AI-assistent som kan granska texten, men den
**skriver aldrig i din text** – den föreslår bara.

Word Work finns för **Mac, Windows och Linux**. Texterna sparas som vanliga
filer på din egen dator.

Appen är till 99% utvecklad med hjälp av Claude, modellen som använts är Opus 5.5.

Open source, och bidrag är välkomna.

## Ladda ner och installera

Hämta senaste versionen under **Releases** här på GitHub och välj rätt fil:

| Dator | Fil |
|---|---|
| Mac med Apple-chip (M1 eller senare) | `…_macOS-AppleSilicon.dmg` |
| Mac med Intel-processor | `…_macOS-Intel.dmg` |
| Windows 10/11 | `…_Windows-x64-setup.exe` |
| Linux | `.deb` (Ubuntu, Debian), `.rpm` (Fedora) eller `.AppImage` (övriga) |

Osäker på vilken Mac du har? Välj **Apple-menyn → Om den här datorn**. Står
det "Chip Apple M…" är det Apple-chip, står det "Processor Intel …" är det Intel.

**Mac:** Öppna `.dmg`-filen och dra Word Work till **Program**.

**Windows:** Kör installationsfilen. Den installerar Word Work för ditt konto
och lägger till det i Start-menyn.

**Linux:** Installera `.deb` eller `.rpm` som vanligt, eller gör
`.AppImage`-filen körbar och starta den.

### Första gången du startar

Word Work är ännu inte signerat av Apple eller Microsoft. Därför varnar
datorn första gången – det är normalt för program som inte köps via en
appbutik.

- **Mac:** Öppna Word Work. När macOS säger att appen inte kan verifieras,
  klicka **Klar**. Gå sedan till **Systeminställningar → Integritet och
  säkerhet**, rulla ned och klicka **Öppna ändå** vid Word Work. Bekräfta med
  lösenord eller Touch ID. Efter det öppnas Word Work som vanligt.
- **Windows:** När rutan "Windows skyddade datorn" visas, klicka **Mer
  information** och sedan **Kör ändå**.

Samma bekräftelse behövs en gång till efter varje uppdatering. Mer om
installation, kontroll av nedladdningen och avinstallation finns i
[docs/INSTALL.md](docs/INSTALL.md).

## Kom igång

- Word Work öppnar senaste dokumentet. Börja skriva – texten sparas av sig
  själv strax efter att du slutat skriva.
- **Arkiv → Nytt dokument** (⌘N) skapar ett nytt dokument och **Dokument**
  (⌘O) visar alla dina texter.
- Gränssnittet tonas bort medan du skriver och kommer tillbaka när du rör
  musen. Håll muspekaren över en knapp för att se vad den gör.
- **F1** visar alla kortkommandon.

I den här texten står **⌘** för Command-tangenten på Mac. På Windows och Linux
använder du **Ctrl** i stället, och **⌥** (Alt/Option) är **Alt**.

## Var sparas texterna?

Texterna sparas som vanliga Markdown-filer i mappen **Dokument/Word Work** i
din hemkatalog. Du kan läsa dem i vilket textprogram som helst och
säkerhetskopiera dem som andra filer, till exempel med Time Machine eller en
molnsynkad mapp.

- Vill du ha texterna någon annanstans: **Inställningar → Datamapp → Byt
  mapp …**. Där finns också **Visa i Finder**.
- **Arkiv → Spara allt (zip) …** sparar allt – dokument, versioner,
  AI-samtal, papperskorg och inställningar – i en enda fil.
- Har du använt den webbaserade (Docker-)versionen av Word Work? Välj dess
  `data`-mapp som datamapp, så finns allt med. Inget behöver konverteras.

## Så fungerar det

### Skriva

- **Skriv / Markdown.** Växla vy med knapparna högst upp eller **⌘/**. I
  Skriv-vyn ser du formateringen (rubriker, fetstil, kursiv, citat, listor), i
  Markdown-vyn källtexten.
- **Allt är Markdown.** Bara formatering som Markdown kan uttrycka går att
  använda – inga typsnitt, färger eller understrykningar i själva texten.
  Klistrar du in formaterad text rensas sådant bort.
- **Typsnitt och tema** väljs under **Inställningar** (⌘,) och gäller hela
  texten. Där ställer du också in storlek, radavstånd, textbredd, dimning av
  andra stycken och skrivmaskinsläge.
- **Helskärm:** ⌃⌘F på Mac, F11 på Windows och Linux.
- **Dagens skrivmål:** ställ in ett antal ord per dag under Inställningar.
  Statusraden visar hur många ord du skrivit i dag.

### Metadata

Knappen med etikettikonen öppnar **Metadata**: *Rubrik*, *Ingress*,
*Byline*, *Beställare*, *Deadline* och *Längdmål* (till exempel `4500 tecken`
eller `800 ord`).

- Längdmålet visas som en mätare i statusraden och blir orange när texten är
  mer än 5 % för lång.
- Deadline visas i statusraden ("Deadline i morgon") och blir röd när den
  passerats.
- **Texttyp** och **Instruktioner till AI** styr AI-assistenten (se nedan).
- Rubriken blir dokumenttitel vid export.

### Spara och versioner

- **Autospar** sker strax efter att du slutat skriva. Stänger du fönstret
  eller avslutar Word Work sparas texten först.
- **⌘S** sparar och lägger en version i historiken. Dessutom sparas en
  automatisk version högst var femte minut.
- Under **Versionshistorik** kan du förhandsgranska en version, jämföra den
  med nuvarande text och återställa den. Den nuvarande texten sparas alltid
  först, så inget går förlorat.
- **Borttagna dokument** hamnar i papperskorgen (**Arkiv → Papperskorgen …**)
  tillsammans med sin historik och sina AI-samtal och kan återställas. Inget
  raderas på riktigt.

### Sök och ersätt

**⌘F** söker, **⌥⌘F** öppnar sök och ersätt. Enter går till nästa träff,
Shift+Enter till föregående. *Aa* skiljer på stora och små bokstäver och
*Hela ord* hittar bara hela ord. *Ersätt alla* ångras med ett **⌘Z**.

### Anteckningar, kommentarer och fotnoter

- **Egen anteckning** (⌥⌘M, eller högerklick): gör stycket till en gul lapp
  för dig själv. Anteckningar räknas inte och följer aldrig med vid export.
- **Kommentera** (⌥⌘K): markera några ord och skriv en kommentar, till
  exempel "Kolla källan". Den kommenterade texten får gul bakgrund. Under
  **Analys** finns en lista över alla kommentarer.
- **Fotnot** (⌥⌘N): fotnoten hamnar där markören står och numreras om av sig
  själv. Vid export till Word, OpenDocument, RTF och HTML blir det riktiga
  fotnoter.

### Typografi

- **Infoga tecken** (⌘.): svenska citattecken, tankstreck, hårda mellanslag,
  bråk, accenter med mera. Sök på namn, till exempel "tankstreck".
- **Automatiskt medan du skriver:** `"` blir ”, `--` blir tankstreck –,
  `...` blir …, `12-15` blir 12–15 och `-- ` först i ett stycke blir
  replikstreck. Backsteg direkt efter ångrar. Kan stängas av under
  Inställningar, där du också väljer citattecken (”svenska”, »vinkel» eller
  raka).
- **Rätta typografin i texten …** (Redigera-menyn) går igenom befintlig text,
  till exempel inklistrad text med raka citattecken. Du ser ändringarna innan
  de görs.

### Stavning och synonymer

- **Stavningskontrollen** (svensk ordlista) stryker under okända ord.
  Högerklicka för rättningsförslag, *Lägg till i egen ordlista* eller
  *Ignorera*.
- **Egen ordlista:** under Inställningar kan du lägga till, ändra och ta bort
  ord. Även fraser som "open source" eller "New York Times" fungerar – de
  godkänns bara när orden står tillsammans.
- **Synonymer:** högerklicka på valfritt ord. Är ordet böjt visas även
  synonymer till grundformen.

### Analys

Knappen **Analys** (eller LIX-värdet i statusraden) visar:

- LIX med tolkning, ord per mening, andel långa ord och lästid
- de vanligaste orden – klicka för att markera dem i texten
- de längsta meningarna, och vid behov understrykning av meningar längre än
  ett visst antal ord
- nominalstil (substantiveringar per 100 ord)
- citat och repliker, med en lista att stämma av mot källor och intervjuer

Markerar du några ord gäller analysen bara markeringen.

### Exportera och publicera

- **Exportera** (⌘E) till Word (.docx), OpenDocument (.odt), RTF, HTML,
  Markdown eller ren text. Klicka **Spara …** och välj var filen ska hamna.
- Word och OpenDocument har tre mallar, alla i A4 med sidnummer: *Standard*,
  *Manus* (Times, 1,5 radavstånd) och *Artikel*. Du kan välja **ny sida före
  varje kapitel**.
- **Kopiera för publicering** (⇧⌘C) lägger texten i urklipp med rubriker,
  fet och kursiv stil, citat, listor och länkar – klar att klistra in i
  WordPress eller ett annat publiceringssystem. Anteckningar och kommentarer
  följer aldrig med.

### Importera

**Arkiv → Importera …** (⇧⌘O), eller släpp en fil i fönstret: Word,
OpenDocument, RTF, HTML, Markdown och text. Formatering som Markdown inte kan
uttrycka tas bort, fotnoter behålls och titel och författare hamnar i
Metadata.

## AI-assistenten

AI-assistenten (gemet i verktygsraden, **⌘J**) är ett bollplank och en
granskare – **den skriver aldrig i din text**. Svaren visas bara i panelen.

- **Snabbval:** granska språket, hitta upprepningar, stramare text, struktur
  och dramaturgi, fakta att kontrollera. Du kan också ställa egna frågor och
  följdfrågor.
- Markera ett avsnitt först om frågan bara gäller det.
- **Texttyp** (nyhet, recension, krönika, prosa, lyrik, sakprosa) och egna
  **instruktioner till AI** anges i Metadata. Med prosa och lyrik rättas till
  exempel inte avsiktliga stilgrepp som fel.
- Citat i svaren är klickbara och visar stället i texten.
- *Tänk efter först* ger träffsäkrare svar men tar längre tid.
- **Stoppa** avbryter ett svar. Alla samtal sparas per dokument och kan
  öppnas igen.

### Ställa in AI-assistenten

AI-assistenten behöver en AI-tjänst. Välj **Inställningar → AI-assistent**:

- **Ollama** – en AI-modell som körs på din egen dator eller i ditt nätverk
  (till exempel `http://localhost:11434`). Texten lämnar då inte din dator.
  Installera Ollama från ollama.com och hämta en modell.
- **OpenAI-kompatibel** – till exempel OpenAI eller OpenRouter. Ange adressen
  och din API-nyckel. Nyckeln sparas i datorns nyckelring och visas aldrig
  igen.

Används en tjänst på internet står det i AI-panelen, eftersom texten då
skickas dit. Utan AI-tjänst fungerar allt annat som vanligt – AI-knappen
syns bara inte.

## Kortkommandon

| Mac | Windows / Linux | Gör |
|---|---|---|
| ⌘N | Ctrl+N | Nytt dokument |
| ⌘O | Ctrl+O | Dokumentlistan |
| ⌘S | Ctrl+S | Spara och skapa version |
| ⌘/ | Ctrl+/ | Växla Skriv/Markdown |
| ⌘E | Ctrl+E | Exportera |
| ⇧⌘C | Ctrl+Shift+C | Kopiera för publicering |
| ⇧⌘O | Ctrl+Shift+O | Importera |
| ⌘F / ⌥⌘F | Ctrl+F / Ctrl+Alt+F | Sök / sök och ersätt |
| ⌘G, F3 | Ctrl+G, F3 | Nästa träff (med Shift: föregående) |
| ⌥⌘M | Ctrl+Alt+M | Egen anteckning |
| ⌥⌘K | Ctrl+Alt+K | Kommentera markerad text |
| ⌥⌘N | Ctrl+Alt+N | Infoga fotnot |
| ⌘. | Ctrl+. | Infoga tecken |
| ⌘J | Ctrl+J | AI-assistent |
| ⌘, | Ctrl+, | Inställningar |
| ⌃⌘F | F11 | Helskärm |
| F1 | F1 | Alla kortkommandon |
| Esc | Esc | Stäng paneler |
| ⌘Q | Ctrl+Q | Avsluta (texten sparas först) |

## Om Word Work

Word Work är skrivet av Mikke Schirén med hjälp av olika AI-verktyg. Det har
licensen **Apache License 2.0** – se [LICENSE](LICENSE) och [NOTICE](NOTICE).

Word Work använder komponenter från andra, med egna licenser:

- **Pandoc** (GPL 2.0 eller senare) för import och export. Det följer med som
  ett eget program.
- **Stavningsordlistan** "Den stora svenska ordlistan" av Göran Andersson
  (LGPL 3.0).
- **Synonymerna** från Synlex – Folkets synonymlexikon, Viggo Kann, KTH.
- **Typsnitten** Literata, Source Sans 3 och IBM Plex Mono (SIL Open Font
  License 1.1).

Fullständig förteckning: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
och [LICENSES/](LICENSES/).

Vill du bygga Word Work själv eller bidra? Se
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
