// lib/catalogue_parser.js
// Parses Excel, CSV, or Google Sheets array-of-arrays into validated catalogue rows.

const COLUMN_MAP = {
  marque:                    ['marque', 'brand', 'make'],
  modele:                    ['modele', 'model', 'modèle'],
  annee:                     ['annee', 'year', 'année'],
  finition:                  ['finition', 'trim', 'version', 'grade'],
  boite_vitesse:             ['boite', 'boite_vitesse', 'transmission', 'gearbox', 'bv'],
  couleur:                   ['couleur', 'color', 'colour'],
  kilometrage:               ['km', 'kilometrage', 'kilométrage', 'mileage', 'odometer'],
  etat_vehicule:             ['etat', 'état', 'new/used', 'neuf/occasion', 'condition'],
  pieces_modifiees:          ['pieces_modifiees', 'modified', 'modified_parts'],
  prix_vehicule_usd:         ['prix_usd', 'prix', 'price', 'prix_vehicule_usd', 'price usd', 'prix usd'],
  cif_shipping_sourceur_usd: ['cif', 'cif_usd', 'shipping', 'transport', 'freight', 'fret'],
  stock:                     ['stock', 'qty', 'quantite', 'quantité', 'disponible', 'quantity'],
  delai_expedition_jours:    ['delai', 'délai', 'delay', 'days', 'jours', 'delai_jours'],
};

function normalize(str) {
  return String(str ?? '')
    .trim()
    .toLowerCase()
    .replace(/[àáâã]/g, 'a').replace(/[éèêë]/g, 'e')
    .replace(/[îï]/g, 'i').replace(/[ôö]/g, 'o').replace(/[ùûü]/g, 'u')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_/]/g, '');
}

function mapHeader(header) {
  const h = normalize(header);
  for (const [field, aliases] of Object.entries(COLUMN_MAP)) {
    if (aliases.some(a => normalize(a) === h)) return field;
  }
  return h || null;
}

function mapHeaders(headerRow) {
  return headerRow.map(h => mapHeader(h));
}

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}

function int(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[^0-9-]/g, ''));
  return isNaN(n) ? null : n;
}

function validateRow(mapped, rowNum) {
  const errors = [];

  if (!mapped.marque) errors.push('marque manquante');
  if (!mapped.modele) errors.push('modèle manquant');

  const prix = num(mapped.prix_vehicule_usd);
  if (prix == null || prix <= 0) errors.push('prix_vehicule_usd invalide (doit être > 0)');

  const stock = int(mapped.stock ?? 0);
  if (stock == null || stock < 0) errors.push('stock invalide (doit être >= 0)');

  if (errors.length > 0) return { valid: false, row: rowNum, reason: errors.join(', ') };

  const etat = String(mapped.etat_vehicule || 'Neuf').trim();
  const km = mapped.kilometrage != null ? (int(mapped.kilometrage) ?? 0) : (etat.toLowerCase().includes('neuf') ? 0 : null);
  const cif = num(mapped.cif_shipping_sourceur_usd);

  return {
    valid: true,
    data: {
      marque:                    String(mapped.marque).trim(),
      modele:                    String(mapped.modele).trim(),
      annee:                     int(mapped.annee),
      finition:                  String(mapped.finition || '').trim() || null,
      boite_vitesse:             String(mapped.boite_vitesse || '').trim() || null,
      couleur:                   String(mapped.couleur || '').trim() || null,
      kilometrage:               km,
      etat_vehicule:             etat,
      pieces_modifiees:          String(mapped.pieces_modifiees || '').trim() || null,
      prix_vehicule_usd:         prix,
      cif_shipping_sourceur_usd: cif,
      cif_a_calculer:            cif == null,
      stock:                     stock,
      delai_expedition_jours:    int(mapped.delai_expedition_jours),
    },
  };
}

function rowToMapped(headers, row) {
  const obj = {};
  headers.forEach((field, i) => {
    if (field) obj[field] = row[i] ?? null;
  });
  return obj;
}

function isEmptyRow(row) {
  return !row || row.every(cell => cell == null || String(cell).trim() === '');
}

async function parseExcel(buf) {
  const { read, utils } = await import('xlsx');
  const wb = read(buf, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
}

async function parseCsv(buf) {
  const { parse } = await import('csv-parse/sync');
  return parse(buf.toString('utf8'), {
    columns: false,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  });
}

/**
 * @param {Buffer|Array} input  Buffer for xlsx/csv, array-of-arrays for Google Sheets
 * @param {'excel'|'csv'|'sheets'} format
 * @returns {{ valid: object[], invalid: object[], stats: object }}
 */
export async function parseAndValidateCatalogue(input, format) {
  let rows;

  if (format === 'sheets') {
    rows = Array.isArray(input) ? input : [];
  } else if (format === 'excel') {
    rows = await parseExcel(input);
  } else {
    rows = await parseCsv(input);
  }

  if (!rows || rows.length < 2) {
    return { valid: [], invalid: [], stats: { total: 0, imported: 0, skipped: 0, errors: 0 } };
  }

  const headers = mapHeaders(rows[0].map(h => String(h ?? '')));
  const dataRows = rows.slice(1);

  const valid = [];
  const invalid = [];
  let skipped = 0;
  let processed = 0;

  for (let i = 0; i < dataRows.length; i++) {
    if (processed >= 1000) break; // hard limit

    const row = dataRows[i];
    if (isEmptyRow(row)) { skipped++; continue; }

    processed++;
    const mapped = rowToMapped(headers, row);
    const result = validateRow(mapped, i + 2);

    if (result.valid) {
      valid.push(result.data);
    } else {
      invalid.push({ row: result.row, reason: result.reason, raw: mapped });
    }
  }

  return {
    valid,
    invalid,
    stats: {
      total: processed,
      imported: valid.length,
      skipped,
      errors: invalid.length,
    },
  };
}
