import 'dotenv/config';
import express from 'express';
import { sendText, sendButtons, sendList, sendDocument } from '../lib/whatsapp.js';
import { generateDevis } from '../lib/devis.js';
import { verifyCNI }    from '../lib/cni_verifier.js';
import { handleSourceurMessage, isKnownSourceur } from '../lib/sourceur_bot.js';
import { handleClientMessage } from '../lib/client_bot.js';
import { upsertPrixSourceur, recalculateBestPrices, getSourceurLeaderboard, getVehicleComparatif, checkAndIncrementVolume } from '../lib/prix_engine.js';
import { parseAndValidateCatalogue } from '../lib/catalogue_parser.js';
import { runPenaltiesCheck } from '../lib/penalites.js';
import { confirmLiberation70, confirmLiberation30, sendWeeklyTransitUpdates, triggerPortArrivee } from '../lib/liberation.js';
import { runGratitudeSequence, handleGratitudeReply } from '../lib/gratitude.js';
import { confirmAnnulationApresDepot } from '../lib/annulation.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT              = process.env.PORT                   || 3001;
const VERIFY_TOKEN      = process.env.WHATSAPP_VERIFY_TOKEN;
const MAKE_WEBHOOK_URL  = process.env.MAKE_WEBHOOK_URL;
const MAKE_CNI_WEBHOOK  = process.env.MAKE_CNI_WEBHOOK_URL;
const AIRTABLE_API_KEY  = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_DOSSIERS = process.env.AIRTABLE_DOSSIERS_TABLE_ID || 'tblxe9U9z69mkR5s3';
const AIRTABLE_SOURCEURS = process.env.AIRTABLE_SOURCEURS_TABLE  || 'tblGeoLTGnBKhlAsK';

// Dedicated WhatsApp phone number ID for suppliers (separate from client line)
// Guard: if set to the same value as the main bot ID, treat as unset to avoid routing everyone to sourceur bot
const MAIN_PHONE_ID     = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const _RAW_SOURCEUR_ID  = process.env.WHATSAPP_SOURCEUR_PHONE_NUMBER_ID || '';
const SOURCEUR_PHONE_ID = (_RAW_SOURCEUR_ID && _RAW_SOURCEUR_ID !== MAIN_PHONE_ID) ? _RAW_SOURCEUR_ID : '';

// Hardcoded known sourceur numbers (fallback whitelist, comma-separated in env)
const SOURCEUR_NUMBERS = (process.env.SOURCEUR_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);

// ─── Meta media download ─────────────────────────────────────────────────────
async function downloadMetaImage(mediaId) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const meta = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meta.ok) return null;
    const { url } = await meta.json();
    const img = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!img.ok) return null;
    const buf = await img.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  } catch {
    return null;
  }
}

// ─── Airtable helper ─────────────────────────────────────────────────────────
async function getDossierByPhone(phone) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return null;
  const raw  = String(phone ?? '').replace(/\D/g, '');
  const norm = raw.startsWith('213') ? raw : raw.startsWith('0') ? '213' + raw.slice(1) : '213' + raw;
  const url  = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_DOSSIERS}`
    + `?filterByFormula=${encodeURIComponent(`OR(telephone="${norm}",telephone="0${norm.slice(3)}")`)}`
    + `&maxRecords=1&fields[]=telephone&fields[]=rdv_notaire_statut&fields[]=nom&fields[]=reference_dossier`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    if (!res.ok) return null;
    const data = await res.json();
    return data.records?.[0] ?? null;
  } catch {
    return null;
  }
}

// ─── Meta webhook verification ───────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Receive WhatsApp messages ────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately (Meta requires < 5s)

  try {
    const entry   = req.body?.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from         = message.from;
    const type         = message.type;
    const phoneNumberId = value?.metadata?.phone_number_id ?? '';
    const payload      = { from, type };

    if (type === 'text') {
      payload.text = message.text.body;
    } else if (type === 'interactive') {
      const interactive = message.interactive;
      if (interactive.type === 'button_reply') {
        payload.button_reply = {
          id:    interactive.button_reply.id,
          title: interactive.button_reply.title,
        };
      } else if (interactive.type === 'list_reply') {
        payload.list_reply = {
          id:          interactive.list_reply.id,
          title:       interactive.list_reply.title,
          description: interactive.list_reply.description,
        };
      }
    } else if (['image', 'document', 'video'].includes(type)) {
      payload.media = {
        mime_type: message[type].mime_type,
        id:        message[type].id,
        caption:   message[type].caption,
        filename:  message[type].filename,
      };
    }

    // ── Global button routing (courtier + client callbacks) ──────────────────
    const bid = payload.button_reply?.id || '';
    if (bid.startsWith('LIB70_')) {
      await confirmLiberation70(bid);
      return;
    }
    if (bid.startsWith('LIB30_')) {
      await confirmLiberation30(bid);
      return;
    }
    if (bid.startsWith('ANNUL_CONFIRM_') || bid.startsWith('ANNUL_CANCEL_')) {
      await confirmAnnulationApresDepot(from, bid);
      return;
    }
    if (bid.startsWith('NOTE_') || bid.startsWith('AMB_')) {
      await handleGratitudeReply(from, bid);
      return;
    }
    if (bid.startsWith('PENALITE_')) {
      await sendText(process.env.COURTIER_WHATSAPP_NUMBER || '33760469653',
        `📋 Action pénalité reçue : ${bid}\nÀ traiter manuellement.`
      );
      return;
    }

    // ── Routing: sourceur line or known sourceur phone ────────────────────────
    const onSourceurLine = SOURCEUR_PHONE_ID && phoneNumberId === SOURCEUR_PHONE_ID;
    const inWhitelist    = SOURCEUR_NUMBERS.includes(from);

    console.log(`[routing] from=${from} onSourceurLine=${onSourceurLine} inWhitelist=${inWhitelist} whitelist=${JSON.stringify(SOURCEUR_NUMBERS)}`);

    if (onSourceurLine || inWhitelist || await isKnownSourceur(from)) {
      console.log(`[routing] → sourceur bot`);
      await handleSourceurMessage(payload);
      return;
    }

    // All non-sourceur messages → client bot (Railway-native, no Make.com)
    console.log(`[routing] → client bot`);
    await handleClientMessage(payload);
  } catch (err) {
    console.error('Webhook forward error:', err.message);
  }
});

// ─── Make.com → send WhatsApp message ────────────────────────────────────────
app.post('/make-trigger', async (req, res) => {
  const { to, type, ...params } = req.body;

  if (!to || !type) {
    return res.status(400).json({ error: 'Missing to or type' });
  }

  try {
    let result;

    switch (type) {
      case 'text':
        result = await sendText(to, params.text);
        break;
      case 'buttons':
        result = await sendButtons(to, params.text, params.buttons);
        break;
      case 'list':
        result = await sendList(to, params.text, params.button_title, params.sections);
        break;
      case 'document':
        result = await sendDocument(to, params.url, params.filename, params.caption);
        break;
      default:
        return res.status(400).json({ error: `Unknown type: ${type}` });
    }

    res.json({ success: true, result });
  } catch (err) {
    console.error('make-trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Pricing — generate + send a devis ───────────────────────────────────────
app.post('/api/pricing/devis', async (req, res) => {
  const { telephone, dossier_id, formule } = req.body;

  if (!telephone || !dossier_id || !formule) {
    return res.status(400).json({ error: 'Missing telephone, dossier_id or formule' });
  }

  try {
    const result = await generateDevis(telephone, dossier_id, formule, req.body.remise_da ?? 0);
    res.json(result);
  } catch (err) {
    console.error('Devis generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── CNI verification — Make.com calls this with image base64 + nomAttendu ───
// Body: { image_base64: string, nom_attendu: string, side: 'recto'|'verso' }
app.post('/api/cni/verify', async (req, res) => {
  const { image_base64, nom_attendu, side } = req.body;

  if (!image_base64) {
    return res.status(400).json({ error: 'Missing image_base64' });
  }

  try {
    const result = await verifyCNI(image_base64, nom_attendu, side ?? 'recto');
    res.json(result);
  } catch (err) {
    console.error('CNI verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── CNI confirmed — fetch notaire details and send to client ────────────────
// Body: { dossier_id, telephone, nom_client }
app.post('/api/cni/confirmed', async (req, res) => {
  res.json({ success: true }); // ack immediately

  const { dossier_id, telephone, nom_client } = req.body;
  if (!dossier_id || !telephone) return;

  try {
    const atUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_DOSSIERS}/${dossier_id}`
      + `?fields[]=notaire_nom&fields[]=notaire_adresse&fields[]=rdv_notaire_date`
      + `&fields[]=reference_dossier&fields[]=prenom&fields[]=nom`;
    const atRes  = await fetch(atUrl, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    const record = atRes.ok ? await atRes.json() : { fields: {} };
    const f      = record.fields ?? {};

    const notaireNom     = f.notaire_nom      ?? '';
    const notaireAdresse = f.notaire_adresse  ?? '';
    const rdvDate        = f.rdv_notaire_date ?? '';
    const reference      = f.reference_dossier ?? '';
    const clientName     = nom_client || `${f.prenom ?? ''} ${f.nom ?? ''}`.trim();

    let msg = `🎉 Félicitations ${clientName} !\n\nVotre identité a été vérifiée avec succès ✅\n\n`;

    if (notaireNom || rdvDate) {
      msg += `━━━━━━━━━━━━━━━━━━━\n📋 *Votre RDV Notaire*\n\n`;
      if (notaireNom)     msg += `👤 *Notaire :* ${notaireNom}\n`;
      if (notaireAdresse) msg += `📍 *Adresse :* ${notaireAdresse}\n`;
      if (rdvDate) {
        const d = new Date(rdvDate);
        msg += `📅 *Date :* ${d.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`;
      }
      if (reference) msg += `\n🚗 *Dossier :* ${reference}`;
      msg += `\n\n⚠️ _Merci d'apporter votre CNI originale le jour du rendez-vous._`;
    } else {
      msg += `Notre équipe vous contactera très prochainement pour les détails de votre RDV notaire.`;
      if (reference) msg += `\n\n🚗 *Dossier :* ${reference}`;
    }

    await sendText(telephone, msg);
  } catch (err) {
    console.error('cni/confirmed error:', err.message);
  }
});

// ─── Sourceur REST API ────────────────────────────────────────────────────────

async function authenticateSourceur(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_SOURCEURS}`
      + `?filterByFormula=${encodeURIComponent(`{api_token}="${token}"`)}&maxRecords=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    if (!res.ok) return null;
    const data = await res.json();
    const rec  = data.records?.[0];
    if (!rec || rec.fields.statut !== 'ACTIF') return null;
    return { id: rec.id, sourceur_id: rec.fields.sourceur_id, nom: rec.fields.nom_entreprise };
  } catch { return null; }
}

// POST /api/v1/sourceurs/prices — bulk import via REST
app.post('/api/v1/sourceurs/prices', async (req, res) => {
  const sourceur = await authenticateSourceur(req);
  if (!sourceur) return res.status(401).json({ error: 'Token invalide ou inactif' });

  const { prices } = req.body;
  if (!Array.isArray(prices) || prices.length === 0) {
    return res.status(400).json({ error: 'prices[] requis et non vide' });
  }
  if (prices.length > 1000) {
    return res.status(400).json({ error: 'Maximum 1 000 entrées par import' });
  }

  // Volume limit check
  try {
    await checkAndIncrementVolume(sourceur.sourceur_id);
  } catch (volErr) {
    return res.status(429).json({ error: volErr.message });
  }

  try {
    const { valid, invalid, stats } = await parseAndValidateCatalogue(
      [
        ['marque','modele','annee','finition','boite','couleur','km','etat','pieces_modifiees','prix_usd','cif_usd','stock','delai_jours'],
        ...prices.map(p => [
          p.marque, p.modele, p.annee, p.finition, p.boite, p.couleur,
          p.km, p.etat, p.pieces_modifiees, p.prix_usd ?? p.prix_vehicule_usd,
          p.cif_usd ?? p.cif_shipping_sourceur_usd, p.stock, p.delai_jours ?? p.delai_expedition_jours,
        ]),
      ],
      'sheets'
    );

    if (valid.length > 0) {
      await upsertPrixSourceur(sourceur.sourceur_id, valid);
      await recalculateBestPrices();
    }

    return res.json({
      status:  'ok',
      imported: stats.imported,
      updated:  stats.imported,
      errors:   stats.errors,
      details:  invalid.slice(0, 10),
    });
  } catch (err) {
    console.error('REST prices error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/sourceurs/prices — list active prices for authenticated sourceur
app.get('/api/v1/sourceurs/prices', async (req, res) => {
  const sourceur = await authenticateSourceur(req);
  if (!sourceur) return res.status(401).json({ error: 'Token invalide ou inactif' });

  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/PRIX_SOURCEURS`
      + `?filterByFormula=${encodeURIComponent(`AND({sourceur_id}="${sourceur.sourceur_id}",{actif}=1)`)}`
      + `&sort[0][field]=modele&sort[0][direction]=asc`;
    const atRes = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    const data  = atRes.ok ? await atRes.json() : { records: [] };
    res.json({ prices: (data.records ?? []).map(r => ({ id: r.id, ...r.fields })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/v1/sourceurs/stats — stats for authenticated sourceur
app.get('/api/v1/sourceurs/stats', async (req, res) => {
  const sourceur = await authenticateSourceur(req);
  if (!sourceur) return res.status(401).json({ error: 'Token invalide ou inactif' });

  try {
    const lb   = await getSourceurLeaderboard();
    const mine = lb.find(e => e.sourceur_id === sourceur.sourceur_id);
    const rang = lb.findIndex(e => e.sourceur_id === sourceur.sourceur_id) + 1;

    res.json({
      sourceur_id:      sourceur.sourceur_id,
      total_stock:      mine?.total_stock ?? 0,
      nb_modeles:       mine?.nb_modeles  ?? 0,
      rang_leaderboard: rang || null,
      prix_min:         mine?.prix_min    ?? null,
      prix_max:         mine?.prix_max    ?? null,
      prix_moyen:       mine?.prix_moyen  ?? null,
      derniere_maj:     mine?.derniere_maj ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin API ────────────────────────────────────────────────────────────────

const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function isAdmin(req) {
  if (!ADMIN_SECRET) return true;
  return (req.headers['x-admin-token'] || '') === ADMIN_SECRET;
}

app.get('/api/admin/sourceurs', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_SOURCEURS}`;
    const atRes = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    const data  = atRes.ok ? await atRes.json() : { records: [] };
    const lb    = await getSourceurLeaderboard();
    const lbMap = new Map(lb.map(e => [e.sourceur_id, e]));
    const sourceurs = (data.records ?? []).map(r => ({
      id: r.id, ...r.fields,
      _lb: lbMap.get(String(r.fields.sourceur_id ?? '')) ?? null,
    }));
    res.json({ sourceurs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/sourceurs/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_SOURCEURS}/${req.params.id}`;
    const atRes = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: req.body }),
    });
    if (!atRes.ok) throw new Error(`Airtable ${atRes.status}: ${await atRes.text()}`);
    res.json(await atRes.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Cron endpoints (triggered by Railway cron or external scheduler) ─────────

const CRON_SECRET = process.env.CRON_SECRET || '';

function isCronAuthorized(req) {
  if (!CRON_SECRET) return true;
  return (req.headers['x-cron-secret'] || req.query.secret) === CRON_SECRET;
}

// Daily: pénalités J+6→J+20 + séquence gratitude J+1/J+7/J+14
app.post('/api/cron/daily', async (req, res) => {
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ status: 'started' });
  try {
    await runPenaltiesCheck();
    await runGratitudeSequence();
    console.log('[cron/daily] completed');
  } catch (err) {
    console.error('[cron/daily] error:', err.message);
  }
});

// Weekly: mise à jour transit clients
app.post('/api/cron/weekly', async (req, res) => {
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ status: 'started' });
  try {
    await sendWeeklyTransitUpdates();
    console.log('[cron/weekly] completed');
  } catch (err) {
    console.error('[cron/weekly] error:', err.message);
  }
});

// Port arrivée — triggered manually or by MarineTraffic webhook
// Body: { reference_dossier: string }
app.post('/api/cron/port-arrive', async (req, res) => {
  if (!isCronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { reference_dossier } = req.body;
  if (!reference_dossier) return res.status(400).json({ error: 'Missing reference_dossier' });
  res.json({ status: 'started', reference_dossier });
  try {
    await triggerPortArrivee(reference_dossier);
    console.log(`[cron/port-arrive] ${reference_dossier} traité`);
  } catch (err) {
    console.error('[cron/port-arrive] error:', err.message);
  }
});

// ─── Diagnostic complet ───────────────────────────────────────────────────────
app.get('/diagnostic', async (req, res) => {
  // Read directly from process.env (bypass module-level constants)
  const liveBaseId  = process.env.AIRTABLE_BASE_ID;
  const liveApiKey  = process.env.AIRTABLE_API_KEY;
  const AT_BASE = `https://api.airtable.com/v0/${liveBaseId}`;
  const TBL_PRIX = process.env.AIRTABLE_PRIX_SOURCEURS_TABLE || 'tblkosDM1HA6SbW0V';
  const out = {};

  // 1 — Variables d'environnement (process.env en temps réel, pas les constantes)
  out.env = {
    AIRTABLE_API_KEY:    liveApiKey  ? '✅' : '❌ MISSING',
    AIRTABLE_BASE_ID:    liveBaseId  ? `✅ (${liveBaseId.slice(0,6)}...)` : '❌ MISSING',
    ANTHROPIC_API_KEY:   process.env.ANTHROPIC_API_KEY   ? '✅' : '❌ MISSING',
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN ? '✅' : '❌ MISSING',
    AIRTABLE_PRIX_SOURCEURS_TABLE: process.env.AIRTABLE_PRIX_SOURCEURS_TABLE || `(défaut: ${TBL_PRIX})`,
  };

  // 2 — Connexion Airtable PRIX_SOURCEURS (sans filtre)
  try {
    const r = await fetch(`${AT_BASE}/${TBL_PRIX}?maxRecords=3`, { headers: { Authorization: `Bearer ${liveApiKey}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const recs = d.records ?? [];
    out.airtable_prix_sourceurs = {
      ok: true,
      nb_records_sample: recs.length,
      champs: recs[0] ? Object.keys(recs[0].fields) : [],
      exemple: recs[0]?.fields,
    };
  } catch (e) { out.airtable_prix_sourceurs = { ok: false, erreur: e.message }; }

  // 3 — Connexion Claude Haiku
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 30, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    out.haiku = { ok: r.ok, status: r.status, reponse: d.content?.[0]?.text };
  } catch (e) { out.haiku = { ok: false, erreur: e.message }; }

  // 4 — Recherche stock disponible (filtre actuel du bot)
  try {
    const filter = encodeURIComponent('{stock_disponible}>0');
    const r = await fetch(`${AT_BASE}/${TBL_PRIX}?filterByFormula=${filter}&maxRecords=5`, { headers: { Authorization: `Bearer ${liveApiKey}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const recs = d.records ?? [];
    out.recherche_stock = {
      ok: true,
      filtre: '{stock_disponible}>0',
      nb_resultats: recs.length,
      vehicules: recs.map(r => ({ marque: r.fields.marque, modele: r.fields.modele, annee: r.fields.annee, stock: r.fields.stock_disponible, actif: r.fields.actif })),
    };
  } catch (e) { out.recherche_stock = { ok: false, erreur: e.message }; }

  // 5 — Simulation recherche par marque/modele (paramètres ?marque=Dacia&modele=Duster)
  const testMarque = req.query.marque;
  const testModele = req.query.modele;
  if (testMarque && testModele) {
    try {
      const filter = encodeURIComponent(`AND({stock_disponible}>0,{marque}="${testMarque}",{modele}="${testModele}")`);
      const r = await fetch(`${AT_BASE}/${TBL_PRIX}?filterByFormula=${filter}&maxRecords=10`, { headers: { Authorization: `Bearer ${liveApiKey}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const d = await r.json();
      const recs = d.records ?? [];
      out[`recherche_${testMarque}_${testModele}`] = {
        ok: true,
        nb_resultats: recs.length,
        vehicules: recs.map(r => ({ marque: r.fields.marque, modele: r.fields.modele, annee: r.fields.annee, finition: r.fields.finition, stock: r.fields.stock_disponible, actif: r.fields.actif })),
      };
    } catch (e) { out[`recherche_${testMarque}_${testModele}`] = { ok: false, erreur: e.message }; }
  }

  res.json(out);
});

// ─── Debug endpoint — routing diagnosis ───────────────────────────────────────
app.get('/api/debug/routing', async (req, res) => {
  const phone = String(req.query.phone || '').trim();
  const inWhitelist = SOURCEUR_NUMBERS.includes(phone);
  const knownSourceur = phone ? await isKnownSourceur(phone).catch(() => 'error') : 'n/a';

  res.json({
    env: {
      WHATSAPP_PHONE_NUMBER_ID:          MAIN_PHONE_ID      || '(not set)',
      WHATSAPP_SOURCEUR_PHONE_NUMBER_ID:  _RAW_SOURCEUR_ID  || '(not set)',
      SOURCEUR_PHONE_ID_effective:        SOURCEUR_PHONE_ID || '(disabled)',
      SOURCEUR_WHITELIST:                 process.env.SOURCEUR_WHITELIST || '(empty)',
      AIRTABLE_BASE_ID:                   AIRTABLE_BASE_ID  ? '✅ set' : '❌ missing',
      AIRTABLE_API_KEY:                   AIRTABLE_API_KEY  ? '✅ set' : '❌ missing',
      WHATSAPP_ACCESS_TOKEN:              process.env.WHATSAPP_ACCESS_TOKEN ? '✅ set' : '❌ missing',
    },
    routing_for_phone: phone || '(no phone provided — add ?phone=33760469653)',
    inWhitelist,
    isKnownSourceur: knownSourceur,
    verdict: inWhitelist || knownSourceur === true
      ? '→ SOURCEUR BOT'
      : '→ CLIENT BOT',
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'sayara-backend', ts: new Date().toISOString() });
});

// ─── Startup env check ───────────────────────────────────────────────────────
['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'ANTHROPIC_API_KEY', 'WHATSAPP_ACCESS_TOKEN'].forEach(k => {
  if (!process.env[k]) console.error(`[STARTUP] ❌ Variable manquante: ${k}`);
  else                 console.log(`[STARTUP] ✅ ${k}`);
});

app.listen(PORT, () => {
  console.log(`SAYARA webhook server running on port ${PORT}`);
});
