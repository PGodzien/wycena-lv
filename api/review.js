/**
 * /api/review
 * Inteligentna analiza wyceny przez Claude.
 * Sprawdza realność cen, wskazuje ryzyka, rekomenduje korekty.
 */
const Anthropic = require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const { positions, totals, projectInfo, marketRates, pdfDocuments } = req.body;
  if (!positions || !Array.isArray(positions)) {
    return res.status(400).json({ error: 'Missing positions array' });
  }

  // Build positions list for prompt
  const posLines = positions
    .filter(p => p.value > 0)
    .map(p => {
      const diff = p.marketPrice > 0
        ? ((p.price - p.marketPrice) / p.marketPrice * 100).toFixed(0)
        : null;
      const diffStr = diff !== null ? ` [${diff > 0 ? '+' : ''}${diff}% vs rynek]` : '';
      return `  • ${p.posId}: ${p.desc} | ${p.type} | ${p.m2.toFixed(2)} m² × ${p.price} EUR/m² = ${Math.round(p.value).toLocaleString('pl-PL')} EUR${diffStr}`;
    })
    .join('\n');

  const ratesContext = marketRates
    ? Object.entries(marketRates)
        .map(([k, v]) => `  ${k}: ${v.min}–${v.max} EUR/m² (śr. ${v.avg})`)
        .join('\n')
    : 'Brak danych rynkowych';

  // Build PDF context if available
  let pdfContext = '';
  if (pdfDocuments && Array.isArray(pdfDocuments) && pdfDocuments.length > 0) {
    const pdfSummaries = pdfDocuments
      .filter(doc => doc.text && doc.text.length > 50)
      .map(doc => `\n--- ${doc.filename} (${doc.pages} stron) ---\n${doc.text}`)
      .join('\n');
    if (pdfSummaries) {
      pdfContext = `\n\nDOKUMENTACJA TECHNICZNA (wyciąg z PDF):\n${pdfSummaries}`;
    }
  }

  const prompt = `Jesteś doświadczonym kosztorysantem w branży aluminiowej (okna, drzwi, fasady) w Niemczech. Masz 15+ lat doświadczenia w wycenach montażu Schüco, Reynaers, Wicona dla rynku NRW i całych Niemiec.

Projekt: ${projectInfo || 'Projekt montażowy'}

POZYCJE WYCENY:
${posLines}

SUMA: ${Number(totals.netto).toLocaleString('pl-PL', {minimumFractionDigits: 2})} EUR netto / ${Number(totals.brutto).toLocaleString('pl-PL', {minimumFractionDigits: 2})} EUR brutto

AKTUALNE STAWKI RYNKOWE (Perplexity, ${new Date().toLocaleDateString('pl-PL')}):
${ratesContext}${pdfContext}

Przeprowadź analizę wyceny. Odpowiedz po polsku, konkretnie.

Format odpowiedzi (użyj dokładnie tych nagłówków):

## Ocena ogólna
[1-2 zdania: czy wycena jest realistyczna i konkurencyjna]

## Pozycje wymagające uwagi
[dla każdej pozycji gdzie cena odbiega od rynku o >15% lub jest ryzykowna — napisz co i dlaczego, sugeruj korektę]

## Ryzyka projektu
[techniczne lub cenowe ryzyka: duże elementy HST, Tiptronic, specjalne wymagania, RC2, brandschutz itp.${pdfDocuments && pdfDocuments.length > 0 ? ' — uwzględnij informacje z dokumentacji PDF' : ''}]

## Rekomendacja
[konkretna: zatwierdź / podnieś X do Y EUR/m² / sprawdź Z — z uzasadnieniem]`;

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });

    return res.json({ review: message.content[0].text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
