import 'dotenv/config';
import express from 'express';
import { sendText, sendButtons, sendList, sendDocument } from '../lib/whatsapp.js';
import { generateDevis } from '../lib/devis.js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

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

// ─── Receive WhatsApp messages → forward to Make.com ─────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately (Meta requires < 5s)

  try {
    const entry   = req.body?.entry?.[0];
    const change  = entry?.changes?.[0];
    const value   = change?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const type = message.type;
    const payload = { from, type };

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

    await fetch(MAKE_WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (err) {
    console.error('Webhook forward error:', err.message);
  }
});

// ─── Make.com → send WhatsApp message ────────────────────────────────────────
// Make.com calls this endpoint when it needs to push a message to WhatsApp.
// Body: { to, type, ...params }
//   type = 'text'     → { text }
//   type = 'buttons'  → { text, buttons }
//   type = 'list'     → { text, button_title, sections }
//   type = 'document' → { url, filename, caption }
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

// ─── Pricing — Make.com calls this to generate + send a devis ────────────────
// Body: { telephone, dossier_id, formule }
app.post('/api/pricing/devis', async (req, res) => {
  const { telephone, dossier_id, formule } = req.body;

  if (!telephone || !dossier_id || !formule) {
    return res.status(400).json({ error: 'Missing telephone, dossier_id or formule' });
  }

  try {
    const result = await generateDevis(telephone, dossier_id, formule);
    res.json(result);
  } catch (err) {
    console.error('Devis generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check — Railway uses this ────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'sayara-backend', ts: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`SAYARA webhook server running on port ${PORT}`);
});
