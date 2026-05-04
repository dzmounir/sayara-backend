import { selectBestSourceur, calculateDevis, confirmAvailability } from './pricing.js';
import { sendText, sendButtons, sendDocument } from './whatsapp.js';

const AIRTABLE_BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY  = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;
const CARBONE_API_KEY          = process.env.CARBONE_API_KEY;
const CARBONE_TEMPLATE_DEVIS   = process.env.CARBONE_TEMPLATE_DEVIS;

async function airtableGet(path) {
  const res = await fetch(`${AIRTABLE_BASE_URL}/${path}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Airtable GET ${path} failed: ${res.status}`);
  return res.json();
}

async function airtablePatch(table, id, fields) {
  const res = await fetch(`${AIRTABLE_BASE_URL}/${encodeURIComponent(table)}/${id}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Airtable PATCH ${table}/${id} failed: ${res.status}`);
  return res.json();
}

// ─── Main devis generator — called from POST /api/pricing/devis ──────────────
export async function generateDevis(telephone, dossier_id, formule) {
  // 1. Fetch dossier
  const dossier = await airtableGet(`DOSSIERS/${dossier_id}`);
  const f = dossier.fields;

  // 2. Select best sourceur
  const sourceurResult = await selectBestSourceur(
    f.modele, f.variante_choisie, f.boite_vitesse, f.couleur_choisie ?? 'PEU_IMPORTE'
  );

  if (sourceurResult.status === 'NO_STOCK') {
    if (sourceurResult.couleurs_dispo?.length > 0) {
      await sendText(telephone,
        `⚠️ La couleur choisie n'est plus en stock.\n\nCouleurs disponibles : ${sourceurResult.couleurs_dispo.join(', ')}\n\nVoulez-vous choisir une autre couleur ?`
      );
    } else {
      await sendText(telephone,
        `⚠️ Cette configuration est momentanément indisponible.\n\nVotre demande a été enregistrée et nous vous contacterons dès qu'un véhicule correspondant sera disponible.`
      );
      await airtablePatch('DOSSIERS', dossier_id, { statut: 'HORS_ZONE' });
    }
    return { status: 'NO_STOCK' };
  }

  const { sourceur } = sourceurResult;

  // 3. Calculate devis
  const devis = await calculateDevis(sourceur, f.modele, f.commune);

  // 4. Confirm sourceur availability in background (non-blocking)
  confirmAvailability(sourceur.sourceur_id, f.reference_dossier).catch(err =>
    console.error('confirmAvailability failed:', err.message)
  );

  // 5. Save devis fields to Airtable
  await airtablePatch('DOSSIERS', dossier_id, {
    prix_vehicule_usd:      devis.prix_vehicule_usd,
    cif_usd:                devis.cif_usd,
    sous_total:             devis.sous_total,
    commission_da:          devis.commission_da,
    sourceur_assigne:       devis.sourceur_id_utilise,
    prix_vehicule_affiche:  devis.prix_vehicule_affiche,
    frais_notaire:          devis.frais_notaire,
    total_livre_au_port:    devis.total_livre_au_port,
    droits_douane:          devis.droits_douane,
    cout_degroupage_da:     devis.cout_degroupage_da,
    cout_transitaire_da:    devis.cout_transitaire_da,
    supplement_dedouane:    devis.supplement_dedouane,
    total_dedouane:         devis.total_dedouane,
    formule_choisie:        formule,
    montant_70_sourceur:    Math.round(devis.total_livre_au_port * 0.7),
    montant_70_total:       Math.round(devis.total_livre_au_port * 0.7),
    montant_30_sourceur:    Math.round(devis.total_livre_au_port * 0.3),
    montant_30_total:       Math.round(devis.total_livre_au_port * 0.3),
  });

  // 6. Generate PDF via Carbone.io
  let pdfUrl = null;
  try {
    pdfUrl = await generatePDF(f, devis, formule);
  } catch (err) {
    console.error('Carbone PDF generation failed:', err.message);
  }

  // 7. Send devis to client
  const devisMessage = buildDevisMessage(f, devis, formule);

  if (pdfUrl) {
    await sendDocument(
      telephone,
      pdfUrl,
      `Devis_SAYARA_${f.reference_dossier}.pdf`,
      devisMessage
    );
  } else {
    await sendText(telephone, devisMessage);
  }

  await sendButtons(telephone, 'Souhaitez-vous confirmer ce devis ?', [
    { id: 'CONFIRMER', title: '✅ Confirmer' },
    { id: 'MODIFIER',  title: '✏️ Modifier' },
  ]);

  return { status: 'OK', devis };
}

// ─── Carbone.io PDF generation ────────────────────────────────────────────────
async function generatePDF(dossierFields, devis, formule) {
  if (!CARBONE_TEMPLATE_DEVIS) throw new Error('CARBONE_TEMPLATE_DEVIS not set');

  const carboneRes = await fetch(`https://api.carbone.io/render/${CARBONE_TEMPLATE_DEVIS}`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${CARBONE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        reference_dossier:      dossierFields.reference_dossier,
        prenom_acheteur:        dossierFields.prenom,
        nom_acheteur:           dossierFields.nom,
        variante:               dossierFields.variante_choisie,
        couleur:                dossierFields.couleur_choisie,
        boite_vitesse:          dossierFields.boite_vitesse,
        formule_choisie:        formule === 'FORMULE_DEDOUANE' ? 'Dédouané complet' : 'Livré au port',
        prix_vehicule_affiche:  fmt(devis.prix_vehicule_affiche),
        note_prix:              devis.note_prix,
        frais_notaire:          fmt(devis.frais_notaire),
        total_livre_au_port:    fmt(devis.total_livre_au_port),
        droits_douane:          fmt(devis.droits_douane),
        note_douane:            devis.note_douane,
        cout_degroupage_da:     fmt(devis.cout_degroupage_da),
        cout_transitaire_da:    fmt(devis.cout_transitaire_da),
        supplement_dedouane:    fmt(devis.supplement_dedouane),
        total_dedouane:         fmt(devis.total_dedouane),
        date_devis:             new Date().toLocaleDateString('fr-FR'),
        valide_jusqua:          new Date(Date.now() + 48 * 3600 * 1000).toLocaleDateString('fr-FR'),
      },
      convertTo: 'pdf',
    }),
  });

  if (!carboneRes.ok) throw new Error(`Carbone render failed: ${carboneRes.status}`);
  const carboneData = await carboneRes.json();
  const renderId = carboneData.data?.renderId;
  if (!renderId) throw new Error('Carbone: no renderId in response');

  // Carbone returns a download URL directly
  return `https://api.carbone.io/render/${renderId}`;
}

// ─── WhatsApp message builder ─────────────────────────────────────────────────
function buildDevisMessage(f, devis, formule) {
  const isDedouane = formule === 'FORMULE_DEDOUANE';

  let msg = `🚗 *Devis SAYARA — ${f.reference_dossier}*\n`;
  msg += `📅 Valable 48h\n\n`;
  msg += `*Véhicule :* ${f.marque ?? 'Dacia'} ${f.modele ?? 'Duster'} — ${f.variante_choisie}\n`;
  msg += `*Couleur :* ${f.couleur_choisie ?? 'À définir'} | *Boîte :* ${f.boite_vitesse}\n\n`;
  msg += `━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 *Prix véhicule* : ${fmt(devis.prix_vehicule_affiche)} DA\n`;
  msg += `   _(${devis.note_prix})_\n`;
  msg += `📋 *Frais notaire* : ${fmt(devis.frais_notaire)} DA\n`;
  msg += `━━━━━━━━━━━━━━━━━━━\n`;
  msg += `🚢 *TOTAL LIVRÉ AU PORT : ${fmt(devis.total_livre_au_port)} DA*\n`;

  if (isDedouane) {
    msg += `\n━━━━ Supplément dédouanement ━━━━\n`;
    msg += `🏛️ Droits de douane *(${devis.note_douane})* : ${fmt(devis.droits_douane)} DA\n`;
    msg += `📦 Dégroupage : ${fmt(devis.cout_degroupage_da)} DA\n`;
    msg += `🚛 Transitaire : ${fmt(devis.cout_transitaire_da)} DA\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    msg += `🏠 *TOTAL DÉDOUANÉ : ${fmt(devis.total_dedouane)} DA*\n`;
  }

  msg += `\n⚠️ _Les droits de douane sont approximatifs. Le montant final peut varier selon la valeur déclarée en douane._`;
  return msg;
}

function fmt(n) {
  return Math.round(n).toLocaleString('fr-DZ');
}
