// lib/sourceur_bot.js
// WhatsApp bot for supplier-side interactions.
// Handles 4 flows: catalogue upload, Google Sheets link, quick price update, stock view.

import { sendText, sendButtons, sendList, sendDocument } from './whatsapp.js';
import { parseAndValidateCatalogue } from './catalogue_parser.js';
import { upsertPrixSourceur, recalculateBestPrices, logImport, checkAndIncrementVolume } from './prix_engine.js';
import { handleDispoReply } from './sourceur_assigner.js';
import { verifySourceurDoc } from './haiku.js';

const AT_BASE   = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}`;
const AT_AUTH   = () => ({ Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` });
const AT_JSON   = () => ({ ...AT_AUTH(), 'Content-Type': 'application/json' });

const T_SOURCEURS     = process.env.AIRTABLE_SOURCEURS_TABLE     || 'tblGeoLTGnBKhlAsK';
const T_PRIX          = process.env.AIRTABLE_PRIX_SOURCEURS_TABLE || 'tblkosDM1HA6SbW0V';
const TEMPLATE_URL    = process.env.CATALOGUE_TEMPLATE_URL        || '';
const SHEETS_API_KEY  = process.env.GOOGLE_SHEETS_API_KEY         || '';

// In-memory session per phone number (TTL: 30 min)
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;

function getSession(phone) {
  const s = sessions.get(phone);
  if (!s || Date.now() - s.ts > SESSION_TTL) return {};
  return s.data;
}
function setSession(phone, data) {
  sessions.set(phone, { ts: Date.now(), data });
}
function clearSession(phone) {
  sessions.delete(phone);
}

// ─── Airtable helpers ─────────────────────────────────────────────────────────

async function atGet(table, params = {}) {
  const url = new URL(`${AT_BASE}/${encodeURIComponent(table)}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: AT_AUTH() });
  if (!res.ok) return { records: [] };
  return res.json();
}

async function atPatch(table, id, fields) {
  await fetch(`${AT_BASE}/${encodeURIComponent(table)}/${id}`, {
    method: 'PATCH',
    headers: AT_JSON(),
    body: JSON.stringify({ fields }),
  });
}

export async function getSourceurByPhone(phone) {
  const data = await atGet(T_SOURCEURS, {
    filterByFormula: `OR({whatsapp_pro}="${phone}",{telephone}="${phone}")`,
    maxRecords: 1,
  });
  return data.records?.[0] ?? null;
}

export async function isKnownSourceur(phone) {
  const rec = await getSourceurByPhone(phone);
  return !!(rec && rec.fields.statut === 'ACTIF');
}

async function getSourceurStock(sourceurId) {
  const data = await atGet(T_PRIX, {
    filterByFormula: `AND({sourceur_id}="${sourceurId}",{actif}=1,{stock_disponible}>0)`,
    sort: JSON.stringify([{ field: 'modele', direction: 'asc' }]),
    maxRecords: 50,
  });
  return data.records ?? [];
}

async function downloadMetaFile(mediaId) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const meta = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meta.ok) return null;
  const { url } = await meta.json();
  const file = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!file.ok) return null;
  return Buffer.from(await file.arrayBuffer());
}

function extractSheetId(url) {
  const match = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? null;
}

function formatAgo(dateStr) {
  if (!dateStr) return '—';
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 60)   return `Il y a ${mins} min`;
  if (mins < 1440) return `Il y a ${Math.floor(mins / 60)} h`;
  return new Date(dateStr).toLocaleDateString('fr-FR');
}

// ─── Menu principal ───────────────────────────────────────────────────────────

async function sendMainMenu(to, nom) {
  return sendList(
    to,
    `👋 Bonjour ${nom} !\n\nQue souhaitez-vous faire ?`,
    'Ouvrir le menu',
    [{
      title: 'Actions disponibles',
      rows: [
        { id: 'SEND_CATALOGUE', title: '📤 Envoyer mon catalogue',   description: 'Fichier Excel ou CSV' },
        { id: 'LINK_SHEET',     title: '🔗 Google Sheet',            description: 'Sync automatique toutes les 6h' },
        { id: 'UPDATE_PRICE',   title: '✏️ Mettre à jour un prix',   description: 'Modification rapide' },
        { id: 'VIEW_STOCK',     title: '📊 Voir mon stock actuel',   description: 'Récapitulatif de votre stock' },
      ],
    }]
  );
}

// ─── Handler principal ────────────────────────────────────────────────────────

export async function handleSourceurMessage(msg) {
  const { from, type, text, button_reply, list_reply, media } = msg;

  // ── Phase 14: DISPO reply (can come from any sourceur, even non-registered) ──
  const buttonId = button_reply?.id || '';
  if (buttonId.startsWith('DISPO_OUI_') || buttonId.startsWith('DISPO_NON_')) {
    return handleDispoReply(from, buttonId);
  }

  // ── Phase 16: Doc validation buttons from courtier ────────────────────────
  if (buttonId.startsWith('DOC_OK_') || buttonId.startsWith('DOC_KO_')) {
    return handleDocValidation(from, buttonId);
  }

  const sourceur = await getSourceurByPhone(from);
  if (!sourceur || sourceur.fields.statut !== 'ACTIF') {
    return sendText(from, '⛔ Compte non reconnu ou inactif. Contactez votre gestionnaire.');
  }

  const nom        = sourceur.fields.nom_entreprise || sourceur.fields.nom || 'Partenaire';
  const sourceurId = sourceur.fields.sourceur_id || sourceur.id;
  const session    = getSession(from);

  const actionId  = button_reply?.id || list_reply?.id || '';
  const textBody  = String(text ?? '').trim().toLowerCase();
  const isMenu    = textBody === 'menu' || textBody === '0' || textBody === 'start'
                 || textBody === 'bonjour' || textBody === 'aide' || textBody === 'help';

  // ── Reset to menu ──────────────────────────────────────────────────────────
  if (isMenu || (!session.step && !actionId && type !== 'document')) {
    clearSession(from);
    return sendMainMenu(from, nom);
  }

  // ── Bouton : Envoyer catalogue ─────────────────────────────────────────────
  if (actionId === 'SEND_CATALOGUE') {
    setSession(from, { step: 'AWAITING_FILE' });
    const msg =
      `📤 *Envoi de catalogue*\n\n` +
      `Envoyez votre fichier *Excel (.xlsx)* ou *CSV*.\n\n` +
      `Colonnes requises :\n` +
      `\`marque | modele | annee | finition | boite | couleur | km | etat | pieces_modifiees | prix_usd | cif_usd | stock | delai_jours\``;
    await sendText(from, msg);
    if (TEMPLATE_URL) {
      await sendDocument(from, TEMPLATE_URL, 'template_catalogue.xlsx', '📥 Modèle catalogue sourceur');
    }
    return;
  }

  // ── Bouton : Google Sheet ──────────────────────────────────────────────────
  if (actionId === 'LINK_SHEET') {
    setSession(from, { step: 'AWAITING_SHEET_URL' });
    return sendText(from,
      `🔗 *Connexion Google Sheet*\n\n` +
      `Envoyez le lien de votre Google Sheet.\n\n` +
      `⚠️ Assurez-vous que le partage est activé en mode *Lecteur* pour tout le monde.`
    );
  }

  // ── Bouton : Mise à jour prix ──────────────────────────────────────────────
  if (actionId === 'UPDATE_PRICE') {
    const stock = await getSourceurStock(sourceurId);
    if (stock.length === 0) {
      clearSession(from);
      return sendText(from, '📭 Aucun véhicule en stock. Envoyez d\'abord votre catalogue.');
    }
    setSession(from, { step: 'SELECTING_VEHICLE', stock });
    const rows = stock.slice(0, 10).map(r => ({
      id:          `VEH_${r.id}`,
      title:       `${r.fields.marque} ${r.fields.modele} ${r.fields.annee || ''}`.trim().slice(0, 24),
      description: `${r.fields.couleur || '—'} · ${r.fields.stock_disponible || 0} unités`.slice(0, 72),
    }));
    return sendList(from,
      '✏️ *Mise à jour rapide*\nChoisissez le véhicule à modifier :',
      'Choisir',
      [{ title: 'Vos véhicules', rows }]
    );
  }

  // ── Bouton : Voir stock ────────────────────────────────────────────────────
  if (actionId === 'VIEW_STOCK') {
    const stock = await getSourceurStock(sourceurId);
    clearSession(from);
    if (stock.length === 0) {
      return sendText(from, '📭 Aucun véhicule en stock actuellement.');
    }
    const total = stock.reduce((s, r) => s + (Number(r.fields.stock_disponible) || 0), 0);
    const lines = stock.map(r => {
      const f = r.fields;
      const q = Number(f.stock_disponible) || 0;
      const p = Number(f.prix_vehicule_usd) || 0;
      return `🚗 ${f.marque} ${f.modele} ${f.annee || ''} ${f.couleur || ''}  → ${q} unité${q > 1 ? 's' : ''} · $${p.toLocaleString('fr-FR')}`;
    }).join('\n');
    const lastMaj = formatAgo(sourceur.fields.derniere_maj_catalogue);

    return sendButtons(from,
      `📊 *VOTRE STOCK — ${nom}*\nMis à jour : ${lastMaj}\n\n${lines}\n─────────────────────────────\nTOTAL : ${total} véhicule${total > 1 ? 's' : ''}`,
      [
        { id: 'UPDATE_PRICE',   title: '✏️ Mettre à jour' },
        { id: 'SEND_CATALOGUE', title: '📤 Nouveau catalogue' },
      ]
    );
  }

  // ── Réception fichier (AWAITING_FILE) ─────────────────────────────────────
  if (type === 'document' && session.step === 'AWAITING_FILE') {
    const mime     = media?.mime_type ?? '';
    const filename = media?.filename  ?? '';
    const isExcel  = mime.includes('spreadsheet') || mime.includes('excel') || filename.match(/\.xlsx?$/i);
    const isCsv    = mime.includes('csv') || filename.match(/\.csv$/i);

    if (!isExcel && !isCsv) {
      return sendText(from, '❌ Format non reconnu. Envoyez un fichier Excel (.xlsx) ou CSV (.csv).');
    }

    clearSession(from);
    await sendText(from, '⏳ Traitement en cours…');

    try {
      const buf = await downloadMetaFile(media.id);
      if (!buf) throw new Error('Téléchargement échoué');

      const format = isExcel ? 'excel' : 'csv';
      const { valid, invalid, stats } = await parseAndValidateCatalogue(buf, format);

      if (stats.total === 0) {
        return sendText(from, '❌ Fichier vide ou colonnes non reconnues. Vérifiez que les en-têtes sont en ligne 1.');
      }
      if (stats.total > 1000) {
        return sendText(from, `❌ Fichier trop volumineux (${stats.total} lignes). Maximum : 1 000 lignes.\n\nDécoupez votre catalogue en plusieurs fichiers.`);
      }

      if (valid.length > 0) {
        try {
          await checkAndIncrementVolume(sourceurId);
        } catch (volErr) {
          return sendText(from, `⚠️ *Quota mensuel atteint*\n\n${volErr.message}`);
        }
        await upsertPrixSourceur(sourceurId, valid);
        await recalculateBestPrices();
        await logImport(sourceurId, 'EXCEL', stats.total, stats.errors, invalid.slice(0, 20));
        await atPatch(T_SOURCEURS, sourceur.id, {
          derniere_maj_catalogue: new Date().toISOString(),
          methode_import_preferee: 'Excel',
        });
      }

      let reply = `✅ *Import terminé*\n\n📊 Total : ${stats.total}\n✅ Importées : ${stats.imported}`;
      if (stats.skipped > 0) reply += `\n⏭ Ignorées : ${stats.skipped}`;
      if (stats.errors > 0) {
        reply += `\n❌ Erreurs : ${stats.errors}\n\nPremiers problèmes :\n`;
        reply += invalid.slice(0, 3).map(e => `• Ligne ${e.row} : ${e.reason}`).join('\n');
      }
      return sendText(from, reply);
    } catch (err) {
      console.error('[sourceur_bot] import error:', err.message);
      return sendText(from, `❌ Erreur lors du traitement : ${err.message}`);
    }
  }

  // ── Réception URL Google Sheet (AWAITING_SHEET_URL) ───────────────────────
  if (type === 'text' && session.step === 'AWAITING_SHEET_URL') {
    const url     = text?.trim() ?? '';
    const sheetId = extractSheetId(url);

    if (!sheetId) {
      return sendText(from, '❌ Lien invalide. L\'URL doit contenir /spreadsheets/d/');
    }

    clearSession(from);
    await sendText(from, '🔍 Vérification de l\'accès…');

    try {
      // Test sheet access
      const testRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?key=${SHEETS_API_KEY}`
      );
      if (!testRes.ok) {
        return sendText(from, '❌ Google Sheet inaccessible. Vérifiez que le partage est activé pour *Tout le monde avec le lien* en mode Lecteur.');
      }

      // Save link to sourceur
      await atPatch(T_SOURCEURS, sourceur.id, {
        lien_google_sheet:       url,
        methode_import_preferee: 'Google_Sheets',
      });

      // Immediate sync
      let nbImportes = 0;
      if (SHEETS_API_KEY) {
        const rangeRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Catalogue!A2:P1000?key=${SHEETS_API_KEY}`
        );
        if (rangeRes.ok) {
          const rangeData = await rangeRes.json();
          const rows = rangeData.values ?? [];
          if (rows.length > 1) {
            const { valid, stats } = await parseAndValidateCatalogue(rows, 'sheets');
            if (valid.length > 0) {
              try {
                await checkAndIncrementVolume(sourceurId);
              } catch (volErr) {
                return sendText(from, `⚠️ *Quota mensuel atteint*\n\n${volErr.message}`);
              }
              await upsertPrixSourceur(sourceurId, valid);
              await recalculateBestPrices();
              await logImport(sourceurId, 'GOOGLE_SHEETS', stats.total, stats.errors);
              nbImportes = stats.imported;
            }
          }
        }
      }

      return sendText(from,
        `✅ *Google Sheet connecté !*\n\n` +
        `Synchronisation immédiate effectuée.\n` +
        `${nbImportes} véhicule${nbImportes > 1 ? 's' : ''} importé${nbImportes > 1 ? 's' : ''} ✅\n\n` +
        `🔄 Prochaine sync automatique : dans 6h`
      );
    } catch (err) {
      console.error('[sourceur_bot] sheets link error:', err.message);
      return sendText(from, `❌ Erreur : ${err.message}`);
    }
  }

  // ── Sélection véhicule pour mise à jour ───────────────────────────────────
  if (list_reply?.id?.startsWith('VEH_') && session.step === 'SELECTING_VEHICLE') {
    const recordId = list_reply.id.replace('VEH_', '');
    const vehicule = (session.stock ?? []).find(r => r.id === recordId);
    if (!vehicule) { clearSession(from); return sendMainMenu(from, nom); }

    const f = vehicule.fields;
    setSession(from, { step: 'UPDATE_PRIX', vehicule });
    return sendText(from,
      `✏️ *${f.marque} ${f.modele} ${f.annee || ''} ${f.couleur || ''}*\n` +
      `Prix actuel : $${Number(f.prix_vehicule_usd || 0).toLocaleString('fr-FR')}\n` +
      `Stock actuel : ${Number(f.stock_disponible || 0)} unités\n\n` +
      `Nouveau prix USD ? (tapez le montant ou "ok" pour garder)`
    );
  }

  // ── Saisie nouveau prix ────────────────────────────────────────────────────
  if (type === 'text' && session.step === 'UPDATE_PRIX') {
    const newPrix = textBody === 'ok' ? null : parseFloat(textBody.replace(/[^0-9.]/g, '')) || null;
    setSession(from, { ...session, step: 'UPDATE_STOCK', newPrix });
    const f = session.vehicule.fields;
    return sendText(from,
      `Nouveau stock ? Actuel : ${Number(f.stock_disponible || 0)} unités (ou "ok" pour garder)`
    );
  }

  // ── Saisie nouveau stock ──────────────────────────────────────────────────
  if (type === 'text' && session.step === 'UPDATE_STOCK') {
    const newStock = textBody === 'ok' ? null : parseInt(textBody.replace(/[^0-9]/g, ''), 10);
    setSession(from, { ...session, step: 'UPDATE_DELAI', newStock: isNaN(newStock) ? null : newStock });
    const f = session.vehicule.fields;
    return sendText(from,
      `Nouveau délai en jours ? Actuel : ${Number(f.delai_expedition_jours || 0)} j (ou "ok" pour garder)`
    );
  }

  // ── Saisie nouveau délai → finaliser ─────────────────────────────────────
  if (type === 'text' && session.step === 'UPDATE_DELAI') {
    const newDelai = textBody === 'ok' ? null : parseInt(textBody.replace(/[^0-9]/g, ''), 10);
    const { vehicule, newPrix, newStock } = session;
    clearSession(from);

    const updates = { date_mise_a_jour: new Date().toISOString() };
    if (newPrix  != null && !isNaN(newPrix))  updates.prix_vehicule_usd      = newPrix;
    if (newStock != null && !isNaN(newStock)) updates.stock_disponible        = newStock;
    if (newDelai != null && !isNaN(newDelai)) updates.delai_expedition_jours = newDelai;
    if (newStock != null) updates.actif = newStock > 0;

    try {
      await fetch(`${AT_BASE}/${encodeURIComponent(T_PRIX)}/${vehicule.id}`, {
        method: 'PATCH',
        headers: AT_JSON(),
        body: JSON.stringify({ fields: updates }),
      });
      await recalculateBestPrices();
      return sendText(from, '✅ Mis à jour ! Les prix comparatifs ont été recalculés.');
    } catch (err) {
      return sendText(from, `❌ Erreur de mise à jour : ${err.message}`);
    }
  }

  // ── Phase 16: "docs" trigger → 5-document guide ──────────────────────────
  if (textBody === 'docs') {
    setSession(from, { step: 'DOCS_GUIDE', docIndex: 0 });
    return sendPhase16Guide(from, 0);
  }

  // ── Phase 16: document uploads ────────────────────────────────────────────
  if (type === 'image' || type === 'document') {
    const s = getSession(from);
    if (s.step && s.step.startsWith('DOCS_')) {
      return handleDocUpload(from, s, sourceur, media, type);
    }
  }

  // ── Phase 16: text reply during doc flow ─────────────────────────────────
  if (type === 'text' && session.step && session.step.startsWith('DOCS_')) {
    return sendText(from, `📎 Envoyez une image ou un document, pas du texte.\n\nDocument attendu : ${DOC_LABELS[session.docIndex] || '?'}`);
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  clearSession(from);
  return sendMainMenu(from, nom);
}

// ─── Phase 16 constants & helpers ────────────────────────────────────────────

const DOC_LABELS = [
  'Facture d\'achat du véhicule',
  'Carte grise (titre de propriété)',
  'Photo du véhicule (face avant + plaque)',
  'Certificat de conformité ou rapport d\'inspection',
  'Bon de commande ou contrat vendeur',
];

const DOC_FIELDS = ['facture_url', 'carte_grise_url', 'photo_vehicule_url', 'certificat_url', 'bon_commande_url'];

async function sendPhase16Guide(to, index) {
  const total = DOC_LABELS.length;
  const label = DOC_LABELS[index];
  return sendText(to,
    `📋 *Document ${index + 1}/${total} — ${label}*\n\n` +
    `Envoyez une photo nette ou un scan PDF.\n\n` +
    `⚠️ Lisibilité requise — qualité insuffisante = rejet automatique.`
  );
}

async function handleDocUpload(from, session, sourceur, media, type) {
  const { docIndex = 0 } = session;
  const COURTIER_NUM = process.env.COURTIER_WHATSAPP_NUMBER || process.env.COURTIER_WHATSAPP || '33760469653';

  await sendText(from, `⏳ Analyse du document ${docIndex + 1}/5…`);

  try {
    const buf = await downloadMetaFile(media.id);
    if (!buf) throw new Error('Téléchargement échoué');

    const result = await verifySourceurDoc(buf, DOC_LABELS[docIndex], docIndex);

    if (result.valide === false && result.raison) {
      return sendText(from,
        `❌ *Document refusé*\n\n${result.raison}\n\nRenvoyez une version corrigée.`
      );
    }

    const ref = session.ref || '?';
    const docUrl = `[media:${media.id}]`;

    const updatedDocs = { ...(session.docs || {}), [DOC_FIELDS[docIndex]]: docUrl };

    if (docIndex === 2 && result.vin) {
      setSession(from, { ...session, step: 'DOCS_VIN_CROSS', docIndex, docs: updatedDocs, vin_photo: result.vin });
      return sendText(from,
        `✅ *Photo reçue*\n\nVIN détecté sur la photo : \`${result.vin}\`\n\n` +
        `Envoyez maintenant le *numéro VIN exact* de la facture pour cross-vérification.`
      );
    }

    await sendText(from, `✅ Document ${docIndex + 1}/5 validé.`);

    const newIndex = docIndex + 1;
    if (newIndex < DOC_LABELS.length) {
      setSession(from, { ...session, step: 'DOCS_GUIDE', docIndex: newIndex, docs: updatedDocs });
      return sendPhase16Guide(from, newIndex);
    }

    clearSession(from);
    await sendText(from,
      `🎉 *5 documents reçus !*\n\nLe courtier valide votre dossier sous 24h.\nVous serez notifié de la suite.`
    );

    await sendButtons(COURTIER_NUM,
      `📄 *DOCS SOURCEUR — ${session.ref || sourceur.fields.sourceur_id}*\n\n` +
      `5 documents reçus. Valider pour lancer l'embarquement ?`,
      [
        { id: `DOC_OK_${session.ref || sourceur.fields.sourceur_id}`, title: '✅ Valider' },
        { id: `DOC_KO_${session.ref || sourceur.fields.sourceur_id}`, title: '❌ Rejeter' },
      ]
    );

    if (session.dossier_id) {
      atPatch(T_SOURCEURS, sourceur.id, { statut_docs: 'DOCS_SOUMIS', date_soumission_docs: new Date().toISOString() }).catch(() => {});
    }

  } catch (err) {
    console.error('[sourceur_bot] doc upload error:', err.message);
    return sendText(from, `❌ Erreur analyse : ${err.message}`);
  }
}

// VIN cross-check during doc flow
async function handleTextDuringDocs(from, session, textBody) {
  if (session.step === 'DOCS_VIN_CROSS') {
    const vinFacture = textBody.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const vinPhoto   = (session.vin_photo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    if (vinFacture !== vinPhoto) {
      return sendText(from,
        `⚠️ *VIN incohérent*\n\n` +
        `Photo     : \`${vinPhoto}\`\n` +
        `Facture   : \`${vinFacture}\`\n\n` +
        `Vérifiez et renvoyez la photo du véhicule (doc 3/5).`
      );
    }

    await sendText(from, `✅ VIN cross-vérifié — ${vinFacture}\n\nPassons au document 4/5…`);
    const newIndex = session.docIndex + 1;
    setSession(from, { ...session, step: 'DOCS_GUIDE', docIndex: newIndex, vin_valide: vinFacture });
    return sendPhase16Guide(from, newIndex);
  }
}

async function handleDocValidation(courtierPhone, buttonId) {
  const isOk = buttonId.startsWith('DOC_OK_');
  const ref   = buttonId.replace(/^DOC_(OK|KO)_/, '');
  const COURTIER_NUM = process.env.COURTIER_WHATSAPP_NUMBER || process.env.COURTIER_WHATSAPP || '33760469653';

  if (isOk) {
    await sendText(COURTIER_NUM, `✅ Documents validés pour ${ref}. Embarquement autorisé.`);
  } else {
    await sendText(COURTIER_NUM, `❌ Documents rejetés pour ${ref}. Sourceur sera notifié.`);
  }
}
