const BASE_URL = 'https://graph.facebook.com/v18.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;

async function callAPI(body) {
  const res = await fetch(`${BASE_URL}/${PHONE_NUMBER_ID}/messages`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`WhatsApp API error: ${JSON.stringify(err)}`);
  }
  return res.json();
}

// Plain text message
export async function sendText(to, text) {
  return callAPI({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

// Interactive buttons — max 3 buttons
// buttons: [{ id: 'CONFIRM', title: 'Confirmer' }, ...]
export async function sendButtons(to, text, buttons) {
  if (buttons.length > 3) throw new Error('sendButtons: max 3 buttons');

  return callAPI({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text },
      action: {
        buttons: buttons.map(b => ({
          type:  'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

// Interactive list — max 10 rows total across all sections
// sections: [{ title: 'Section', rows: [{ id, title, description }] }]
export async function sendList(to, text, buttonTitle, sections) {
  const total = sections.reduce((acc, s) => acc + s.rows.length, 0);
  if (total > 10) throw new Error('sendList: max 10 rows total');

  return callAPI({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text },
      action: {
        button: buttonTitle,
        sections,
      },
    },
  });
}

// Template message — for proactive outbound messages
// components: standard Meta components array
export async function sendTemplate(to, templateName, lang = 'fr', components = []) {
  return callAPI({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name:       templateName,
      language:   { code: lang },
      components,
    },
  });
}

// Send document via URL
export async function sendDocument(to, url, filename, caption = '') {
  return callAPI({
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: { link: url, filename, caption },
  });
}
