// Phase 14 — Assignation sourceur + cascade
import { sendText, sendButtons } from './whatsapp.js';
import { selectFallbackSourceurs } from './pricing.js';

const COURTIER = process.env.COURTIER_WHATSAPP_NUMBER || process.env.COURTIER_WHATSAPP || '33760469653';
const AT_BASE  = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}`;
const AT_KEY   = process.env.AIRTABLE_API_KEY;
const TBL_DOS  = process.env.AIRTABLE_DOSSIERS_TABLE_ID || 'DOSSIERS';
const TBL_SRC  = process.env.AIRTABLE_SOURCEURS_TABLE   || 'tblGeoLTGnBKhlAsK';

async function atGet(table, params = {}) {
  const url = new URL(`${AT_BASE}/${encodeURIComponent(table)}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AT_KEY}` } });
  if (!res.ok) throw new Error(`AT GET ${table}: ${res.status}`);
  return res.json();
}

async function atPatch(table, id, fields) {
  const res = await fetch(`${AT_BASE}/${encodeURIComponent(table)}/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`AT PATCH ${table}/${id}: ${res.status}`);
  return res.json();
}

async function atFetch(table, id) {
  const res = await fetch(`${AT_BASE}/${encodeURIComponent(table)}/${id}`, {
    headers: { Authorization: `Bearer ${AT_KEY}` },
  });
  if (!res.ok) throw new Error(`AT FETCH ${table}/${id}: ${res.status}`);
  return res.json();
}

async function getSourceurPhone(sourceur_id) {
  const data = await atGet(TBL_SRC, {
    filterByFormula: `{sourceur_id}="${sourceur_id}"`,
    maxRecords: 1,
    fields: JSON.stringify(['telephone', 'whatsapp_pro', 'nom_entreprise']),
  });
  const f = data.records?.[0]?.fields;
  return f ? { phone: f.whatsapp_pro || f.telephone, nom: f.nom_entreprise || '' } : null;
}

// ─── Entry point: called after DEPOT_CONFIRME ────────────────────────────────
export async function assignSourceur(dossier_id) {
  try {
    const rec = await atFetch(TBL_DOS, dossier_id);
    const d   = rec.fields;

    const sourceur_id = d.sourceur_assigne;
    if (!sourceur_id) {
      await sendText(COURTIER, `⚠️ AUCUN SOURCEUR ASSIGNÉ\nDossier: ${d.reference_dossier}\nIntervention manuelle requise.`);
      return;
    }

    const src = await getSourceurPhone(sourceur_id);
    if (!src?.phone) {
      await sendText(COURTIER, `⚠️ SOURCEUR ${sourceur_id} SANS NUMÉRO WA\nDossier: ${d.reference_dossier}`);
      return;
    }

    await sendButtons(src.phone,
      `📦 *CONFIRMATION DISPONIBILITÉ — ${d.reference_dossier}*\n\n` +
      `Véhicule : ${d.marque || ''} ${d.modele || ''} ${d.finition || ''}\n` +
      `Boîte    : ${d.boite_vitesse || 'Au choix'}\n` +
      `Couleur  : ${d.couleur || 'Au choix'}\n\n` +
      `⏰ Vous avez *24h* pour répondre.`,
      [
        { id: `DISPO_OUI_${d.reference_dossier}`, title: '✅ Disponible' },
        { id: `DISPO_NON_${d.reference_dossier}`, title: '❌ Indisponible' },
      ]
    );

    await atPatch(TBL_DOS, dossier_id, {
      statut: 'SOURCEUR_CONTACTE',
      sourceur_telephone: src.phone,
      timestamp_sourceur_contacte: new Date().toISOString(),
    });

    console.log(`[assigner] sourceur ${sourceur_id} contacté pour ${d.reference_dossier}`);
  } catch (err) {
    console.error('[assigner] assignSourceur error:', err.message);
    await sendText(COURTIER, `⚠️ ERREUR ASSIGNATION\nDossier: ${dossier_id}\nErreur: ${err.message}`).catch(() => {});
  }
}

// ─── Called from sourceur_bot.js when DISPO button is clicked ────────────────
export async function handleDispoReply(sourceurPhone, buttonId) {
  const isOui = buttonId.startsWith('DISPO_OUI_');
  const ref   = buttonId.replace(/^DISPO_(OUI|NON)_/, '');

  const data = await atGet(TBL_DOS, {
    filterByFormula: `{reference_dossier}="${ref}"`,
    maxRecords: 1,
  });

  if (!data.records?.length) {
    await sendText(sourceurPhone, `❌ Dossier ${ref} introuvable.`);
    return;
  }

  const rec = data.records[0];
  const d   = rec.fields;

  if (isOui) {
    await atPatch(TBL_DOS, rec.id, {
      statut: 'SOURCEUR_ASSIGNE',
      date_confirmation_commande: new Date().toISOString(),
    });

    await sendText(sourceurPhone,
      `✅ *Commande confirmée — ${ref}*\n\n` +
      `Vous avez *10 jours* pour préparer les 5 documents d'embarquement.\n\n` +
      `Tapez *docs* quand vous êtes prêt à commencer la transmission des documents.`
    );

    await sendText(COURTIER,
      `✅ SOURCEUR CONFIRMÉ — ${ref}\n` +
      `Sourceur : ${sourceurPhone}\n` +
      `Véhicule : ${d.marque} ${d.modele}\n` +
      `J+10 deadline : ${new Date(Date.now() + 10 * 86400000).toLocaleDateString('fr-FR')}`
    );

    if (d.telephone) {
      await sendText(d.telephone,
        `🔍 *Bonne nouvelle, ${d.prenom || ''} !*\n\n` +
        `Votre sourceur a confirmé la disponibilité de votre ${d.modele}.\n` +
        `Documents d'embarquement en cours de préparation. 🚗`
      ).catch(() => {});
    }

  } else {
    await sendText(sourceurPhone, '📝 Réponse enregistrée. Merci pour votre retour.');
    await atPatch(TBL_DOS, rec.id, { statut: 'SOURCEUR_INDISPONIBLE' });
    await sendText(COURTIER,
      `⚠️ SOURCEUR DÉCLINÉ — ${ref}\n` +
      `${d.marque} ${d.modele} — Cascade lancée automatiquement.`
    );
    await startCascade(rec.id, d);
  }
}

// ─── Cascade vers sourceurs alternatifs ─────────────────────────────────────
async function startCascade(dossier_id, d) {
  try {
    const fallbacks = await selectFallbackSourceurs(
      d.modele, d.finition, d.boite_vitesse, null, d.sourceur_assigne
    );

    if (!fallbacks.length) {
      await sendText(COURTIER,
        `🔴 AUCUN SOURCEUR ALTERNATIF — ${d.reference_dossier}\n` +
        `Intervention manuelle URGENTE requise.`
      );
      return;
    }

    let contacted = 0;
    for (const src of fallbacks.slice(0, 3)) {
      const info = await getSourceurPhone(src.sourceur_id);
      if (!info?.phone) continue;

      await sendButtons(info.phone,
        `🔄 *RECHERCHE SOURCEUR — ${d.reference_dossier}*\n\n` +
        `Véhicule : ${d.marque} ${d.modele} ${d.finition}\n` +
        `Budget   : $${src.prix_vehicule_usd || '?'} USD\n\n` +
        `⏰ Répondez dans les 6h.`,
        [
          { id: `DISPO_OUI_${d.reference_dossier}`, title: '✅ Je peux honorer' },
          { id: `DISPO_NON_${d.reference_dossier}`, title: '❌ Indisponible' },
        ]
      ).catch(() => {});
      contacted++;
    }

    if (!contacted) {
      await sendText(COURTIER,
        `🔴 AUCUN CONTACT SOURCEUR POSSIBLE — ${d.reference_dossier}\nTous les numéros manquants.`
      );
    }
  } catch (err) {
    console.error('[assigner] cascade error:', err.message);
    await sendText(COURTIER, `🔴 ERREUR CASCADE — ${d.reference_dossier}: ${err.message}`).catch(() => {});
  }
}
