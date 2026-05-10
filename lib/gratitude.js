// Phase 20 — Séquence gratitude : notation J+1, avis J+7, ambassadeur J+14
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

function daysSince(isoDate) {
  if (!isoDate) return null;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

function genAmbassadeurCode(prenom, ref) {
  const base = (prenom || 'X').slice(0, 3).toUpperCase();
  const num  = (ref || '').replace(/[^0-9]/g, '').slice(-4);
  return `${base}${num}`;
}

// Called daily from /api/cron/daily
export async function runGratitudeSequence() {
  const data = await atGet(TBL_DOS, {
    filterByFormula: `{statut}="CLOTURE"`,
    maxRecords: 100,
  });

  for (const rec of data.records ?? []) {
    const d = rec.fields;
    const j = daysSince(d.liberation_30_date || d.date_cloture);
    if (j === null) continue;

    try {
      if (j === 1  && !d.notation_j1_envoye)  await sendNotationJ1(rec.id, d);
      if (j === 7  && !d.avis_j7_envoye)      await sendAvisJ7(rec.id, d);
      if (j === 14 && !d.ambassadeur_j14_envoye) await sendAmbassadeurJ14(rec.id, d);
    } catch (err) {
      console.error(`[gratitude] ${d.reference_dossier} J+${j}:`, err.message);
    }
  }
}

async function sendNotationJ1(dossier_id, d) {
  if (!d.telephone) return;

  await sendButtons(d.telephone,
    `🌟 *${d.prenom}, comment s'est passée votre expérience ?*\n\n` +
    `Votre ${d.marque} ${d.modele} est livré depuis hier !\n\n` +
    `Notez DjazairAuto en 1 seconde :`,
    [
      { id: `NOTE_5_${d.reference_dossier}`, title: '⭐⭐⭐⭐⭐ Excellent' },
      { id: `NOTE_4_${d.reference_dossier}`, title: '⭐⭐⭐⭐ Très bien' },
      { id: `NOTE_NEG_${d.reference_dossier}`, title: '❌ À améliorer' },
    ]
  );

  await atPatch(TBL_DOS, dossier_id, { notation_j1_envoye: true });
}

async function sendAvisJ7(dossier_id, d) {
  if (!d.telephone) return;

  await sendText(d.telephone,
    `💬 *${d.prenom}, une semaine avec votre ${d.modele} !*\n\n` +
    `Votre avis compte énormément pour nous aider à grandir.\n\n` +
    `📝 Laissez un commentaire sur Google en répondant à ce message.\n` +
    `Nous le partageons (avec votre accord) sur notre page. 🙏`
  );

  await atPatch(TBL_DOS, dossier_id, { avis_j7_envoye: true });
}

async function sendAmbassadeurJ14(dossier_id, d) {
  if (!d.telephone) return;

  const code = d.code_ambassadeur || genAmbassadeurCode(d.prenom, d.reference_dossier);

  await atPatch(TBL_DOS, dossier_id, {
    ambassadeur_j14_envoye: true,
    code_ambassadeur: code,
  });

  await sendButtons(d.telephone,
    `🎁 *Programme Ambassadeur — ${d.prenom}*\n\n` +
    `Merci de votre confiance ! En tant que client DjazairAuto, ` +
    `devenez ambassadeur et gagnez *20 000 DA* pour chaque ami importé.\n\n` +
    `Votre code unique : *${code}*\n\n` +
    `Partagez ce code à vos proches — ils bénéficient d'une réduction et vous touchez votre prime à la clôture.`,
    [
      { id: `AMB_OUI_${d.reference_dossier}`, title: '✅ Je participe !' },
      { id: `AMB_NON_${d.reference_dossier}`, title: 'Non merci' },
    ]
  );
}

// Handles notation button replies
export async function handleGratitudeReply(from, buttonId) {
  if (buttonId.startsWith('NOTE_5_') || buttonId.startsWith('NOTE_4_')) {
    const note = buttonId.startsWith('NOTE_5_') ? 5 : 4;
    const ref  = buttonId.replace(/^NOTE_[0-9]+_/, '');
    await sendText(from,
      `⭐ *Merci pour votre ${note}/5 !*\n\n` +
      `Votre satisfaction est notre plus belle récompense. 🙏\n` +
      `À bientôt pour votre prochain véhicule !`
    );
    await sendText(COURTIER, `⭐ NOTE ${note}/5 reçue — ${ref} (${from})`);
    return;
  }

  if (buttonId.startsWith('NOTE_NEG_')) {
    const ref = buttonId.replace('NOTE_NEG_', '');
    await sendText(from,
      `🙏 *Merci pour votre retour.*\n\n` +
      `Un conseiller vous contacte dans les 24h pour comprendre et améliorer. 💪`
    );
    await sendText(COURTIER,
      `⚠️ AVIS NÉGATIF — ${ref} (${from})\nIntervention requise dans les 24h.`
    );
    return;
  }

  if (buttonId.startsWith('AMB_OUI_')) {
    const ref = buttonId.replace('AMB_OUI_', '');
    await sendText(from,
      `🎉 *Bienvenue dans le programme Ambassadeur !*\n\n` +
      `Partagez votre code à vos proches.\n` +
      `Votre prime de *20 000 DA* sera versée dès la clôture de leur dossier. 🤝`
    );
    await sendText(COURTIER, `🤝 AMBASSADEUR CONFIRMÉ — ${ref} (${from})`);
    return;
  }
}
