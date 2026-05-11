import { sendButtons } from './whatsapp.js';

const AIRTABLE_BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY  = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

async function airtableGet(table, params = {}) {
  const url = new URL(`${AIRTABLE_BASE_URL}/${encodeURIComponent(table)}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  console.log(`[pricing] GET ${table} filter=${params.filterByFormula ?? '(none)'}`);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[pricing] Airtable ${res.status} on ${table}:`, body);
    throw new Error(`Airtable GET ${table} failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  console.log(`[pricing] GET ${table} → ${data.records?.length ?? 0} records`);
  return data;
}

async function airtablePatch(table, recordId, fields) {
  const res = await fetch(`${AIRTABLE_BASE_URL}/${encodeURIComponent(table)}/${recordId}`, {
    method:  'PATCH',
    headers: {
      Authorization:  `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Airtable PATCH ${table} failed: ${res.status}`);
  return res.json();
}

// ─── Load global variables once per call ────────────────────────────────────
async function getVariables() {
  const data = await airtableGet('VARIABLES_GLOBALES');
  const vars = {};
  for (const rec of data.records) {
    vars[rec.fields.cle] = rec.fields.valeur;
  }
  return {
    taux_conversion:      Number(vars.taux_conversion      ?? 252),
    taux_commission_pct:  Number(vars.taux_commission_pct  ?? 13),
    commission_minimum_da:Number(vars.commission_minimum_da?? 500000),
    taux_douane_pct:      Number(vars.taux_douane_pct      ?? 12),
    cout_degroupage_da:   Number(vars.cout_degroupage_da   ?? 150000),
    cout_transitaire_da:  Number(vars.cout_transitaire_da  ?? 60000),
    frais_notaire_defaut_da: Number(vars.frais_notaire_defaut_da ?? 40000),
  };
}

const TBL_PRIX = process.env.AIRTABLE_PRIX_SOURCEURS_TABLE || 'tblkosDM1HA6SbW0V';

function buildPrixFilter(c) {
  const parts = ['{stock_disponible}>0'];
  if (c.marque)  parts.push(`{marque}="${c.marque}"`);
  if (c.modele)  parts.push(`{modele}="${c.modele}"`);
  if (c.annee)   parts.push(`{annee}=${c.annee}`);
  if (c.finition && c.finition !== 'Peu importe') parts.push(`{finition}="${c.finition}"`);
  if (c.boite    && c.boite    !== 'Peu importe') parts.push(`{boite_vitesse}="${c.boite}"`);
  if (c.couleur  && c.couleur  !== 'Peu importe') parts.push(`{couleur}="${c.couleur}"`);
  return `AND(${parts.join(',')})`;
}

export async function getFinitionsDisponibles(marque, modele, annee) {
  const data = await airtableGet(TBL_PRIX, {
    filterByFormula: buildPrixFilter({ marque, modele, annee }),
    maxRecords: '50',
  });
  const finitions = [...new Set((data.records || []).map(r => r.fields.finition).filter(Boolean))];
  return { available: (data.records || []).length > 0, finitions };
}

export async function getBoitesDisponibles(marque, modele, annee, finition) {
  const data = await airtableGet(TBL_PRIX, {
    filterByFormula: buildPrixFilter({ marque, modele, annee, finition }),
    maxRecords: '50',
  });
  const boites = [...new Set((data.records || []).map(r => r.fields.boite_vitesse).filter(Boolean))];
  return { boites };
}

export async function getCouleurDisponibles(marque, modele, annee, finition, boite) {
  const data = await airtableGet(TBL_PRIX, {
    filterByFormula: buildPrixFilter({ marque, modele, annee, finition, boite }),
    maxRecords: '50',
  });
  const couleurs = [...new Set((data.records || []).map(r => r.fields.couleur).filter(Boolean))];
  return { couleurs };
}

// ─── selectBestSourceur ──────────────────────────────────────────────────────
// Applies the 4% rule: if 2nd cheapest is within 4% of cheapest → prefer 2nd.
// Returns: { status: 'OK'|'NO_STOCK', sourceur?, base?, ecart?, couleurs_dispo? }
export async function selectBestSourceur(modele, finition, boite, couleur, marque = null, annee = null) {
  const filterFormula = buildPrixFilter({ marque, modele, annee, finition, boite, couleur });

  const sortedUrl = new URL(`${AIRTABLE_BASE_URL}/${encodeURIComponent(TBL_PRIX)}`);
  sortedUrl.searchParams.set('filterByFormula', filterFormula);
  sortedUrl.searchParams.set('sort[0][field]', 'prix_vehicule_usd');
  sortedUrl.searchParams.set('sort[0][direction]', 'asc');
  ['sourceur_id', 'prix_vehicule_usd', 'cif_shipping_sourceur_usd', 'couleur', 'stock_disponible', 'date_mise_a_jour'].forEach(f => sortedUrl.searchParams.append('fields[]', f));
  const sortRes = await fetch(sortedUrl.toString(), { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
  if (!sortRes.ok) throw new Error(`Airtable GET ${TBL_PRIX} failed: ${sortRes.status}`);
  const data = await sortRes.json();

  const results = data.records.map(r => ({ ...r.fields, _id: r.id }));

  if (results.length === 0) {
    // Return available colours for same model/finition/boite
    const allData = await airtableGet(TBL_PRIX, {
      filterByFormula: buildPrixFilter({ marque, modele, annee, finition, boite }),
    });
    const couleurs_dispo = [...new Set(allData.records.map(r => r.fields.couleur))];
    return { status: 'NO_STOCK', couleurs_dispo };
  }

  if (results.length === 1) {
    const s = enrich(results[0]);
    return { status: 'OK', sourceur: s, base: 'SEUL' };
  }

  const r0 = enrich(results[0]);
  const r1 = enrich(results[1]);
  const ecart = (r1.prix_vehicule_usd - r0.prix_vehicule_usd) / r0.prix_vehicule_usd;

  // Within 4% → prefer 2nd (spreads risk, avoids single-point dependency)
  if (ecart <= 0.04) {
    return { status: 'OK', sourceur: r1, base: '2EME', ecart };
  }
  return { status: 'OK', sourceur: r0, base: '1ER', ecart };
}

function enrich(sourceur) {
  return {
    ...sourceur,
    cif_final: sourceur.cif_shipping_sourceur_usd ?? sourceur.cif_shipping_calcule_usd ?? 0,
  };
}

// ─── calculateDevis ──────────────────────────────────────────────────────────
export async function calculateDevis(sourceur, modele, commune) {
  const vars = await getVariables();

  // Notaire lookup
  const notaireData = await airtableGet('NOTAIRES_PAR_COMMUNE', {
    filterByFormula: `AND({commune}="${commune}",{actif}=TRUE())`,
    maxRecords: 1,
  });

  let frais_notaire = vars.frais_notaire_defaut_da;
  let notaire_info  = null;

  if (notaireData.records.length > 0) {
    const nf = notaireData.records[0].fields;
    frais_notaire = nf.frais_notaire_da ?? vars.frais_notaire_defaut_da;
    notaire_info  = nf;
  }

  const {
    taux_conversion, taux_commission_pct, commission_minimum_da,
    taux_douane_pct, cout_degroupage_da, cout_transitaire_da,
  } = vars;

  const sous_total     = (sourceur.prix_vehicule_usd + sourceur.cif_final) * taux_conversion;
  const commission_da  = Math.max(sous_total * taux_commission_pct / 100, commission_minimum_da);

  const prix_vehicule_affiche  = roundTo(sous_total + commission_da, -3);
  const droits_douane          = roundTo(prix_vehicule_affiche * taux_douane_pct / 100, -2);
  const total_livre_au_port    = prix_vehicule_affiche + frais_notaire;
  const supplement_dedouane    = droits_douane + cout_degroupage_da + cout_transitaire_da;
  const total_dedouane         = total_livre_au_port + supplement_dedouane;

  return {
    // Hidden fields (stored in Airtable only)
    prix_vehicule_usd:  sourceur.prix_vehicule_usd,
    cif_usd:            sourceur.cif_final,
    sous_total,
    commission_da,
    sourceur_id_utilise: sourceur.sourceur_id,
    cif_inclus_dans_prix: true,

    // Visible in quote
    prix_vehicule_affiche,
    note_prix: 'inclut admin KSA + transport + assurance',
    frais_notaire,
    total_livre_au_port,
    droits_douane,
    note_douane: 'APPROXIMATIFS',
    cout_degroupage_da,
    cout_transitaire_da,
    supplement_dedouane,
    total_dedouane,

    notaire_info,
  };
}

// ─── confirmAvailability ─────────────────────────────────────────────────────
// Sends a WhatsApp confirmation to the sourceur and waits for reply via webhook.
// Fallback handled by Make.com timeout + selectFallbackSourceurs.
export async function confirmAvailability(sourceur_id, reference_dossier) {
  const data = await airtableGet('SOURCEURS', {
    filterByFormula: `{sourceur_id}="${sourceur_id}"`,
    maxRecords: 1,
  });

  if (!data.records.length) throw new Error(`Sourceur not found: ${sourceur_id}`);

  const { telephone, nom } = data.records[0].fields;

  await sendButtons(
    telephone,
    `📦 Dossier *${reference_dossier}* — Confirmez-vous la disponibilité du véhicule ?\n\nVotre réponse est attendue dans les 24h.`,
    [
      { id: `DISPO_OUI_${reference_dossier}`, title: '✅ Disponible' },
      { id: `DISPO_NON_${reference_dossier}`, title: '❌ Indisponible' },
    ]
  );

  return { sent_to: telephone, sourceur_id, reference_dossier };
}

// ─── selectFallbackSourceurs ─────────────────────────────────────────────────
// Called when primary sourceur is unavailable. Returns all alternatives.
export async function selectFallbackSourceurs(modele, finition, boite, budget_usd, exclude_sourceur_id) {
  const data = await airtableGet('PRIX_SOURCEURS', {
    filterByFormula: `AND(
      {modele}="${modele}",
      {finition}="${finition}",
      {boite_vitesse}="${boite}",
      {stock_disponible}>0,
      {actif}=TRUE(),
      {sourceur_id}!="${exclude_sourceur_id}"
    )`,
    sort: JSON.stringify([{ field: 'prix_vehicule_usd', direction: 'asc' }]),
  });

  return data.records.map(r => ({
    ...r.fields,
    cif_final: r.fields.cif_shipping_sourceur_usd ?? r.fields.cif_shipping_calcule_usd ?? 0,
  }));
}

// ─── Utility ─────────────────────────────────────────────────────────────────
// roundTo(1234567, -3) → 1235000  (nearest thousand)
// roundTo(1234567, -2) → 1234600  (nearest hundred)
function roundTo(value, exp) {
  const factor = Math.pow(10, -exp);
  return Math.round(value / factor) * factor;
}
