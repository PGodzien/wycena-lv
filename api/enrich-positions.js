/**
 * /api/enrich-positions
 * Claude łączy pozycje z Excel LV ze szczegółami z rysunków PDF.
 * Wzbogaca pozycje o: typ elementu, szczegóły (Tiptronic, RC2), wymiary.
 */
const Anthropic = require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const { positions, pdfTexts } = req.body;
  
  if (!positions || !Array.isArray(positions) || positions.length === 0) {
    return res.status(400).json({ error: 'Brak pozycji do wzbogacenia' });
  }
  
  if (!pdfTexts || !Array.isArray(pdfTexts) || pdfTexts.length === 0) {
    return res.status(400).json({ error: 'Brak tekstu z rysunków PDF' });
  }

  // Combine PDF texts (limit to avoid timeout)
  let combinedPdf = '';
  for (const doc of pdfTexts) {
    const toAdd = `\n=== ${doc.filename} ===\n${doc.text.substring(0, 6000)}`;
    if (combinedPdf.length + toAdd.length > 20000) break;
    combinedPdf += toAdd;
  }

  // Format positions for prompt
  const positionsText = positions.map(p => 
    `- ${p.posId}: ${p.description} (typ: ${p.type}, ${p.totalM2} m²)`
  ).join('\n');

  const systemPrompt = `Jesteś ekspertem od montażu okien i drzwi aluminiowych Schüco.
Analizujesz rysunki techniczne i łączysz je z pozycjami z Leistungsverzeichnis.
Odpowiadasz WYŁĄCZNIE poprawnym JSON - bez markdown, bez komentarzy.`;

  const userPrompt = `POZYCJE Z EXCEL LV:
${positionsText}

TEKST Z RYSUNKÓW TECHNICZNYCH:
${combinedPdf}

ZADANIE:
Dla każdej pozycji z LV znajdź odpowiadające szczegóły z rysunków i określ:
1. type - właściwy typ: hst_tip, hst_man, haustuer, dk, fest, stulp, brand, raff, pfosten, other
2. notes - ważne szczegóły: Tiptronic, RC2, szklenie, RAL, system Schüco
3. m2 - jeśli możesz oszacować powierzchnię z rysunków

TYPY:
- hst_tip = HST elektryczny/Tiptronic (ASE 80 z napędem)
- hst_man = HST manualny (ASE 80 bez napędu)
- dk = Dreh-Kipp (AWS 75)
- fest = Festelement/Festfeld/Festflügel
- stulp = Stulpfenster
- brand = Brandschutz T30/F30 (ADS 80)
- raff = Raffstore (E80)
- haustuer = Haustür
- pfosten = Pfosten-Riegel (FW 50)

Zwróć JSON:
{"positions":[{"posId":"F07","type":"hst_tip","notes":"ASE 80 HI Tiptronic, RC2, 3-fach","m2":null}],"summary":"podsumowanie analizy"}`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    let text = message.content[0].text.trim();
    text = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.json({ positions: [], summary: 'Nie udało się sparsować odpowiedzi' });
    }

    const jsonStr = jsonMatch[0].replace(/,(\s*[}\]])/g, '$1');
    
    try {
      const parsed = JSON.parse(jsonStr);
      return res.json({
        positions: parsed.positions || [],
        summary: parsed.summary || 'Analiza zakończona'
      });
    } catch (parseErr) {
      return res.json({ positions: [], summary: 'Błąd parsowania: ' + parseErr.message });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
