/**
 * /api/rates
 * Pobiera aktualne stawki montażowe z Perplexity AI.
 * Klucz API bezpiecznie po stronie serwera.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).end();

  const PPLX_KEY = process.env.PERPLEXITY_API_KEY;
  if (!PPLX_KEY) {
    return res.status(500).json({ error: 'PERPLEXITY_API_KEY not configured on server' });
  }

  const prompt = `Podaj aktualne stawki za montaż (tylko robocizna, bez materiału) konstrukcji aluminiowych w Niemczech, region NRW, rok 2025.

Odpowiedz TYLKO jako czysty JSON (bez markdown, bez komentarzy):
{
  "hst_tip":  {"min": 80, "max": 110},
  "hst_man":  {"min": 55, "max": 80},
  "haustuer": {"min": 65, "max": 95},
  "dk":       {"min": 40, "max": 65},
  "fest":     {"min": 28, "max": 48},
  "stulp":    {"min": 45, "max": 70},
  "brand":    {"min": 95, "max": 140},
  "raff":     {"min": 25, "max": 42}
}

Definicje typów:
- hst_tip: Hebe-Schiebetür motorisch / Tiptronic (Aluminium, np. Schüco ASE 80)
- hst_man: Hebe-Schiebetür manuell (Aluminium)
- haustuer: Haustür / Eingangstür Aluminium RC2 (np. Schüco AWS 75)
- dk: Dreh-Kipp-Fenster Aluminium (np. Schüco AWS 75)
- fest: Festelement / Festverglassung Aluminium
- stulp: Stulpfenster 2-flügelig Aluminium
- brand: Brandschutztür T30 / F30 Aluminium (np. Schüco ADS 80)
- raff: Raffstore / Sonnenschutz / Warema E80

Bazuj na aktualnych danych: Handwerkerportale, Ausschreibungen, BKI Baukosten 2025.`;

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PPLX_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'system',
            content: 'Odpowiadasz TYLKO jako JSON. Żadnych komentarzy, żadnego Markdown.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 300,
        search_recency_filter: 'month',
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: `Perplexity error: ${response.status}`, detail: err });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '{}';

    // Strip markdown code fences if present
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ error: 'Could not parse Perplexity response', raw: text });

    const raw = JSON.parse(jsonMatch[0]);

    // Build result with avg midpoints
    const rates = {};
    for (const [key, val] of Object.entries(raw)) {
      const min = Number(val.min) || 0;
      const max = Number(val.max) || 0;
      if (min > 0 && max > 0) {
        rates[key] = { min, max, avg: Math.round((min + max) / 2) };
      }
    }

    return res.json({
      rates,
      source: 'perplexity-live',
      model: 'sonar-pro',
      date: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
