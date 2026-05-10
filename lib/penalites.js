// Phase 15 — Pénalités & relances sourceur (J+6 → J+20)
import { sendText, sendButtons } from './whatsapp.js';

const COURTIER = process.env.COURTIER_WHATSAPP_NUMBER || process.env.COURTIER_WHATSAPP || '33760469653';
const AT_BASE  = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}`;
const AT_KEY   = process.env.AIRTABLE_API_KEY;
const TBL_DOS  = process.env.AIRTABLE_DOSSIERS_TABLE_ID || 'DOSSIERS';
const TBL_SRC  = process.env.AIRTABLE_SOURCEURS_TABLE   || 'tblGeoLTGnBKhlAsK';

async function atGet(table, params = {}) {
  const url = new URL(`${AT_BASE}/${encodeURIComponent(table)}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AT_KEY}` } });
  if (!res.ok) return { records: [] };
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

async function getSourceurPhone(sourceur_id) {
  const data = await atGet(TBL_SRC, {
    filterByFormula: `{sourceur_id}="${sourceur_id}"`,
    maxRecords: 1,
  });
  const f = data.records?.[0]?.fields;
  return f ? (f.whatsapp_pro || f.telephone) : null;
}

function daysSince(isoDate) {
  if (!isoDate) return null;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

// Called daily from /api/cron/daily
export async function runPenaltiesCheck() {
  const data = await atGet(TBL_DOS, {
    filterByFormula: `{statut}="SOURCEUR_ASSIGNE"`,
    maxRecords: 100,
  });

  for (const rec of data.records ?? []) {
    const d = rec.fields;
    const j = daysSince(d.date_confirmation_commande);
    if (j === null) continue;

    try {
      if (j === 6) await sendRelance(rec.id, d, j, 'PREMIERE');
      else if (j === 10) await sendRelance(rec.id, d, j, 'DEUXIEME');
      else if (j === 15) await sendRelance(rec.id, d, j, 'TROISIEME');
      else if (j === 20) await sendEscalade(rec.id, d);
    } catch (err) {
      console.error(`[penalites] dossier ${d.reference_dossier} J+${j}:`, err.message);
    }
  }
}

async function sendRelance(dossier_id, d, j, niveau) {
  const phone = await getSourceurPhone(d.sourceur_assigne);
  if (!phone) return;

  const restant = 10 - j;
  const emoji = niveau === 'PREMIERE' ? '⚠️' : niveau === 'DEUXIEME' ? '🔴' : '🚨';

  await sendText(phone,
    `${emoji} *Rappel J+${j} — ${d.reference_dossier}*\n\n` +
    `${d.marque} ${d.modele} — Documents d'embarquement requis.\n\n` +
    `Il vous reste *${restant > 0 ? restant + ' jours' : 'DÉLAI DÉPASSÉ'}* pour soumettre les 5 documents.\n\n` +
    `Tapez *docs* pour commencer ou continuer la transmission.`
  );

  await sendText(COURTIER,
    `${emoji} RELANCE SOURCEUR J+${j} — ${d.reference_dossier}\n` +
    `Sourceur : ${d.sourceur_assigne} (${phone})\n` +
    `Niveau : ${niveau}`
  );

  await atPatch(TBL_DOS, dossier_id, {
    [`timestamp_relance_${niveau.toLowerCase()}`]: new Date().toISOString(),
  });
}

async function sendEscalade(dossier_id, d) {
  await atPatch(TBL_DOS, dossier_id, {
    statut: 'SOURCEUR_DEFAILLANT',
    timestamp_escalade: new Date().toISOString(),
  });

  await sendButtons(COURTIER,
    `🚨 *ESCALADE J+20 — ${d.reference_dossier}*\n\n` +
    `Le sourceur ${d.sourceur_assigne} n'a pas soumis ses documents après 20 jours.\n` +
    `${d.marque} ${d.modele} — Client : ${d.prenom} ${d.nom}\n\n` +
    `Action requise : annulation ou remplacement sourceur ?`,
    [
      { id: `PENALITE_CANCEL_${d.reference_dossier}`, title: '❌ Annuler dossier' },
      { id: `PENALITE_REPLACE_${d.reference_dossier}`, title: '🔄 Nouveau sourceur' },
    ]
  );

  const phone = await getSourceurPhone(d.sourceur_assigne);
  if (phone) {
    await sendText(phone,
      `🚨 *MISE EN DEMEURE — ${d.reference_dossier}*\n\n` +
      `Délai de 20 jours dépassé sans transmission des documents.\n` +
      `Votre compte est suspendu. Contactez votre gestionnaire immédiatement.`
    ).catch(() => {});
  }

  if (d.telephone) {
    await sendText(d.telephone,
      `⚠️ *Information importante — ${d.reference_dossier}*\n\n` +
      `Votre dossier fait l'objet d'une révision.\n` +
      `Notre équipe vous contacte dans les 24h pour trouver une solution.`
    ).catch(() => {});
  }
}
