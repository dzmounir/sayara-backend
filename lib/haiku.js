const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

async function call(system, userText, maxTokens = 512) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userText }],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Haiku ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw = data.content?.[0]?.text?.trim() ?? '';
  // Strip code fences first
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // If there's text before the JSON object, extract just the JSON
  if (!stripped.startsWith('{')) {
    const start = stripped.indexOf('{');
    const end   = stripped.lastIndexOf('}');
    if (start !== -1 && end > start) return stripped.slice(start, end + 1);
  }
  return stripped;
}

export async function qualifyVehicle(text) {
  const system = `Tu es un assistant de qualification automobile pour DjazairAuto (importation en Algérie).
Analyse le message client et extrais en JSON strict :
{
  "marque": string | null,
  "modele": string | null,
  "annee": number | null,
  "boite": "Automatique" | "Manuelle" | null,
  "finition": string | null,
  "couleur": string | null,
  "confiance": "HAUTE" | "MOYENNE" | "BASSE"
}
Règles :
- marque ET modele présents et reconnaissables → confiance HAUTE ou MOYENNE
- un seul champ ou ambiguïté → BASSE
- normalise les raccourcis : duster→Dacia Duster, sportage→Kia Sportage, corolla→Toyota Corolla, etc.
Réponds UNIQUEMENT en JSON valide. Zéro texte autour.`;

  try {
    return JSON.parse(await call(system, text, 256));
  } catch {
    return { marque: null, modele: null, annee: null, boite: null, finition: null, couleur: null, confiance: 'BASSE' };
  }
}

export async function verifySourceurDoc(imageBuffer, docLabel, docIndex) {
  if (!ANTHROPIC_API_KEY) return { valide: true };

  const base64 = imageBuffer.toString('base64');
  const system = `Tu es un vérificateur de documents pour DjazairAuto, importateur automobile.
Analyse l'image et vérifie qu'il s'agit bien de : "${docLabel}".
Réponds en JSON strict :
{
  "valide": boolean,
  "raison": string | null,
  "vin": string | null,
  "qualite": "BONNE" | "MOYENNE" | "MAUVAISE"
}
- valide: false si le document est illisible, de mauvaise qualité, ou ne correspond pas au type demandé
- raison: explication courte si invalide, sinon null
- vin: le numéro VIN si visible sur la photo (17 caractères alphanumériques), sinon null
- qualite: qualité visuelle globale
Réponds UNIQUEMENT en JSON valide.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        system,
        messages: [{
          role: 'user',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
          }],
        }],
      }),
    });
    if (!res.ok) return { valide: true };
    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() ?? '';
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(clean);
  } catch {
    return { valide: true };
  }
}

export async function normalizeCommune(text) {
  const system = `Tu es un assistant géographique pour l'Algérie.
Normalise le nom de commune et détermine sa zone. Réponds en JSON strict :
{
  "commune_normalisee": string,
  "wilaya": string,
  "zone": "EST_CENTRE" | "OUEST" | "INCONNUE"
}
Zone EST_CENTRE : Alger, Blida, Boumerdes, Tizi-Ouzou, Béjaïa, Sétif, Constantine, Annaba et wilayas à l'est.
Zone OUEST : Oran, Tlemcen, Sidi Bel Abbès, Relizane, Mostaganem, Mascara, Tiaret, Chlef et wilayas à l'ouest.
Réponds UNIQUEMENT en JSON valide.`;

  try {
    return JSON.parse(await call(system, text, 128));
  } catch {
    return { commune_normalisee: text, wilaya: '', zone: 'INCONNUE' };
  }
}
