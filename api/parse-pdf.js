/**
 * /api/parse-pdf
 * Analizuje tekst z PDF i wyciąga pozycje montażowe do wyceny.
 * Claude rozpoznaje elementy, wymiary, typy i tworzy strukturę.
 */
const Anthropic = require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const { pdfTexts } = req.body;
  if (!pdfTexts || !Array.isArray(pdfTexts) || pdfTexts.length === 0) {
    return res.status(400).json({ error: 'Brak tekstu PDF do analizy' });
  }

  const combinedText = pdfTexts
    .map(doc => `\n=== ${doc.filename} (${doc.pages} stron) ===\n${doc.text}`)
    .join('\n\n');

  const prompt = `Analizujesz dokumentację techniczną (plany, rzuty, specyfikacje) projektu budowlanego z oknami i drzwiami aluminiowymi.

DOKUMENTACJA:
${combinedText}

ZADANIE:
Wyciągnij WSZYSTKIE elementy do montażu (okna, drzwi, HST, fasady, raffstore, itp.) i podaj je jako JSON.

Dla każdego elementu określ:
- posId: numer pozycji (1.1, 1.2, 2.1 itd. lub z dokumentu)
- description: opis elementu po niemiecku (jak w LV)
- type: jeden z: hst_tip, hst_man, haustuer, dk, fest, stulp, brand, raff, other
- breite: szerokość w mm (jeśli znana)
- hoehe: wysokość w mm (jeśli znana)  
- menge: ilość sztuk
- m2: powierzchnia w m² na sztukę (oblicz z wymiarów jeśli podane, lub oszacuj)
- notes: dodatkowe uwagi (RC2, Tiptronic, kolor RAL, szklenie itp.)

TYPY:
- hst_tip = Hebe-Schiebetür motorisch/Tiptronic
- hst_man = Hebe-Schiebetür manuell
- haustuer = Haustür, Eingangstür
- dk = Dreh-Kipp-Fenster
- fest = Festelement, Festverglassung
- stulp = Stulpfenster
- brand = Brandschutztür T30/F30
- raff = Raffstore, Sonnenschutz
- other = inne elementy

Odpowiedz TYLKO jako czysty JSON (bez markdown):
{
  "projectName": "nazwa projektu jeśli znana",
  "positions": [
    {
      "posId": "1.1",
      "description": "Dreh-Kipp-Fenster 2-flügelig AWS 75",
      "type": "dk",
      "breite": 1800,
      "hoehe": 1400,
      "menge": 4,
      "m2": 2.52,
      "notes": "3-fach Verglasung, RAL 7016"
    }
  ],
  "summary": "krótkie podsumowanie projektu",
  "perplexityQueries": [
    "konkretne zapytania do Perplexity o stawki dla specyficznych elementów z tego projektu"
  ]
}

Jeśli nie możesz wyciągnąć konkretnych wymiarów, oszacuj typowe dla danego typu elementu.
Jeśli dokument jest nieczytelny lub nie zawiera elementów montażowych, zwróć pustą listę positions z wyjaśnieniem w summary.`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text;
    
    // Try to parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(502).json({ error: 'Nie udało się sparsować odpowiedzi Claude', raw: text });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return res.json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
