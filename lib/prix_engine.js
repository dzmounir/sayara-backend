// lib/prix_engine.js
// Price comparison engine: upsert PRIX_SOURCEURS, recalculate CATALOGUE_COMPARATIF, leaderboard.

const BASE_URL = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}`;
const AUTH     = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` });
const JSON_HDR = () => ({ ...AUTH(), 'Content-Type': 'application/json' });

const T = {
  PRIX_SOURCEURS:       process.env.AIRTABLE_PRIX_SOURCEURS_TABLE       || 'tblkosDM1HA6SbW0V',
  SOURCEURS:            process.env.AIRTABLE_SOURCEURS_TABLE             || 'tblGeoLTGnBKhlAsK',
  CATALOGUE_COMPARATIF: process.env.AIRTABLE_CATALOGUE_COMPARATIF_TABLE || 'tblUY9lQn8pKqo07k',
  IMPORT_HISTORY:       process.env.AIRTABLE_IMPORT_HISTORY_TABLE        || 'tbl4ERRs4fYNeycD5',
};

// ─── Airtable helpers ─────────────────────────────────────────────────────────

async function atGet(table, params = {}) {
  const url = new URL(`${BASE_URL}/${encodeURIComponent(table)}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
    else url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: AUTH() });
  if (!res.ok) throw new Error(`AT GET ${table} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function atFetchAll(table, params = {}) {
  let records = [], offset;
  do {
    const data = await atGet(table, offset ? { ...params, offset } : params);
    records = records.concat(data.records ?? []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function atPatch(table, id, fields) {
  const res = await fetch(`${BASE_URL}/${encodeURIComponent(table)}/${id}`, {
    method: 'PATCH',
    headers: JSON_HDR(),
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`AT PATCH ${table} ${res.status}`);
  return res.json();
}

async function atCreate(table, fields) {
  const res = await fetch(`${BASE_URL}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: JSON_HDR(),
    body: JSON.stringify({ records: [{ fields }] }),
  });
  if (!res.ok) throw new Error(`AT POST ${table} ${res.status}`);
  return (await res.json()).records[0];
}

async function atBatchPatch(table, updates) {
  for (let i = 0; i < updates.length; i += 10) {
    const records = updates.slice(i, i + 10);
    const res = await fetch(`${BASE_URL}/${encodeURIComponent(table)}`, {
      method: 'PATCH',
      headers: JSON_HDR(),
      body: JSON.stringify({ records }),
    });
    if (!res.ok) throw new Error(`AT batch PATCH ${table} ${res.status}: ${await res.text()}`);
  }
}

async function atBatchCreate(table, fieldsArr) {
  for (let i = 0; i < fieldsArr.length; i += 10) {
    const records = fieldsArr.slice(i, i + 10).map(fields => ({ fields }));
    const res = await fetch(`${BASE_URL}/${encodeURIComponent(table)}`, {
      method: 'POST',
      headers: JSON_HDR(),
      body: JSON.stringify({ records }),
    });
    if (!res.ok) throw new Error(`AT batch POST ${table} ${res.status}: ${await res.text()}`);
  }
}

function rowKey(row) {
  return [row.marque, row.modele, row.annee, row.finition ?? '', row.boite_vitesse ?? '', row.couleur ?? '']
    .map(v => String(v ?? '').toLowerCase().trim())
    .join('|');
}

// ─── MODULE 1: upsertPrixSourceur ─────────────────────────────────────────────
export async function upsertPrixSourceur(sourceurId, rows) {
  const now = new Date().toISOString();

  // Fetch all existing records for this sourceur in one request
  const existing = await atFetchAll(T.PRIX_SOURCEURS, {
    filterByFormula: `{sourceur_id}="${sourceurId}"`,
    'fields[]': ['marque', 'modele', 'annee', 'finition', 'boite_vitesse', 'couleur'],
  });

  const existingMap = new Map(
    existing.map(rec => [rowKey({ ...rec.fields }), rec.id])
  );

  const toCreate = [];
  const toUpdate = [];

  for (const row of rows) {
    const key = rowKey(row);
    const fields = {
      sourceur_id:               sourceurId,
      marque:                    row.marque,
      modele:                    row.modele,
      annee:                     row.annee,
      finition:                  row.finition,
      boite_vitesse:             row.boite_vitesse,
      couleur:                   row.couleur,
      kilometrage:               row.kilometrage,
      etat_vehicule:             row.etat_vehicule,
      pieces_modifiees:          row.pieces_modifiees ? (row.pieces_modifiees !== 'non' && row.pieces_modifiees !== 'no') : false,
      prix_vehicule_usd:         row.prix_vehicule_usd,
      cif_shipping_sourceur_usd: row.cif_a_calculer ? undefined : row.cif_shipping_sourceur_usd,
      stock_disponible:          row.stock,
      delai_expedition_jours:    row.delai_expedition_jours,
      actif:                     row.stock > 0,
      date_mise_a_jour:          now,
    };
    // Remove undefined keys
    Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

    const existingId = existingMap.get(key);
    if (existingId) {
      toUpdate.push({ id: existingId, fields });
    } else {
      toCreate.push(fields);
    }
  }

  if (toUpdate.length > 0) await atBatchPatch(T.PRIX_SOURCEURS, toUpdate);
  if (toCreate.length > 0) await atBatchCreate(T.PRIX_SOURCEURS, toCreate);

  await calculateCifManquant(sourceurId);
  await _updateSourceurStats(sourceurId);
}

// ─── MODULE 2: calculateCifManquant ──────────────────────────────────────────
export async function calculateCifManquant(sourceurId) {
  const srcData = await atGet(T.SOURCEURS, {
    filterByFormula: `{sourceur_id}="${sourceurId}"`,
    maxRecords: 1,
    'fields[]': ['pays'],
  });
  const pays = srcData.records?.[0]?.fields?.pays;
  if (!pays) return;

  const avgData = await atFetchAll(T.PRIX_SOURCEURS, {
    filterByFormula: `AND({pays_sourceur}="${pays}",{cif_shipping_sourceur_usd}!="",{actif}=1)`,
    'fields[]': ['cif_shipping_sourceur_usd'],
  });
  if (avgData.length === 0) return;

  const avgCif = Math.round(
    avgData.reduce((s, r) => s + (Number(r.fields.cif_shipping_sourceur_usd) || 0), 0) / avgData.length
  );

  const missing = await atFetchAll(T.PRIX_SOURCEURS, {
    filterByFormula: `AND({sourceur_id}="${sourceurId}",{cif_shipping_sourceur_usd}="")`,
    'fields[]': ['cif_shipping_calcule_usd'],
  });
  if (missing.length === 0) return;

  await atBatchPatch(T.PRIX_SOURCEURS,
    missing.map(r => ({ id: r.id, fields: { cif_shipping_calcule_usd: avgCif } }))
  );
}

// ─── MODULE 3: recalculateBestPrices ─────────────────────────────────────────
export async function recalculateBestPrices() {
  if (!T.CATALOGUE_COMPARATIF) {
    console.warn('[prix_engine] AIRTABLE_CATALOGUE_COMPARATIF_TABLE not set — skipping');
    return;
  }

  // Fetch all active prices with stock
  const allPrices = await atFetchAll(T.PRIX_SOURCEURS, {
    filterByFormula: `AND({actif}=1,{stock_disponible}>0)`,
    'fields[]': [
      'sourceur_id', 'marque', 'modele', 'annee', 'finition', 'boite_vitesse', 'couleur',
      'etat_vehicule', 'prix_vehicule_usd', 'cif_shipping_sourceur_usd', 'cif_shipping_calcule_usd', 'stock_disponible',
    ],
  });

  // Fetch existing comparatif records for upsert lookup
  const existingComparatif = await atFetchAll(T.CATALOGUE_COMPARATIF, {
    'fields[]': ['marque', 'modele', 'annee', 'finition', 'boite_vitesse', 'couleur'],
  });
  const comparatifMap = new Map(
    existingComparatif.map(rec => [rowKey({ ...rec.fields }), rec.id])
  );

  // Group by vehicle key
  const groups = new Map();
  for (const rec of allPrices) {
    const key = rowKey(rec.fields);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }

  const now = new Date().toISOString();
  const toCreate = [];
  const toUpdate = [];

  for (const [key, records] of groups) {
    const sorted = records
      .map(r => {
        const f = r.fields;
        return {
          ...f,
          total: (f.prix_vehicule_usd || 0) + (f.cif_shipping_sourceur_usd || f.cif_shipping_calcule_usd || 0),
        };
      })
      .sort((a, b) => a.total - b.total);

    const f0 = sorted[0];
    let sourceurDevisId = f0.sourceur_id;
    let prixDevis = f0.prix_vehicule_usd;
    let baseCalc = 'SEUL';
    let ecartPct = null;

    if (sorted.length >= 2) {
      const f1 = sorted[1];
      ecartPct = (f1.total - f0.total) / f0.total * 100;
      if (ecartPct <= 4) {
        // Within 4% → prefer 2nd (delivery security)
        sourceurDevisId = f1.sourceur_id;
        prixDevis = f1.prix_vehicule_usd;
        baseCalc = '2EME';
      } else {
        baseCalc = '1ER';
      }
    }

    const fields = {
      marque:                 f0.marque,
      modele:                 f0.modele,
      annee:                  f0.annee,
      finition:               f0.finition,
      boite_vitesse:          f0.boite_vitesse,
      couleur:                f0.couleur,
      etat_vehicule:          f0.etat_vehicule,
      prix_devis_usd:         prixDevis,
      sourceur_devis_id:      sourceurDevisId,
      sourceur_moins_cher_id: f0.sourceur_id,
      nb_sourceurs_stock:     sorted.length,
      ecart_pct:              ecartPct != null ? Math.round(ecartPct * 100) / 100 : null,
      base_calcul:            baseCalc,
      date_calcul:            now,
      actif:                  true,
    };

    const existingId = comparatifMap.get(key);
    if (existingId) {
      toUpdate.push({ id: existingId, fields });
    } else {
      toCreate.push(fields);
    }
  }

  if (toUpdate.length > 0) await atBatchPatch(T.CATALOGUE_COMPARATIF, toUpdate);
  if (toCreate.length > 0) await atBatchCreate(T.CATALOGUE_COMPARATIF, toCreate);

  console.log(`[prix_engine] recalculateBestPrices: ${groups.size} combinaisons, ${toUpdate.length} MAJ, ${toCreate.length} créées`);
}

// ─── MODULE 4: getSourceurLeaderboard ────────────────────────────────────────
export async function getSourceurLeaderboard() {
  const records = await atFetchAll(T.PRIX_SOURCEURS, {
    filterByFormula: `AND({actif}=1,{stock_disponible}>0)`,
    'fields[]': ['sourceur_id', 'prix_vehicule_usd', 'stock_disponible', 'date_mise_a_jour'],
  });

  const map = new Map();
  for (const rec of records) {
    const sid = rec.fields.sourceur_id;
    if (!sid) continue;
    if (!map.has(sid)) {
      map.set(sid, { sourceur_id: sid, total_stock: 0, nb_modeles: 0, prix_sum: 0, prix_min: Infinity, prix_max: 0, derniere_maj: null });
    }
    const e = map.get(sid);
    const s = Number(rec.fields.stock_disponible) || 0;
    const p = Number(rec.fields.prix_vehicule_usd) || 0;
    e.total_stock += s;
    e.nb_modeles++;
    e.prix_sum += p;
    if (p > 0 && p < e.prix_min) e.prix_min = p;
    if (p > e.prix_max) e.prix_max = p;
    const maj = rec.fields.date_mise_a_jour;
    if (!e.derniere_maj || maj > e.derniere_maj) e.derniere_maj = maj;
  }

  return [...map.values()]
    .map((e, i) => ({
      ...e,
      rang: i + 1,
      prix_moyen: e.nb_modeles > 0 ? Math.round(e.prix_sum / e.nb_modeles) : 0,
      prix_min: e.prix_min === Infinity ? 0 : e.prix_min,
    }))
    .sort((a, b) => b.total_stock - a.total_stock)
    .map((e, i) => ({ ...e, rang: i + 1 }));
}

// ─── logImport ────────────────────────────────────────────────────────────────
export async function logImport(sourceurId, methode, nbImportes, nbErreurs, rapportJson = null) {
  if (!T.IMPORT_HISTORY) return;
  try {
    await atCreate(T.IMPORT_HISTORY, {
      sourceur_id: sourceurId,
      date_import:  new Date().toISOString(),
      methode,
      nb_importes:  nbImportes,
      nb_erreurs:   nbErreurs,
      rapport_json: rapportJson ? JSON.stringify(rapportJson) : null,
    });
  } catch (err) {
    console.error('[prix_engine] logImport error:', err.message);
  }
}

// ─── checkAndIncrementVolume ──────────────────────────────────────────────────
export async function checkAndIncrementVolume(sourceurId) {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const data = await atGet(T.SOURCEURS, {
    filterByFormula: `{sourceur_id}="${sourceurId}"`,
    maxRecords: 1,
    'fields[]': ['volume_max_mensuel', 'volume_actuel_mois', 'mois_volume'],
  });
  const rec = data.records?.[0];
  if (!rec) return;

  const f      = rec.fields;
  const maxVol = Number(f.volume_max_mensuel) || 0;
  let   actuel = Number(f.volume_actuel_mois) || 0;
  const mois   = String(f.mois_volume ?? '');

  if (mois !== currentMonth) actuel = 0;

  if (maxVol > 0 && actuel >= maxVol) {
    throw new Error(`Volume mensuel atteint (${actuel}/${maxVol} imports ce mois). Contactez votre gestionnaire.`);
  }

  await atPatch(T.SOURCEURS, rec.id, {
    volume_actuel_mois: actuel + 1,
    mois_volume:        currentMonth,
  });
}

// ─── getVehicleComparatif (used by dashboard) ─────────────────────────────────
export async function getVehicleComparatif(filters = {}) {
  const parts = ['{actif}=1', '{stock_disponible}>0'];
  if (filters.marque)  parts.push(`{marque}="${filters.marque}"`);
  if (filters.modele)  parts.push(`{modele}="${filters.modele}"`);
  if (filters.annee)   parts.push(`{annee}=${filters.annee}`);
  if (filters.finition) parts.push(`{finition}="${filters.finition}"`);
  if (filters.boite)   parts.push(`{boite_vitesse}="${filters.boite}"`);
  if (filters.couleur) parts.push(`{couleur}="${filters.couleur}"`);

  const records = await atFetchAll(T.PRIX_SOURCEURS, {
    filterByFormula: `AND(${parts.join(',')})`,
    'fields[]': [
      'sourceur_id', 'marque', 'modele', 'annee', 'finition', 'boite_vitesse', 'couleur',
      'prix_vehicule_usd', 'cif_shipping_sourceur_usd', 'cif_shipping_calcule_usd',
      'stock_disponible', 'delai_expedition_jours', 'date_mise_a_jour',
    ],
  });

  return records
    .map(r => ({
      id: r.id,
      ...r.fields,
      cif_final: r.fields.cif_shipping_sourceur_usd || r.fields.cif_shipping_calcule_usd || 0,
    }))
    .sort((a, b) => a.prix_vehicule_usd - b.prix_vehicule_usd);
}

// ─── Private ─────────────────────────────────────────────────────────────────
async function _updateSourceurStats(sourceurId) {
  const records = await atFetchAll(T.PRIX_SOURCEURS, {
    filterByFormula: `AND({sourceur_id}="${sourceurId}",{actif}=1,{stock_disponible}>0)`,
    'fields[]': ['stock_disponible'],
  });
  const totalStock = records.reduce((s, r) => s + (Number(r.fields.stock_disponible) || 0), 0);

  const srcData = await atGet(T.SOURCEURS, {
    filterByFormula: `{sourceur_id}="${sourceurId}"`,
    maxRecords: 1,
    'fields[]': ['nom_entreprise'],
  });
  const srcId = srcData.records?.[0]?.id;
  if (srcId) {
    await atPatch(T.SOURCEURS, srcId, {
      total_stock_actuel:     totalStock,
      nb_modeles_actifs:      records.length,
      derniere_maj_catalogue: new Date().toISOString(),
    });
  }
}
