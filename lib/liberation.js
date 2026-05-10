// Phase 17 — Libération 70% + notification transitaire
// Phase 18 — Tracking transit hebdomadaire
// Phase 19 — Libération 30% à l'arrivée au port
import { sendText, sendButtons } from './whatsapp.js';

const COURTIER   = process.env.COURTIER_WHATSAPP_NUMBER || process.env.COURTIER_WHATSAPP || '33760469653';
const AT_BASE    = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}`;
const AT_KEY     = process.env.AIRTABLE_API_KEY;
const TBL_DOS    = process.env.AIRTABLE_DOSSIERS_TABLE_ID || 'DOSSIERS';
const TBL_TRANS  = 'TRANSITAIRES';

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

// ─── Phase 17: 70% liberation after docs validated ───────────────────────────

export async function triggerLiberation70(dossier_id) {
  const res = await fetch(`${AT_BASE}/${encodeURIComponent(TBL_DOS)}/${dossier_id}`, {
    headers: { Authorization: `Bearer ${AT_KEY}` },
  });
  if (!res.ok) throw new Error(`AT FETCH DOSSIERS/${dossier_id}: ${res.status}`);
  const rec = await res.json();
  const d = rec.fields;

  const montant70 = d.montant_liberation_70 || Math.round((d.total_affiche || 0) * 0.70);
  const montant30 = d.montant_liberation_30 || Math.round((d.total_affiche || 0) * 0.30);

  await sendButtons(COURTIER,
    `💸 *LIBÉRATION 70% — ${d.reference_dossier}*\n\n` +
    `Client : ${d.prenom} ${d.nom}\n` +
    `${d.marque} ${d.modele}\n\n` +
    `Montant à libérer au notaire : *${fmt(montant70)} DA*\n` +
    `Solde conservé (30%) : ${fmt(montant30)} DA\n\n` +
    `Documents sourceur validés ✅\nConfirmez la libération ?`,
    [
      { id: `LIB70_OK_${d.reference_dossier}`, title: '✅ Confirmer libération' },
      { id: `LIB70_HOLD_${d.reference_dossier}`, title: '⏸ Mettre en attente' },
    ]
  );
}

export async function confirmLiberation70(buttonId) {
  const isOk = buttonId.startsWith('LIB70_OK_');
  const ref   = buttonId.replace(/^LIB70_(OK|HOLD)_/, '');

  const data = await atGet(TBL_DOS, {
    filterByFormula: `{reference_dossier}="${ref}"`,
    maxRecords: 1,
  });
  if (!data.records?.length) return;
  const rec = data.records[0];
  const d   = rec.fields;

  if (!isOk) {
    await sendText(COURTIER, `⏸ Libération 70% mise en attente — ${ref}`);
    return;
  }

  await atPatch(TBL_DOS, rec.id, {
    statut: 'EN_TRANSIT',
    liberation_70_date: new Date().toISOString(),
    liberation_70_confirme: true,
  });

  await sendText(COURTIER, `✅ Libération 70% enregistrée — ${ref}\nNotaire et transitaire notifiés.`);

  const notaire = process.env.NOTAIRE_WHATSAPP_NUMBER;
  if (notaire) {
    const montant70 = d.montant_liberation_70 || Math.round((d.total_affiche || 0) * 0.70);
    await sendText(notaire,
      `💸 *ORDRE DE LIBÉRATION — ${ref}*\n\n` +
      `Veuillez libérer *${fmt(montant70)} DA* au vendeur/transitaire.\n` +
      `Dossier : ${d.marque} ${d.modele} — ${d.prenom} ${d.nom}\n\n` +
      `Confirmez réception de cet ordre par retour de message.`
    ).catch(() => {});
  }

  const transitaire = await getTransitairePhone(d.zone || 'EST_CENTRE');
  if (transitaire) {
    await sendText(transitaire,
      `🚢 *EMBARQUEMENT AUTORISÉ — ${ref}*\n\n` +
      `${d.marque} ${d.modele} ${d.annee || ''}\n` +
      `VIN : ${d.vin || '—'}\n` +
      `Fonds libérés ✅ — Procédez à l'embarquement.`
    ).catch(() => {});
  }

  if (d.telephone) {
    await sendText(d.telephone,
      `🚢 *${d.prenom}, votre véhicule embarque !*\n\n` +
      `✅ ${d.marque} ${d.modele} est en route vers le port.\n` +
      `Durée estimée : *21–28 jours* selon le navire.\n` +
      `Référence : *${ref}*\n\n` +
      `Vous recevrez une mise à jour hebdomadaire. 🌊`
    ).catch(() => {});
  }
}

// ─── Phase 18: Weekly transit update (cron) ───────────────────────────────────

export async function sendWeeklyTransitUpdates() {
  const data = await atGet(TBL_DOS, {
    filterByFormula: `{statut}="EN_TRANSIT"`,
    maxRecords: 100,
  });

  for (const rec of data.records ?? []) {
    const d = rec.fields;
    if (!d.telephone) continue;

    const joursTransit = Math.floor((Date.now() - new Date(d.liberation_70_date).getTime()) / 86400000);
    const restant = Math.max(0, 28 - joursTransit);

    try {
      await sendText(d.telephone,
        `📡 *Suivi hebdomadaire — ${d.reference_dossier}*\n\n` +
        `🚢 ${d.marque} ${d.modele} en mer\n` +
        `Jour transit : J+${joursTransit}\n` +
        `Arrivée estimée : dans *~${restant} jours*\n\n` +
        `${d.navire_nom ? `🛳 Navire : ${d.navire_nom}\n` : ''}` +
        `Vous serez notifié à l'arrivée au port d'Alger. ⚓`
      );
    } catch (err) {
      console.error(`[liberation] transit update ${d.reference_dossier}:`, err.message);
    }
  }
}

// ─── Phase 19: 30% liberation on port arrival ─────────────────────────────────

export async function triggerPortArrivee(reference_dossier) {
  const data = await atGet(TBL_DOS, {
    filterByFormula: `{reference_dossier}="${reference_dossier}"`,
    maxRecords: 1,
  });
  if (!data.records?.length) return;
  const rec = data.records[0];
  const d   = rec.fields;

  await atPatch(TBL_DOS, rec.id, {
    statut: 'NAVIRE_ARRIVE',
    date_arrivee_port: new Date().toISOString(),
  });

  const montant30 = d.montant_liberation_30 || Math.round((d.total_affiche || 0) * 0.30);

  await sendButtons(COURTIER,
    `⚓ *PORT ARRIVÉE — ${reference_dossier}*\n\n` +
    `${d.marque} ${d.modele} au port d'Alger.\n\n` +
    `Solde restant : *${fmt(montant30)} DA* (30%)\n` +
    `Libérez après vérification physique du véhicule.`,
    [
      { id: `LIB30_OK_${reference_dossier}`, title: '✅ Libérer 30%' },
      { id: `LIB30_HOLD_${reference_dossier}`, title: '⏸ Vérification en cours' },
    ]
  );

  if (d.telephone) {
    await sendText(d.telephone,
      `⚓ *${d.prenom}, votre véhicule est arrivé !*\n\n` +
      `🎉 ${d.marque} ${d.modele} est au port d'Alger.\n\n` +
      `Notre équipe effectue la vérification physique.\n` +
      `Vous serez contacté sous 48h pour la livraison. 🚗`
    ).catch(() => {});
  }
}

export async function confirmLiberation30(buttonId) {
  const isOk = buttonId.startsWith('LIB30_OK_');
  const ref   = buttonId.replace(/^LIB30_(OK|HOLD)_/, '');

  if (!isOk) {
    await sendText(COURTIER, `⏸ Libération 30% en attente de vérification — ${ref}`);
    return;
  }

  const data = await atGet(TBL_DOS, {
    filterByFormula: `{reference_dossier}="${ref}"`,
    maxRecords: 1,
  });
  if (!data.records?.length) return;
  const rec = data.records[0];
  const d   = rec.fields;

  await atPatch(TBL_DOS, rec.id, {
    statut: 'CLOTURE',
    liberation_30_date: new Date().toISOString(),
    liberation_30_confirme: true,
  });

  const notaire = process.env.NOTAIRE_WHATSAPP_NUMBER;
  if (notaire) {
    const montant30 = d.montant_liberation_30 || Math.round((d.total_affiche || 0) * 0.30);
    await sendText(notaire,
      `💸 *SOLDE FINAL — ${ref}*\n\n` +
      `Veuillez libérer *${fmt(montant30)} DA* — solde final (30%).\n` +
      `Véhicule vérifié et conforme ✅`
    ).catch(() => {});
  }

  await sendText(COURTIER, `✅ Dossier ${ref} CLÔTURÉ — libération 30% confirmée.`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getTransitairePhone(zone) {
  const data = await atGet(TBL_TRANS, {
    filterByFormula: `AND({zone}="${zone}",{actif}=1)`,
    maxRecords: 1,
  });
  const f = data.records?.[0]?.fields;
  return f ? (f.whatsapp || f.telephone) : null;
}

function fmt(n) {
  return Number(n).toLocaleString('fr-DZ') + ' DA';
}
