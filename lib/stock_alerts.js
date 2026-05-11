// Phase stock alerts — WhatsApp notification courtier when stock ≤ 2
import { sendText } from './whatsapp.js';

const COURTIER = process.env.COURTIER_WHATSAPP_NUMBER || process.env.COURTIER_WHATSAPP || '33760469653';
const AT_BASE  = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}`;
const AT_KEY   = process.env.AIRTABLE_API_KEY;
const TBL_PRIX = process.env.AIRTABLE_PRIX_SOURCEURS_TABLE || 'tbllk5ZWO6FYlAj3p';

async function atPatch(id, fields) {
  await fetch(`${AT_BASE}/${encodeURIComponent(TBL_PRIX)}/${id}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AT_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

export async function checkAndNotifyLowStock(recordId, stock, info) {
  const label = [info.marque, info.modele, info.finition, info.couleur].filter(Boolean).join(' ');
  const emoji = stock === 1 ? '🔴' : '🟠';

  await sendText(COURTIER,
    `${emoji} *STOCK BAS — ${label}*\n\n` +
    `Stock restant : *${stock} unité${stock > 1 ? 's' : ''}*\n` +
    `Sourceur : ${info.nom_sourceur || info.sourceur_id || '—'}\n\n` +
    `Consultez le catalogue pour agir.`
  );

  await atPatch(recordId, { alerte_stock_envoyee: true });
}
