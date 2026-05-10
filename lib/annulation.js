// Annulation — 3 branches: avant dépôt / après dépôt sourceur assig. / litige
import { sendText, sendButtons } from './whatsapp.js';

const COURTIER = process.env.COURTIER_WHATSAPP_NUMBER || process.env.COURTIER_WHATSAPP || '33760469653';
const AT_BASE  = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}`;
const AT_KEY   = process.env.AIRTABLE_API_KEY;
const TBL_DOS  = process.env.AIRTABLE_DOSSIERS_TABLE_ID || 'DOSSIERS';

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

const STATUTS_AVANT_DEPOT = ['DEVIS_ENVOYE', 'CONTRAT_ENVOYE', 'CONTRAT_SIGNE', 'CNI_VALIDEE', 'RDV_CONFIRME'];
const STATUTS_DEPOT_OK    = ['DEPOT_CONFIRME', 'SOURCEUR_CONTACTE', 'SOURCEUR_ASSIGNE'];
const STATUTS_TRANSIT     = ['DOCUMENTS_RECUS', 'EN_TRANSIT', 'NAVIRE_ARRIVE'];

export async function handleAnnulationRequest(from, ref) {
  const data = await atGet(TBL_DOS, {
    filterByFormula: `AND({reference_dossier}="${ref}",{telephone}="${from}")`,
    maxRecords: 1,
  });

  if (!data.records?.length) {
    return sendText(from, `❌ Dossier ${ref} introuvable ou ne correspond pas à votre numéro.`);
  }

  const rec = data.records[0];
  const d   = rec.fields;
  const statut = d.statut;

  if (STATUTS_AVANT_DEPOT.includes(statut)) {
    await annulationAvantDepot(rec.id, d, from);
  } else if (STATUTS_DEPOT_OK.includes(statut)) {
    await annulationApresDepot(rec.id, d, from);
  } else if (STATUTS_TRANSIT.includes(statut)) {
    await annulationEnTransit(rec.id, d, from);
  } else if (statut === 'CLOTURE') {
    await sendText(from, `✅ Dossier ${ref} déjà clôturé — aucune annulation possible.`);
  } else {
    await sendText(from, `⚠️ Annulation pour le statut *${statut}* — contactez un conseiller.`);
    await sendText(COURTIER, `⚠️ DEMANDE ANNULATION INHABITUELLE — ${ref}\nStatut: ${statut}\nClient: ${from}`);
  }
}

async function annulationAvantDepot(dossier_id, d, from) {
  await atPatch(TBL_DOS, dossier_id, {
    statut: 'ANNULE',
    motif_annulation: 'CLIENT_AVANT_DEPOT',
    date_annulation: new Date().toISOString(),
  });

  await sendText(from,
    `✅ *Dossier ${d.reference_dossier} annulé.*\n\n` +
    `Aucun frais — aucun montant n'a été encaissé.\n\n` +
    `Si vous changez d'avis, tapez *Nouveau projet* pour recommencer. 🙏`
  );

  await sendText(COURTIER,
    `🗑 ANNULÉ AVANT DÉPÔT — ${d.reference_dossier}\n` +
    `Client : ${d.prenom} ${d.nom} (${from})\n` +
    `Statut précédent : ${d.statut}`
  );
}

async function annulationApresDepot(dossier_id, d, from) {
  await sendButtons(from,
    `⚠️ *Annulation après dépôt — ${d.reference_dossier}*\n\n` +
    `Votre dossier est en cours de traitement avec un sourceur.\n\n` +
    `Une annulation à ce stade entraîne des *frais de dossier* conformément à votre contrat.\n\n` +
    `Confirmez-vous votre demande d'annulation ?`,
    [
      { id: `ANNUL_CONFIRM_${d.reference_dossier}`, title: '❌ Oui, annuler' },
      { id: `ANNUL_CANCEL_${d.reference_dossier}`,  title: '↩ Non, continuer' },
    ]
  );
}

async function annulationEnTransit(dossier_id, d, from) {
  await sendText(from,
    `🚢 *Annulation impossible — ${d.reference_dossier}*\n\n` +
    `Votre véhicule est en transit ou au port.\n\n` +
    `À ce stade, l'annulation nécessite une procédure juridique.\n` +
    `Un conseiller vous contacte dans les 24h pour exposer vos options.`
  );

  await sendText(COURTIER,
    `🚨 DEMANDE ANNULATION EN TRANSIT — ${d.reference_dossier}\n` +
    `Client : ${d.prenom} ${d.nom} (${from})\n` +
    `Statut : ${d.statut}\nINTERVENTION URGENTE REQUISE.`
  );
}

// Called when client confirms annulation after depot
export async function confirmAnnulationApresDepot(from, buttonId) {
  const isConfirm = buttonId.startsWith('ANNUL_CONFIRM_');
  const ref        = buttonId.replace(/^ANNUL_(CONFIRM|CANCEL)_/, '');

  if (!isConfirm) {
    return sendText(from, `↩ *Annulation annulée.* Votre dossier ${ref} continue normalement. 👍`);
  }

  const data = await atGet(TBL_DOS, {
    filterByFormula: `{reference_dossier}="${ref}"`,
    maxRecords: 1,
  });
  if (!data.records?.length) return;
  const rec = data.records[0];
  const d   = rec.fields;

  await atPatch(TBL_DOS, rec.id, {
    statut: 'ANNULE_LITIGE',
    motif_annulation: 'CLIENT_APRES_DEPOT',
    date_annulation: new Date().toISOString(),
  });

  await sendText(from,
    `📋 *Demande d'annulation enregistrée — ${ref}*\n\n` +
    `Notre équipe juridique traite votre dossier sous 48h.\n` +
    `Les modalités de remboursement vous seront communiquées. 🙏`
  );

  await sendButtons(COURTIER,
    `🚨 ANNULATION APRÈS DÉPÔT — ${ref}\n` +
    `Client : ${d.prenom} ${d.nom} (${from})\n` +
    `${d.marque} ${d.modele}\n\nTraitement juridique requis.`,
    [
      { id: `ANNUL_REMBOURSE_${ref}`, title: '✅ Rembourser' },
      { id: `ANNUL_FRAIS_${ref}`,     title: '⚖️ Appliquer frais' },
    ]
  );
}
