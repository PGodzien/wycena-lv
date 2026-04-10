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

  // Limit each document and total to avoid timeout
  const MAX_PER_DOC = 12000;
  const MAX_TOTAL = 40000;
  
  let combinedText = '';
  for (const doc of pdfTexts) {
    const docText = doc.text.substring(0, MAX_PER_DOC);
    const toAdd = `\n=== ${doc.filename} (${doc.pages} stron) ===\n${docText}`;
    if (combinedText.length + toAdd.length > MAX_TOTAL) {
      combinedText += `\n=== ${doc.filename} === [SKRÓCONO - limit tekstu]\n`;
      break;
    }
    combinedText += toAdd;
  }
  
  if (combinedText.length < 50) {
    return res.status(400).json({ error: 'Za mało tekstu w dokumentach PDF do analizy. Czy PDF zawiera tekst (nie skany/obrazy)?' });
  }

  const systemPrompt = `Jesteś ekspertem od wycen montażu okien i drzwi aluminiowych w Niemczech.
Odpowiadasz WYŁĄCZNIE poprawnym JSON - bez markdown, bez komentarzy, bez tekstu przed/po.
Wyciągasz WSZYSTKIE elementy montażowe - każde okno, drzwi, HST, fasadę, raffstore osobno.
Nie pomijaj żadnych pozycji. Lepiej więcej niż mniej.`;

  const userPrompt = `Przeanalizuj dokumentację techniczną i wyciągnij WSZYSTKIE elementy do montażu.

DOKUMENTACJA:
${combinedText}

ZADANIE: Znajdź KAŻDY element montażowy:
- Każde okno (Fenster) - osobna pozycja
- Każde drzwi (Tür, Haustür) - osobna pozycja  
- Każdy HST (Hebe-Schiebetür) - osobna pozycja
- Każdy element fasady (Fassade, Pfosten-Riegel) - osobna pozycja
- Każdy raffstore/żaluzja - osobna pozycja
- Każdy element stały (Festelement) - osobna pozycja

Zwróć JSON:
{"projectName":"nazwa projektu","positions":[{"posId":"1.1","description":"Dreh-Kipp-Fenster 2-flg","type":"dk","breite":1800,"hoehe":1400,"menge":1,"m2":2.52,"notes":"AWS 75, RAL 7016"}],"summary":"podsumowanie"}

TYPY: hst_tip (HST elektryczny), hst_man (HST manualny), haustuer, dk (dreh-kipp), fest (festelement), stulp, brand (T30), raff (raffstore), pfosten (fasada), other

WAŻNE:
- Wyciągnij WSZYSTKIE pozycje, nie tylko 30
- Jeśli są wymiary - podaj breite/hoehe w mm
- Jeśli są ilości - podaj menge
- Oblicz m2 = breite * hoehe / 1000000
- Poprawny JSON bez trailing commas`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    let text = message.content[0].text.trim();
    
    // Remove markdown code fences if present
    text = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    
    // Try to find JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(502).json({ 
        error: 'Nie znaleziono JSON w odpowiedzi', 
        raw: text.substring(0, 300) 
      });
    }

    // Aggressive JSON cleanup
    let jsonStr = jsonMatch[0];
    
    // Fix common LLM JSON errors
    jsonStr = jsonStr
      // Remove trailing commas
      .replace(/,(\s*[}\]])/g, '$1')
      // Remove control characters
      .replace(/[\x00-\x1F\x7F]/g, ' ')
      // Fix multiple spaces
      .replace(/\s+/g, ' ');
    
    // Try parsing
    try {
      const parsed = JSON.parse(jsonStr);
      
      // Validate structure
      if (!parsed.positions) parsed.positions = [];
      if (!Array.isArray(parsed.positions)) parsed.positions = [];
      
      return res.json({
        projectName: parsed.projectName || '',
        positions: parsed.positions.slice(0, 30), // limit
        summary: parsed.summary || `Znaleziono ${parsed.positions.length} pozycji`,
        perplexityQueries: parsed.perplexityQueries || []
      });
      
    } catch (parseErr) {
      // Last resort: try to extract positions manually with simpler regex
      const positions = [];
      
      // Find all position-like objects
      const objMatches = jsonStr.matchAll(/"posId"\s*:\s*"([^"]+)"/g);
      for (const m of objMatches) {
        if (positions.length >= 30) break;
        
        // Find the surrounding object
        const startIdx = jsonStr.lastIndexOf('{', m.index);
        const endIdx = jsonStr.indexOf('}', m.index);
        if (startIdx === -1 || endIdx === -1) continue;
        
        const objStr = jsonStr.substring(startIdx, endIdx + 1);
        
        // Extract fields with regex
        const descMatch = objStr.match(/"description"\s*:\s*"([^"]+)"/);
        const typeMatch = objStr.match(/"type"\s*:\s*"([^"]+)"/);
        const breiteMatch = objStr.match(/"breite"\s*:\s*(\d+)/);
        const hoeheMatch = objStr.match(/"hoehe"\s*:\s*(\d+)/);
        const mengeMatch = objStr.match(/"menge"\s*:\s*(\d+)/);
        const m2Match = objStr.match(/"m2"\s*:\s*([\d.]+)/);
        
        positions.push({
          posId: m[1],
          description: descMatch ? descMatch[1] : 'Element',
          type: typeMatch ? typeMatch[1] : 'other',
          breite: breiteMatch ? parseInt(breiteMatch[1]) : 1500,
          hoehe: hoeheMatch ? parseInt(hoeheMatch[1]) : 1200,
          menge: mengeMatch ? parseInt(mengeMatch[1]) : 1,
          m2: m2Match ? parseFloat(m2Match[1]) : 1.8,
          notes: ''
        });
      }
      
      if (positions.length > 0) {
        return res.json({
          projectName: '',
          positions,
          summary: `Częściowo sparsowano: ${positions.length} pozycji (metoda awaryjna)`
        });
      }
      
      return res.status(502).json({ 
        error: 'Nie udało się sparsować JSON. Spróbuj z mniejszą liczbą dokumentów.',
        detail: parseErr.message
      });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
