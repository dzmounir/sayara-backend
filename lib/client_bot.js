import { sendText, sendButtons, sendList } from './whatsapp.js';
import { qualifyVehicle, normalizeCommune } from './haiku.js';
import { selectBestSourceur, calculateDevis, getFinitionsDisponibles, getBoitesDisponibles, getCouleurDisponibles } from './pricing.js';
import { decrementStock } from './prix_engine.js';
import { verifyCNI } from './cni_verifier.js';
import { assignSourceur } from './sourceur_assigner.js';

const COURTIER    = process.env.COURTIER_WHATSAPP_NUMBER || process.env.COURTIER_WHATSAPP || '33760469653';
const NOTAIRE_NUM = process.env.NOTAIRE_WHATSAPP_NUMBER || '';
const SESSION_TTL  = 30 * 60 * 1000; // 30 min
const MAX_CNI_TRIES = 3;

const AT_BASE    = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}`;
const AT_KEY     = process.env.AIRTABLE_API_KEY;
const TBL_DOS    = process.env.AIRTABLE_DOSSIERS_TABLE_ID || 'DOSSIERS';
const TBL_CAT    = process.env.AIRTABLE_CATALOGUE_COMPARATIF_TABLE || 'CATALOGUE_COMPARATIF';
const TBL_NOT    = 'NOTAIRES_PAR_COMMUNE';
const TBL_PROSP  = 'PROSPECTS';

// ─── Sessions (RAM, 30-min TTL) ───────────────────────────────────────────────
const sessions = new Map();

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [k, v] of sessions) if (v.updatedAt < cutoff) sessions.delete(k);
}, 10 * 60 * 1000);

function getSession(phone) {
  const s = sessions.get(phone);
  return s && Date.now() - s.updatedAt < SESSION_TTL ? s : null;
}

function save(phone, step, delta = {}) {
  const s = sessions.get(phone) ?? { lang: 'fr', data: {} };
  const next = { lang: s.lang, step, data: { ...s.data, ...delta }, updatedAt: Date.now() };
  sessions.set(phone, next);
  return next;
}

function setLang(phone, lang) {
  const s = sessions.get(phone) ?? { step: 'INIT', data: {}, updatedAt: Date.now() };
  sessions.set(phone, { ...s, lang, updatedAt: Date.now() });
}

// ─── Airtable ─────────────────────────────────────────────────────────────────
async function atGet(table, params = {}) {
  const url = new URL(`${AT_BASE}/${encodeURIComponent(table)}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${AT_KEY}` } });
  if (!res.ok) throw new Error(`AT GET ${table}: ${res.status}`);
  return res.json();
}

async function atCreate(table, fields) {
  const res = await fetch(`${AT_BASE}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`AT POST ${table}: ${res.status}`);
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

// ─── Meta media download ──────────────────────────────────────────────────────
async function downloadMedia(mediaId) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || !mediaId) return null;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) return null;
    const { url } = await metaRes.json();
    const imgRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!imgRes.ok) return null;
    return Buffer.from(await imgRes.arrayBuffer()).toString('base64');
  } catch { return null; }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
const genRef = () => `SAY-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
const fmt = n  => new Intl.NumberFormat('fr-DZ').format(Math.round(n)) + ' DA';

// ─── Cold resume — rehydrate session from Airtable ────────────────────────────
async function coldResume(from, type, mediaId) {
  try {
    const data = await atGet(TBL_DOS, {
      filterByFormula: `{telephone}="${from}"`,
      maxRecords: 1,
      sort: JSON.stringify([{ field: 'timestamp_devis_confirme', direction: 'desc' }]),
      fields: JSON.stringify([
        'reference_dossier', 'statut', 'modele', 'marque', 'annee',
        'prenom', 'nom', 'commune', 'wilaya', 'zone', 'email', 'formule',
        'total_livre_au_port', 'total_dedouane', 'notaire_nom', 'notaire_adresse',
        'notaire_telephone', 'rdv_notaire_date',
      ]),
    });
    if (!data.records?.length) return null;

    const rec = data.records[0];
    const f   = rec.fields;
    const total = f.formule === 'PORT' ? f.total_livre_au_port : f.total_dedouane;
    const base  = { dossier_id: rec.id, ref: f.reference_dossier, prenom: f.prenom, nom: f.nom, modele: f.modele, marque: f.marque, annee: f.annee, commune: f.commune, wilaya: f.wilaya, zone: f.zone, email: f.email, formule: f.formule, total_port: f.total_livre_au_port, total_dedouane: f.total_dedouane, total_affiche: total };

    if (type === 'image' && f.statut === 'RDV_CONFIRME') {
      save(from, 'DEPOT_ATTENTE', { ...base, depot_client_confirme: false, depot_notaire_confirme: false });
      return sessions.get(from);
    }
    if (type === 'image' && f.statut === 'CONTRAT_SIGNE') {
      save(from, 'CNI_RECTO', base);
      return sessions.get(from);
    }
    if (type === 'image' && f.statut === 'CNI_RECTO_RECU') {
      save(from, 'CNI_VERSO_WAIT', { ...base, cni_recto_ok: true });
      return sessions.get(from);
    }
  } catch { /* non-blocking */ }
  return null;
}

// ─── Main entry point ─────────────────────────────────────────────────────────
export async function handleClientMessage(payload) {
  const { from, type } = payload;
  const text        = payload.text?.trim() || '';
  const buttonId    = payload.button_reply?.id    || '';
  const buttonTitle = payload.button_reply?.title || '';
  const listId      = payload.list_reply?.id      || '';
  const listTitle   = payload.list_reply?.title   || '';
  const choiceId    = buttonId || listId;
  const choiceTitle = buttonTitle || listTitle;
  const mediaId     = payload.media?.id || '';

  // Route notaire button replies — they arrive from the notaire's phone number
  if (choiceId.startsWith('NOTAIRE_')) return handleNotaireReply(from, choiceId);

  let session = getSession(from);

  // Global: reset
  if (type === 'text' && ['menu', 'aide', 'restart'].includes(text.toLowerCase())) {
    save(from, 'MENU');
    return sendMenu(from);
  }

  // Cold resume from Airtable if session expired
  if (!session) {
    session = await coldResume(from, type, mediaId);
    if (!session) {
      save(from, 'INIT');
      session = sessions.get(from);
    }
  }

  try {
    switch (session.step) {
      case 'INIT':              return doInit(from);
      case 'LANGUE':            return doLangue(from, choiceId, session);
      case 'MENU':              return doMenu(from, choiceId, session);
      case 'VEHICULE_INPUT':    return doVehiculeInput(from, text, session);
      case 'VEHICULE_CONFIRM':  return doVehiculeConfirm(from, choiceId, session);
      case 'FINITION_SELECT':   return doFinitionSelect(from, choiceId, listTitle, session);
      case 'BOITE_SELECT':      return doBoiteSelect(from, choiceId, session);
      case 'COULEUR_SELECT':    return doCouleurSelect(from, listTitle, session);
      case 'FORMULE_SELECT':    return doFormuleSelect(from, choiceId, session);
      case 'PRENOM_INPUT':      return doPrenomInput(from, text, session);
      case 'NOM_INPUT':         return doNomInput(from, text, session);
      case 'COMMUNE_INPUT':     return doCommuneInput(from, text, session);
      case 'EMAIL_INPUT':       return doEmailInput(from, text, session);
      case 'DEVIS_CONFIRM':     return doDevisConfirm(from, choiceId, session);
      case 'CONTRAT_SIGN':      return doContratSign(from, choiceId, session);
      case 'CNI_RECTO':         return doCniRecto(from, type, mediaId, session);
      case 'CNI_VERSO_WAIT':    return doCniVersoWait(from, type, mediaId, session);
      case 'RDV_SELECT':        return doRdvSelect(from, choiceId, session);
      case 'DEPOT_ATTENTE':     return doDepotAttente(from, type, mediaId, session);
      default:
        save(from, 'MENU');
        return sendMenu(from);
    }
  } catch (err) {
    console.error(`[client_bot] ${session.step} from=${from}:`, err.message);
    await sendText(from, '⚠️ Une erreur est survenue. Notre équipe est alertée.\n\nTapez *menu* pour continuer.').catch(() => {});
    sendText(COURTIER, `⚠️ ERREUR BOT CLIENT\nNuméro: ${from}\nÉtape: ${session.step}\nErreur: ${err.message}`).catch(() => {});
  }
}

// ─── PHASE 1 — LANGUE ────────────────────────────────────────────────────────
async function doInit(from) {
  save(from, 'LANGUE');
  return sendButtons(from, '🇩🇿 سيارة · DjazairAuto 🚗\n\nBienvenue ! Choisissez votre langue :', [
    { id: 'LANG_FR', title: '🇫🇷 Français' },
    { id: 'LANG_AR', title: '🇩🇿 العربية' },
    { id: 'LANG_EN', title: '🇬🇧 English' },
  ]);
}

async function doLangue(from, choiceId, session) {
  if (choiceId === 'LANG_AR') {
    save(from, 'DONE'); setLang(from, 'ar');
    return sendText(from, 'مرحباً! سيتواصل معك فريقنا قريباً. 🙏');
  }
  if (choiceId === 'LANG_EN') {
    save(from, 'DONE'); setLang(from, 'en');
    return sendText(from, 'Hello! Our team will contact you shortly. 🙏');
  }
  setLang(from, 'fr');
  atCreate(TBL_PROSP, { telephone: from, timestamp_contact: new Date().toISOString(), langue: 'fr' }).catch(() => {});
  return sendMenu(from);
}

// ─── PHASE 2 — MENU ──────────────────────────────────────────────────────────
async function sendMenu(from) {
  save(from, 'MENU');
  return sendButtons(from,
    'Bienvenue chez *DjazairAuto* ! 🚗\n\nImportation automobile sécurisée par notaire.\nDepuis KSA, UAE, Chine ou France.',
    [
      { id: 'MENU_PROJET', title: '🚗 Nouveau projet' },
      { id: 'MENU_SUIVI',  title: '📍 Mon dossier' },
      { id: 'MENU_AGENT',  title: '👤 Un conseiller' },
    ]
  );
}

async function doMenu(from, choiceId, session) {
  if (choiceId === 'MENU_SUIVI') return doSuivi(from);
  if (choiceId === 'MENU_AGENT') {
    save(from, 'DONE');
    await sendText(from, '👤 Notre conseiller vous contacte dans les prochaines heures.\n\nTapez *menu* pour continuer en attendant.');
    await sendText(COURTIER, `📞 APPEL REQUIS\nClient demande un conseiller\nNuméro: wa.me/${from}\n${new Date().toLocaleString('fr-FR')}`);
    return;
  }
  save(from, 'VEHICULE_INPUT');
  return sendText(from,
    'Quel véhicule souhaitez-vous importer ? 🚗\n\n' +
    'Décrivez-le librement, par exemple :\n' +
    '▸ _duster 2025 automatique_\n' +
    '▸ _sportage 2024 full option blanc_\n' +
    '▸ _toyota corolla 2023 manuelle_'
  );
}

// ─── PHASE 3 — QUALIFICATION VÉHICULE (Claude Haiku) ─────────────────────────
async function doVehiculeInput(from, text, session) {
  if (!text) return sendText(from, 'Décrivez le véhicule souhaité. Ex: _duster 2025 automatique_');

  let h;
  try { h = await qualifyVehicle(text); }
  catch { h = { confiance: 'BASSE' }; }

  save(from, 'VEHICULE_CONFIRM', { vehicule_texte: text, h });

  if (h.confiance === 'BASSE' || !h.marque || !h.modele) {
    return sendText(from,
      '🤔 Pouvez-vous préciser ?\n\n' +
      'Indiquez la *marque*, le *modèle* et l\'*année*, par exemple :\n' +
      '▸ _Dacia Duster 2025 automatique_\n' +
      '▸ _Kia Sportage 2024 full option_'
    );
  }

  const car    = [h.marque, h.modele, h.annee, h.finition].filter(Boolean).join(' ');
  const extras = [h.boite ? `⚙️ Boîte : *${h.boite}*` : '', h.couleur ? `🎨 Couleur : *${h.couleur}*` : ''].filter(Boolean).join('\n');

  return sendButtons(from,
    `Si je comprends bien :\n🚗 *${car}*${extras ? '\n' + extras : ''}\n\nC'est correct ?`,
    [
      { id: 'VEHI_OK',   title: '✅ C\'est correct' },
      { id: 'VEHI_EDIT', title: '✏️ Corriger' },
    ]
  );
}

// ─── PHASE 4 — CONFIRMATION + RECHERCHE PROGRESSIVE ─────────────────────────
async function doVehiculeConfirm(from, choiceId, session) {
  if (choiceId === 'VEHI_EDIT') {
    save(from, 'VEHICULE_INPUT');
    return sendText(from, 'Redécrivez le véhicule souhaité :\n▸ Ex: _duster 2025 automatique blanc_');
  }

  const h = session.data.h || {};
  await sendText(from, '🔍 Recherche dans notre catalogue...');

  try {
    const { available, finitions } = await getFinitionsDisponibles(h.marque, h.modele, h.annee);

    if (!available) {
      save(from, 'MENU');
      await sendText(from,
        `📋 *${h.marque || ''} ${h.modele}* n'est pas disponible en stock actuellement.\n\n` +
        `Votre demande est enregistrée. Nous vous prévenons dès qu'un stock arrive. 🔔`
      );
      sendText(COURTIER, `📊 HORS STOCK\nNuméro: ${from}\nVéhicule: ${h.marque} ${h.modele} ${h.annee}\nTexte: "${session.data.vehicule_texte}"`).catch(() => {});
      return;
    }

    save(from, 'FINITION_SELECT', { marque: h.marque, modele: h.modele, annee: h.annee, finitions });

    if (finitions.length === 1) {
      return doFinitionSelect(from, 'FIN_0', finitions[0], sessions.get(from));
    }

    const rows = finitions.slice(0, 9).map((f, i) => ({
      id: `FIN_${i}`,
      title: f.slice(0, 24),
      description: 'Disponible en stock',
    }));
    rows.push({ id: 'FIN_NIMP', title: 'Peu importe', description: 'Meilleur prix disponible' });

    return sendList(from,
      `✅ *${h.marque} ${h.modele}${h.annee ? ' ' + h.annee : ''} disponible !*\n\nQuelle finition souhaitez-vous ?`,
      '📋 Voir les finitions',
      [{ title: 'Finitions disponibles', rows }]
    );
  } catch (err) {
    console.error('[client_bot] finitions error:', err.message);
    save(from, 'MENU');
    return sendText(from, '⚠️ Erreur de recherche. Tapez *menu* pour réessayer.');
  }
}

// ─── PHASE 5A — FINITION ──────────────────────────────────────────────────────
async function doFinitionSelect(from, choiceId, listTitle, session) {
  const d = session.data;
  let finition;
  if (choiceId === 'FIN_NIMP') {
    finition = null;
  } else if (choiceId.startsWith('FIN_')) {
    const idx = parseInt(choiceId.replace('FIN_', ''));
    finition = (d.finitions || [])[idx] ?? null;
  } else {
    finition = listTitle || null;
  }

  save(from, 'BOITE_SELECT', { finition });

  try {
    const { boites } = await getBoitesDisponibles(d.marque, d.modele, d.annee, finition);
    if (boites.length === 1) {
      save(from, 'BOITE_SELECT', { finition, boite: boites[0] });
      return doCouleurFetch(from, boites[0]);
    }
    return sendButtons(from, `⚙️ Boîte de vitesses ?`, [
      { id: 'BOITE_AUTO', title: '🔄 Automatique' },
      { id: 'BOITE_MANU', title: '🔧 Manuelle' },
      { id: 'BOITE_NDSP', title: '🤷 Peu importe' },
    ]);
  } catch {
    return sendButtons(from, '⚙️ Boîte de vitesses ?', [
      { id: 'BOITE_AUTO', title: '🔄 Automatique' },
      { id: 'BOITE_MANU', title: '🔧 Manuelle' },
      { id: 'BOITE_NDSP', title: '🤷 Peu importe' },
    ]);
  }
}

// ─── PHASE 5B — BOÎTE ────────────────────────────────────────────────────────
async function doBoiteSelect(from, choiceId, session) {
  const boite = choiceId === 'BOITE_AUTO' ? 'Automatique' : choiceId === 'BOITE_MANU' ? 'Manuelle' : null;
  save(from, 'COULEUR_SELECT', { boite });
  return doCouleurFetch(from, boite);
}

async function doCouleurFetch(from, boite) {
  const d = sessions.get(from).data;
  try {
    const { couleurs } = await getCouleurDisponibles(d.marque, d.modele, d.annee, d.finition, boite);
    if (!couleurs.length) {
      save(from, 'FORMULE_SELECT');
      return sendButtons(from, 'Quelle formule souhaitez-vous ? 📦', [
        { id: 'FORM_PORT',    title: '⚓ Livré au Port' },
        { id: 'FORM_DEDOUAN', title: 'Dédouané tout inclus' },
      ]);
    }
    const rows = couleurs.slice(0, 9).map((c, i) => ({
      id: `CLR_${i}`,
      title: c.slice(0, 24),
      description: '✅ En stock',
    }));
    rows.push({ id: 'CLR_NIMP', title: 'Peu importe', description: 'Meilleur choix disponible' });
    return sendList(from, 'Quelle couleur préférez-vous ? 🎨', '🎨 Choisir', [{ title: 'Couleurs disponibles', rows }]);
  } catch {
    return sendList(from, 'Quelle couleur préférez-vous ? 🎨', '🎨 Choisir', [{
      title: 'Couleurs',
      rows: [
        { id: 'CLR_0', title: 'Blanc Glacier',  description: 'Disponible' },
        { id: 'CLR_1', title: 'Gris Highland',   description: 'Disponible' },
        { id: 'CLR_2', title: 'Noir Étoile',     description: 'Disponible' },
        { id: 'CLR_3', title: 'Marron / Beige',  description: 'Disponible' },
        { id: 'CLR_NIMP', title: 'Peu importe',  description: 'Meilleur choix disponible' },
      ],
    }]);
  }
}

// ─── PHASE 5C — COULEUR (vérification stock finale) ──────────────────────────
async function doCouleurSelect(from, listTitle, session) {
  const couleur = (!listTitle || listTitle === 'Peu importe') ? null : listTitle;
  const d = session.data;

  try {
    const result = await selectBestSourceur(
      d.modele, d.finition, d.boite || null, couleur, d.marque || null, d.annee || null,
    );

    if (result.status === 'NO_STOCK') {
      const alts = (result.couleurs_dispo || []).filter(c => c && c !== couleur);
      if (alts.length) {
        const rows = alts.slice(0, 9).map((c, i) => ({ id: `CLR_${i}`, title: c.slice(0, 24), description: '✅ En stock' }));
        return sendList(from,
          `😔 *${couleur || 'Cette couleur'}* n'est plus disponible.\n\nAutres couleurs disponibles :`,
          '🎨 Choisir',
          [{ title: 'Couleurs disponibles', rows }]
        );
      }
      save(from, 'MENU');
      await sendText(from, '😔 Ce véhicule vient d\'être réservé.\n\nNous vous prévenons dès qu\'un stock arrive. 🔔');
      sendText(COURTIER, `📊 STOCK ÉPUISÉ EN QUALIFICATION\nNuméro: ${from}\n${d.marque} ${d.modele} ${d.annee}`).catch(() => {});
      return;
    }

    save(from, 'FORMULE_SELECT', { couleur });
    return sendButtons(from, 'Quelle formule souhaitez-vous ? 📦', [
      { id: 'FORM_PORT',    title: '⚓ Livré au Port' },
      { id: 'FORM_DEDOUAN', title: 'Dédouané tout inclus' },
    ]);
  } catch (err) {
    console.error('[client_bot] couleur check error:', err.message);
    save(from, 'FORMULE_SELECT', { couleur });
    return sendButtons(from, 'Quelle formule souhaitez-vous ? 📦', [
      { id: 'FORM_PORT',    title: '⚓ Livré au Port' },
      { id: 'FORM_DEDOUAN', title: 'Dédouané tout inclus' },
    ]);
  }
}

// ─── PHASE 5D — FORMULE ──────────────────────────────────────────────────────
async function doFormuleSelect(from, choiceId, session) {
  save(from, 'PRENOM_INPUT', { formule: choiceId === 'FORM_PORT' ? 'PORT' : 'DEDOUAN' });
  return sendText(from, 'Parfait ! 🎉 Pour préparer votre devis, j\'ai besoin de quelques informations.\n\nVotre *prénom* ?');
}

// ─── PHASE 6 — IDENTITÉ ──────────────────────────────────────────────────────
async function doPrenomInput(from, text, session) {
  if (!text || text.length < 2) return sendText(from, 'Merci d\'entrer votre *prénom* :');
  save(from, 'NOM_INPUT', { prenom: text });
  return sendText(from, 'Votre *nom de famille* ?');
}

async function doNomInput(from, text, session) {
  if (!text || text.length < 2) return sendText(from, 'Merci d\'entrer votre *nom* :');
  save(from, 'COMMUNE_INPUT', { nom: text });
  return sendText(from, 'Dans quelle *commune* habitez-vous ?\n_(pour vous assigner le notaire le plus proche)_');
}

async function doCommuneInput(from, text, session) {
  if (!text) return sendText(from, 'Quelle est votre commune ?');

  let info = { commune_normalisee: text, wilaya: '', zone: 'INCONNUE' };
  try { info = await normalizeCommune(text); } catch {}

  save(from, 'EMAIL_INPUT', {
    commune: text, commune_norm: info.commune_normalisee,
    wilaya: info.wilaya, zone: info.zone,
  });
  return sendText(from, 'Votre *adresse email* ?\n_(pour recevoir vos documents PDF)_');
}

async function doEmailInput(from, text, session) {
  if (!text || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return sendText(from, '⚠️ Email incorrect. Exemple : prenom@gmail.com');
  }

  save(from, 'CALCULATING', { email: text });
  await sendText(from, '⏳ Génération de votre devis personnalisé...');

  const d = sessions.get(from).data;

  try {
    const result = await selectBestSourceur(
      d.modele,
      d.finition || null,
      d.boite || null,
      d.couleur || null,
      d.marque || null,
      d.annee  || null,
    );

    if (result.status === 'NO_STOCK') {
      save(from, 'MENU');
      return sendText(from, '😔 Ce véhicule vient d\'être réservé.\nNous vous recontactons dès qu\'un nouveau stock arrive.');
    }

    const devis = await calculateDevis(result.sourceur, d.modele, d.commune_norm || d.commune);
    const ref   = genRef();
    const isPort = d.formule === 'PORT';
    const total  = isPort ? devis.total_livre_au_port : devis.total_dedouane;

    const devisText =
      `━━━━━━━━━━━━━━━━━━━\n` +
      `📄 *DEVIS ${ref}*\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `🚗 ${d.marque || d.h?.marque || ''} ${d.modele} ${d.annee || d.h?.annee || ''}\n` +
      `🎨 ${d.couleur || 'Au choix'} · ⚙️ ${d.boite || 'Au choix'}\n` +
      `📦 Formule : *${isPort ? 'Livré au Port' : 'Dédouané'}*\n\n` +
      `💰 Prix véhicule : *${fmt(devis.prix_vehicule_affiche)}*\n` +
      `   _(inclut transport, admin, assurance)_\n` +
      `🏛️ Frais notaire : ${fmt(devis.frais_notaire)}\n` +
      (isPort ? '' :
        `\n🛃 Droits douane ~${fmt(devis.droits_douane)} _(approximatifs)_\n` +
        `📦 Dégroupage + transitaire : ${fmt(devis.cout_degroupage_da + devis.cout_transitaire_da)}\n`) +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `✅ *TOTAL : ${fmt(total)}*\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `🔐 Votre argent sécurisé par notaire jusqu'à réception.\n` +
      `_Valable 7 jours · Réf : ${ref}_`;

    await sendText(from, devisText);
    save(from, 'DEVIS_CONFIRM', {
      ref, devis,
      sourceur_id: result.sourceur.sourceur_id,
      total_port: devis.total_livre_au_port,
      total_dedouane: devis.total_dedouane,
      total_affiche: total,
      notaire_info: devis.notaire_info,
    });

    return sendButtons(from, 'Que souhaitez-vous faire ?', [
      { id: 'DEVIS_OK',   title: '✅ Je confirme' },
      { id: 'DEVIS_EDIT', title: '🔄 Modifier' },
      { id: 'DEVIS_HELP', title: '❓ Une question' },
    ]);

  } catch (err) {
    console.error('[client_bot] devis error:', err.message);
    save(from, 'MENU');
    await sendText(from, '⚠️ Erreur lors du calcul. Notre équipe vous contacte sous 24h.');
    await sendText(COURTIER, `⚠️ ERREUR DEVIS\nNuméro: ${from}\n${d.prenom} ${d.nom}\nErreur: ${err.message}`);
  }
}

// ─── PHASE 8 — CONFIRMATION DEVIS ────────────────────────────────────────────
async function doDevisConfirm(from, choiceId, session) {
  if (choiceId === 'DEVIS_EDIT') {
    save(from, 'VEHICULE_INPUT');
    return sendText(from, 'Redécrivez le véhicule souhaité :');
  }
  if (choiceId === 'DEVIS_HELP') {
    save(from, 'DONE');
    await sendText(from, 'Notre conseiller vous rappelle pour répondre à vos questions. 📞');
    await sendText(COURTIER, `❓ QUESTION CLIENT\nwa.me/${from}\n${session.data.prenom} ${session.data.nom} — ${session.data.ref || '(devis non confirmé)'}`);
    return;
  }

  const d = session.data;
  let dossierRecord;
  try {
    dossierRecord = await atCreate(TBL_DOS, {
      reference_dossier:       d.ref,
      telephone:               from,
      prenom:                  d.prenom,
      nom:                     d.nom,
      commune:                 d.commune_norm || d.commune,
      wilaya:                  d.wilaya,
      zone:                    d.zone,
      email:                   d.email,
      modele:                  d.modele,
      marque:                  d.marque || d.h?.marque,
      annee:                   d.annee  || d.h?.annee,
      finition:                d.variante?.finition || d.finition,
      boite_vitesse:           d.boite,
      couleur:                 d.couleur,
      formule:                 d.formule,
      sourceur_assigne:        d.sourceur_id,
      prix_vehicule_affiche:   d.devis?.prix_vehicule_affiche,
      frais_notaire:           d.devis?.frais_notaire,
      total_livre_au_port:     d.total_port,
      total_dedouane:          d.total_dedouane,
      total_affiche:           d.total_affiche,
      statut:                  'CONTRAT_ENVOYE',
      timestamp_devis_confirme: new Date().toISOString(),
      notaire_nom:             d.notaire_info?.nom_notaire || '',
      notaire_adresse:         d.notaire_info?.adresse || '',
    });
  } catch (err) {
    console.error('[client_bot] create dossier error:', err.message);
  }

  save(from, 'CONTRAT_SIGN', { dossier_id: dossierRecord?.id });

  await sendText(from,
    `✅ *Commande enregistrée ! Réf : ${d.ref}*\n\n` +
    `📄 *Votre contrat de vente DjazairAuto*\n\n` +
    `• Véhicule : ${d.marque || d.h?.marque || ''} ${d.modele} ${d.annee || d.h?.annee || ''}\n` +
    `• Montant total : *${fmt(d.total_affiche)}*\n` +
    `• Sécurisation par notaire ✅\n` +
    `• Argent libéré uniquement après preuves d'achat à votre nom 🔐\n\n` +
    `_Lisez attentivement avant de signer._`
  );

  return sendButtons(from, 'Acceptez-vous les conditions du contrat ?', [
    { id: 'SIGN_OK',   title: '✅ Signer le contrat' },
    { id: 'SIGN_HELP', title: '❓ J\'ai une question' },
  ]);
}

// ─── PHASE 9 — CONTRAT ───────────────────────────────────────────────────────
async function doContratSign(from, choiceId, session) {
  if (choiceId === 'SIGN_HELP') {
    await sendText(from, 'Notre conseiller vous appelle dans les prochaines minutes. 📞');
    await sendText(COURTIER, `❓ QUESTION CONTRAT\nwa.me/${from}\n${session.data.prenom} ${session.data.nom} — Réf: ${session.data.ref}`);
    return;
  }

  const { dossier_id } = session.data;
  if (dossier_id) atPatch(TBL_DOS, dossier_id, { statut: 'CONTRAT_SIGNE', timestamp_signature: new Date().toISOString() }).catch(() => {});

  save(from, 'CNI_RECTO');
  return sendText(from,
    '✅ *Contrat signé !*\n\n' +
    'Pour préparer votre dossier notarial, j\'ai besoin de votre pièce d\'identité.\n\n' +
    '📸 Envoyez une photo du *recto de votre CNI*.\n\n' +
    '💡 Conseils : bonne lumière · pièce bien à plat · pas de reflet'
  );
}

// ─── PHASE 10 — CNI RECTO ────────────────────────────────────────────────────
async function doCniRecto(from, type, mediaId, session) {
  if (type !== 'image') {
    return sendText(from,
      '📸 Envoyez une *photo* du recto de votre CNI.\n\n' +
      '💡 Bonne lumière · pièce bien à plat · pas de reflet'
    );
  }

  const d     = session.data;
  const tries = (d.cni_recto_tries || 0) + 1;

  if (tries > MAX_CNI_TRIES) {
    save(from, 'DONE');
    await sendText(from, '⚠️ Nous ne parvenons pas à lire votre CNI. Notre équipe vous contacte pour vous aider. 📞');
    await sendText(COURTIER, `🟠 CNI ILLISIBLE — Vérif manuelle\nwa.me/${from}\n${d.prenom} ${d.nom} — Réf: ${d.ref}`);
    return;
  }

  await sendText(from, '🔍 Vérification en cours...');
  const base64 = await downloadMedia(mediaId);

  let result;
  try { result = await verifyCNI(base64, `${d.prenom} ${d.nom}`, 'recto'); }
  catch { result = { valide: false, cas: 'ERREUR' }; }

  if (!result.valide) {
    save(from, 'CNI_RECTO', { cni_recto_tries: tries });
    const msg =
      result.cas === 'EXPIRE'       ? '⚠️ Votre CNI est expirée. Merci de contacter notre équipe.' :
      result.cas === 'NOM_MISMATCH' ? '⚠️ Le nom sur la CNI ne correspond pas. Vérifiez que vous envoyez votre propre pièce d\'identité.' :
      `⚠️ Photo non lisible (tentative ${tries}/${MAX_CNI_TRIES}).\n\n💡 Bonne lumière · pièce à plat · pas de reflet`;
    return sendText(from, msg);
  }

  save(from, 'CNI_VERSO_WAIT', { cni_recto_ok: true, cni_recto_media: mediaId, cni_recto_tries: tries });
  if (d.dossier_id) atPatch(TBL_DOS, d.dossier_id, { rdv_notaire_statut: 'CNI_RECTO_RECU', cni_recto_media_id: mediaId }).catch(() => {});

  return sendButtons(from, '✅ *Recto validé !*\n\nMaintenant envoyez le *verso* de votre CNI.', [
    { id: 'CNI_VERSO_READY', title: '📷 Envoyer le verso' },
  ]);
}

// ─── CNI VERSO ───────────────────────────────────────────────────────────────
async function doCniVersoWait(from, type, mediaId, session) {
  if (type === 'interactive') return sendText(from, '📸 Envoyez la photo du *verso* de votre CNI maintenant.');
  if (type !== 'image')       return sendText(from, '📸 Envoyez une *photo* du verso de votre CNI.');

  const d     = session.data;
  const tries = (d.cni_verso_tries || 0) + 1;

  if (tries > MAX_CNI_TRIES) {
    save(from, 'DONE');
    await sendText(from, '⚠️ Nous allons vous contacter pour vous aider. 📞');
    await sendText(COURTIER, `🟠 CNI VERSO ILLISIBLE\nwa.me/${from}\n${d.prenom} ${d.nom} — Réf: ${d.ref}`);
    return;
  }

  await sendText(from, '🔍 Vérification en cours...');
  const base64 = await downloadMedia(mediaId);

  let result;
  try { result = await verifyCNI(base64, `${d.prenom} ${d.nom}`, 'verso'); }
  catch { result = { valide: false, cas: 'ERREUR' }; }

  if (!result.valide) {
    save(from, 'CNI_VERSO_WAIT', { cni_verso_tries: tries });
    return sendText(from, `⚠️ Photo non lisible (tentative ${tries}/${MAX_CNI_TRIES}).\n\nRenvoyez le verso en meilleure qualité.`);
  }

  save(from, 'RDV_SELECT', { cni_valide: true, cni_verso_media: mediaId });
  if (d.dossier_id) atPatch(TBL_DOS, d.dossier_id, { statut: 'CNI_VALIDEE', rdv_notaire_statut: 'DOCUMENTS_ATTENTE', cni_verso_media_id: mediaId, cni_valide: true }).catch(() => {});

  await sendText(from, '✅ *CNI validée !*\n\n📅 Je recherche les créneaux disponibles chez votre notaire...');
  return sendRdvSlots(from);
}

// ─── PHASE 11 — RDV NOTAIRE ──────────────────────────────────────────────────
async function sendRdvSlots(from) {
  const session = sessions.get(from);
  const d = session?.data || {};
  const zone = d.zone || 'EST_CENTRE';

  let notaire = d.notaire_info;
  if (!notaire?.nom_notaire) {
    try {
      const filter = zone === 'INCONNUE' ? `{actif}=TRUE()` : `AND({zone}="${zone}",{actif}=TRUE())`;
      const data = await atGet(TBL_NOT, { filterByFormula: filter, maxRecords: 1 });
      if (data.records?.length) notaire = { ...data.records[0].fields, id: data.records[0].id };
    } catch {}
  }

  if (!notaire?.nom_notaire) {
    save(from, 'DONE');
    await sendText(from, '📅 Notre équipe va vous planifier un RDV chez le notaire et vous recontacte rapidement !');
    await sendText(COURTIER, `📅 RDV MANUEL REQUIS\nwa.me/${from}\n${d.prenom} ${d.nom} — Zone: ${zone} — Réf: ${d.ref}`);
    return;
  }

  save(from, 'RDV_SELECT', { notaire_info: notaire });
  const slots = await computeSlots(notaire);

  if (!slots.length) {
    save(from, 'DONE');
    await sendText(from, '😔 Aucun créneau disponible cette semaine. Notre équipe vous contacte.');
    await sendText(COURTIER, `📅 AUCUN CRÉNEAU\nwa.me/${from}\n${d.prenom} ${d.nom} — Zone: ${zone}`);
    return;
  }

  save(from, 'RDV_SELECT', { rdv_slots: slots });
  const montant = fmt(d.total_affiche || d.total_port || 0);

  return sendButtons(from,
    `📅 *Votre RDV chez Maître ${notaire.nom_notaire}*\n` +
    `📍 ${notaire.adresse || ''}\n\n` +
    `💰 Préparez : *${montant} en espèces* + CNI originale\n\n` +
    `Choisissez votre créneau :`,
    slots.slice(0, 3).map((s, i) => ({ id: `RDV_${i}`, title: `📅 ${s.label}`.slice(0, 20) }))
  );
}

async function computeSlots(notaire) {
  const jours = (notaire.jours_reception || 'Lundi,Mercredi,Jeudi').split(',').map(j => j.trim());
  const heure = notaire.heure_rdv_defaut || '10:00';
  const capa  = Number(notaire.capacite_rdv_par_jour || 3);

  const counts = {};
  try {
    const data = await atGet(TBL_DOS, {
      filterByFormula: `AND({notaire_id}="${notaire.id}",{rdv_notaire_statut}="CONFIRME")`,
      fields: JSON.stringify(['rdv_notaire_date']),
    });
    for (const r of data.records || []) {
      const dt = r.fields.rdv_notaire_date;
      if (dt) counts[dt] = (counts[dt] || 0) + 1;
    }
  } catch {}

  const DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const slots = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() + 1);

  for (let i = 0; i < 30 && slots.length < 3; i++) {
    if (jours.includes(DAYS[cursor.getDay()])) {
      const dateStr = cursor.toISOString().split('T')[0];
      if ((counts[dateStr] || 0) < capa) {
        slots.push({
          date: dateStr, heure,
          label: cursor.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }),
          full:  `${cursor.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${heure}`,
        });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}

async function doRdvSelect(from, choiceId, session) {
  const idx   = parseInt(choiceId.replace('RDV_', ''));
  const d     = session.data;
  const slot  = d.rdv_slots?.[idx];
  const notaire = d.notaire_info;

  if (!slot) return sendText(from, 'Créneau non trouvé. Tapez *menu* pour recommencer.');

  const montant = fmt(d.total_affiche || d.total_port || 0);

  if (d.dossier_id) {
    atPatch(TBL_DOS, d.dossier_id, {
      rdv_notaire_date:    slot.date,
      rdv_notaire_statut: 'CONFIRME',
      statut:             'RDV_CONFIRME',
      notaire_id:         notaire?.id || '',
    }).catch(() => {});
  }

  save(from, 'DEPOT_ATTENTE', {
    rdv_date: slot.date, rdv_heure: slot.heure, rdv_label: slot.full,
    depot_client_confirme: false, depot_notaire_confirme: false,
  });

  // Confirmation client
  await sendText(from,
    `✅ *RDV confirmé !*\n\n` +
    `📅 ${slot.full}\n` +
    `👤 Maître ${notaire?.nom_notaire || 'le notaire'}\n` +
    `📍 ${notaire?.adresse || ''}\n\n` +
    `💰 Préparez : *${montant} en espèces* + CNI originale\n\n` +
    `🔔 Rappel automatique J-2 et J-1.\n\n` +
    `_Lors du RDV, remettez les fonds au notaire. Il vous remettra une *Reconnaissance de Dette* signée._\n\n` +
    `📸 Après le RDV, envoyez-moi une photo de ce reçu.`
  );

  // Notification notaire
  const notaireTel = notaire?.telephone || NOTAIRE_NUM;
  if (notaireTel) {
    sendButtons(notaireTel,
      `📅 *NOUVEAU RDV — ${d.ref}*\n\n` +
      `Client  : ${d.prenom} ${d.nom}\n` +
      `Date    : ${slot.full}\n` +
      `Montant : ${montant}\n` +
      `CNI     : ✅ Vérifiée`,
      [
        { id: `NOTAIRE_OK_${d.dossier_id}`, title: '✅ RDV confirmé' },
        { id: `NOTAIRE_RPT_${d.dossier_id}`, title: '❌ Reporter' },
      ]
    ).catch(err => console.error('[client_bot] notaire notif:', err.message));
  }

  // Click-to-Call courtier
  await sendText(COURTIER,
    `📞 APPEL REQUIS — ${d.ref}\n` +
    `Raison  : RDV notaire planifié — Accompagner + rassurer\n` +
    `Client  : ${d.prenom} ${d.nom}\n` +
    `📱 wa.me/${from}\n` +
    `RDV     : ${slot.full}\n` +
    `Montant : ${montant}`
  );
}

// ─── PHASE 13 — DÉPÔT (DOUBLE REÇU) ─────────────────────────────────────────
async function doDepotAttente(from, type, mediaId, session) {
  const d = session.data;

  if (d.depot_client_confirme) {
    return sendText(from, '✅ Nous avons déjà reçu votre reçu. En attente de confirmation du notaire. Merci de votre patience !');
  }

  if (type !== 'image') {
    return sendText(from,
      '📸 Après votre RDV, envoyez-moi une *photo de la Reconnaissance de Dette* (reçu signé par le notaire).'
    );
  }

  await sendText(from, '🔍 Vérification de votre reçu...');
  save(from, 'DEPOT_ATTENTE', { depot_client_confirme: true, depot_client_media: mediaId });

  if (d.dossier_id) atPatch(TBL_DOS, d.dossier_id, { depot_recu_client: true, depot_client_media_id: mediaId }).catch(() => {});

  await sendText(from,
    '✅ *Reçu reçu !*\n\nNous attendons la confirmation du notaire.\nVous serez notifié dès que tout est validé. 🔐'
  );

  await checkDepotComplet(from);
}

async function checkDepotComplet(from) {
  const s = sessions.get(from);
  if (!s) return;
  const d = s.data;
  if (!d.depot_client_confirme || !d.depot_notaire_confirme) return;

  save(from, 'DONE');
  const montant = fmt(d.total_affiche || d.total_port || 0);

  await sendText(from,
    `🎉 *${d.prenom}, c'est officiel !*\n\n` +
    `✅ ${montant} sécurisés chez le notaire\n` +
    `✅ Reconnaissance de Dette signée\n` +
    `✅ Votre ${d.modele || 'véhicule'} est en file d'attente\n` +
    `Référence : *${d.ref}*\n\n` +
    `Votre argent ne bougera pas sans preuve d'achat à votre nom. 🔐`
  );

  if (d.dossier_id) {
    atPatch(TBL_DOS, d.dossier_id, { statut: 'DEPOT_CONFIRME', timestamp_confirmation_depot: new Date().toISOString() })
      .then(() => assignSourceur(d.dossier_id))
      .catch(err => console.error('[client_bot] depot->assigner error:', err.message));
  }

  await sendText(COURTIER,
    `💰 DÉPÔT CONFIRMÉ — ${d.ref}\n` +
    `Client + Notaire ont tous les deux confirmé.\n` +
    `Client  : ${d.prenom} ${d.nom} — wa.me/${from}\n` +
    `Montant : ${montant}\n` +
    `✅ Sourceur activé automatiquement.`
  );
}

// ─── NOTAIRE BUTTON REPLIES ───────────────────────────────────────────────────
async function handleNotaireReply(notairePhone, buttonId) {
  if (buttonId.startsWith('NOTAIRE_OK_')) {
    const dossier_id = buttonId.replace('NOTAIRE_OK_', '');
    await sendText(notairePhone, '✅ Confirmation enregistrée. Merci !').catch(() => {});
    try {
      await atPatch(TBL_DOS, dossier_id, { depot_recu_notaire: true, notaire_confirme_depot_j1: true });
      const rec = await atFetch(TBL_DOS, dossier_id);
      const f = rec.fields || {};

      // Decrement stock ONLY here — notaire confirmed receipt
      if (f.sourceur_id_utilise && f.modele) {
        decrementStock(f.sourceur_id_utilise, f.marque, f.modele, f.annee, f.finition, f.boite_vitesse, f.couleur)
          .catch(err => console.error('[client_bot] decrementStock:', err.message));
      }

      const clientPhone = f.telephone;
      if (clientPhone) {
        save(clientPhone, 'DEPOT_ATTENTE', { depot_notaire_confirme: true });
        await checkDepotComplet(clientPhone);
      }
    } catch (err) {
      console.error('[client_bot] notaire confirm error:', err.message);
    }

  } else if (buttonId.startsWith('NOTAIRE_RPT_')) {
    const dossier_id = buttonId.replace('NOTAIRE_RPT_', '');
    await sendText(notairePhone, '📝 Reporter enregistré. Notre équipe replanifie.').catch(() => {});
    await sendText(COURTIER, `⚠️ NOTAIRE A REPORTÉ\nDossier: ${dossier_id}\nNotaire: ${notairePhone}`).catch(() => {});
  }
}

// ─── SUIVI DOSSIER ────────────────────────────────────────────────────────────
async function doSuivi(from) {
  try {
    const data = await atGet(TBL_DOS, {
      filterByFormula: `{telephone}="${from}"`,
      maxRecords: 1,
      sort: JSON.stringify([{ field: 'timestamp_devis_confirme', direction: 'desc' }]),
      fields: JSON.stringify(['reference_dossier', 'statut', 'modele', 'marque', 'annee', 'rdv_notaire_date']),
    });

    if (!data.records?.length) {
      save(from, 'MENU');
      return sendButtons(from,
        '❌ Aucun dossier trouvé pour ce numéro.\n\nVoulez-vous démarrer un nouveau projet ?',
        [
          { id: 'MENU_PROJET', title: '🚗 Nouveau projet' },
          { id: 'MENU_AGENT',  title: '👤 Un conseiller' },
        ]
      );
    }

    const f = data.records[0].fields;
    const rdvLine = f.rdv_notaire_date
      ? `📅 RDV : ${new Date(f.rdv_notaire_date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}\n`
      : '';

    save(from, 'MENU');
    return sendButtons(from,
      `📋 *Dossier ${f.reference_dossier}*\n\n` +
      `🚗 ${f.marque || ''} ${f.modele || ''} ${f.annee || ''}\n` +
      `${STATUTS[f.statut] || `📋 ${f.statut}`}\n${rdvLine}\n` +
      `Réf : ${f.reference_dossier}`,
      [
        { id: 'MENU_AGENT',  title: '👤 Un conseiller' },
        { id: 'MENU_PROJET', title: '🚗 Nouveau projet' },
      ]
    );
  } catch {
    save(from, 'MENU');
    return sendMenu(from);
  }
}

const STATUTS = {
  DEVIS_ENVOYE:     '⏳ Devis en attente de confirmation',
  CONTRAT_ENVOYE:   '📄 Contrat en attente de signature',
  CONTRAT_SIGNE:    '✅ Contrat signé — dossier en cours',
  CNI_VALIDEE:      '🪪 CNI validée — RDV notaire à planifier',
  RDV_CONFIRME:     '📅 RDV notaire confirmé',
  DEPOT_CONFIRME:   '💰 Dépôt sécurisé — sourceur en cours',
  SOURCEUR_ASSIGNE: '🔍 Véhicule en recherche',
  DOCUMENTS_RECUS:  '📄 Documents vérifiés — embarquement prévu',
  EN_TRANSIT:       '🚢 En mer — transit en cours',
  NAVIRE_ARRIVE:    '⚓ Au port d\'Alger',
  CLOTURE:          '🎊 Livré ! Merci de votre confiance',
};
