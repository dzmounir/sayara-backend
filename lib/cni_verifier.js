import { similarity } from './levenshtein.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Tu es un assistant de vérification de pièce d'identité.
Analyse cette image et réponds UNIQUEMENT en JSON :
{
  "type_document": "CNI" | "PASSEPORT" | "AUTRE" | "ILLISIBLE",
  "nom_detecte": null,
  "prenom_detecte": null,
  "date_expiration": null,
  "est_expire": false,
  "qualite_photo": "BONNE" | "FLOUE" | "TROP_SOMBRE" | "PARTIELLE",
  "face": "RECTO" | "VERSO" | "INDETERMINE"
}
Réponds uniquement avec le JSON, aucun autre texte.`;

// imageBuffer: Buffer  |  imageBase64: string (already base64)
// nomAttendu: string — nom du client dans le dossier (pour vérification)
// side: 'recto' | 'verso'
export async function verifyCNI(imageBuffer, nomAttendu, side = 'recto') {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const base64 = Buffer.isBuffer(imageBuffer)
    ? imageBuffer.toString('base64')
    : imageBuffer;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 256,
      system:     SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{
          type:   'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
        }],
      }],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() ?? '';
  const raw  = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valide: false, cas: 'ILLISIBLE', erreur: 'JSON_PARSE_ERROR', raw };
  }

  const { type_document, nom_detecte, prenom_detecte, date_expiration, est_expire, qualite_photo, face } = parsed;

  if (qualite_photo !== 'BONNE') {
    return { valide: false, cas: 'QUALITE_MAUVAISE', erreur: null, qualite_photo, ...parsed };
  }

  if (type_document === 'ILLISIBLE') {
    return { valide: false, cas: 'ILLISIBLE', erreur: null, ...parsed };
  }

  if (type_document !== 'CNI' && type_document !== 'PASSEPORT') {
    return { valide: false, cas: 'MAUVAIS_DOCUMENT', erreur: null, ...parsed };
  }

  if (side === 'recto' && face === 'VERSO') {
    return { valide: false, cas: 'MAUVAISE_FACE', erreur: null, face, ...parsed };
  }
  if (side === 'verso' && face === 'RECTO') {
    return { valide: false, cas: 'MAUVAISE_FACE', erreur: null, face, ...parsed };
  }

  if (est_expire) {
    return { valide: false, cas: 'EXPIRE', erreur: null, ...parsed };
  }

  // Name similarity (only on recto, only if both provided)
  if (side === 'recto' && nomAttendu && nom_detecte) {
    const sim = similarity(nomAttendu, nom_detecte);
    if (sim < 0.7) {
      return { valide: false, cas: 'NOM_MISMATCH', erreur: null, similarity: sim, ...parsed };
    }
  }

  return {
    valide:     true,
    cas:        'OK',
    erreur:     null,
    nom:        nom_detecte,
    prenom:     prenom_detecte,
    expiration: date_expiration,
    ...parsed,
  };
}
