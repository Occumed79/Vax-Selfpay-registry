require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'Vaccine_Self_Pay_Registry.html');
const SCHEMA_FILE = path.join(__dirname, 'db', 'schema.sql');
const SEED_FILE = path.join(__dirname, 'db', 'seed_private_prices.sql');
const htmlTemplate = fs.readFileSync(HTML_FILE, 'utf8');
const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
const seedSql = fs.existsSync(SEED_FILE) ? fs.readFileSync(SEED_FILE, 'utf8') : '';

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set. The registry will load with its embedded empty dataset until Neon is configured.');
}

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

async function initializeDatabase() {
  if (!pool) return;
  await pool.query(schemaSql);
  console.log('Vaccine registry schema verified in Neon.');

  if (seedSql.trim()) {
    const result = await pool.query(seedSql);
    console.log(`Private vaccine price seed applied to Neon (${result.rowCount ?? 0} new rows on this boot).`);
  }
}

function num(value) {
  return value == null ? null : Number(value);
}

function rowsToFrontend(rows) {
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    clinic: r.clinic_name || '',
    address: r.address || '',
    city: r.city,
    state: r.state,
    zip: r.zip || '',
    vaccineCode: r.vaccine_code,
    vaccine: r.vaccine_name,
    brand: r.brand_name || '',
    formulation: r.formulation || '',
    route: r.route || '',
    dose: r.dose_description || '',
    price: num(r.price),
    priceBasis: r.price_basis || 'per dose',
    administrationFee: num(r.administration_fee),
    consultationFee: num(r.consultation_fee),
    otherFee: num(r.other_fee),
    postedTotal: num(r.posted_total),
    access: r.access || '',
    accessNotes: r.access_notes || '',
    source: r.source_url,
    sourceTitle: r.source_title || '',
    sourceDate: r.source_date || null,
    evidenceNote: r.evidence_note || '',
    evidenceImage: r.evidence_image_url || '',
    lat: num(r.latitude),
    lon: num(r.longitude),
    phone: r.phone || '',
    fax: r.fax || '',
    email: r.email || '',
    verifiedAt: r.verified_at || null,
  }));
}

async function getLocations() {
  if (!pool) return null;
  const { rows } = await pool.query(`
    SELECT vp.id,
           vp.provider,
           vp.clinic_name,
           vp.address,
           vp.city,
           vp.state,
           vp.zip,
           vp.vaccine_code,
           vc.display_name AS vaccine_name,
           COALESCE(vp.brand_name, vc.brand_name) AS brand_name,
           vp.formulation,
           COALESCE(vp.route, vc.route) AS route,
           COALESCE(vp.dose_description, vc.dose_description) AS dose_description,
           vp.price,
           vp.price_basis,
           vp.administration_fee,
           vp.consultation_fee,
           vp.other_fee,
           vp.posted_total,
           vp.access,
           vp.access_notes,
           vp.source_url,
           vp.source_title,
           vp.source_date,
           vp.evidence_note,
           vp.evidence_image_url,
           vp.latitude,
           vp.longitude,
           vp.phone,
           vp.fax,
           vp.email,
           vp.verified_at
    FROM vaccine_prices vp
    JOIN vaccine_catalog vc ON vc.vaccine_code = vp.vaccine_code
    WHERE vc.active = TRUE
    ORDER BY vp.price ASC, vp.state ASC, vp.city ASC, vp.provider ASC, vc.sort_order ASC
  `);
  return rowsToFrontend(rows);
}

async function getVaccineCatalog() {
  if (!pool) return null;
  const { rows } = await pool.query(`
    SELECT vaccine_code, display_name, brand_name, route, dose_description, sort_order
    FROM vaccine_catalog
    WHERE active = TRUE
    ORDER BY sort_order ASC, display_name ASC
  `);
  return rows.map((r) => ({
    code: r.vaccine_code,
    name: r.display_name,
    brand: r.brand_name || '',
    route: r.route || '',
    dose: r.dose_description || '',
    sortOrder: r.sort_order,
  }));
}

function injectRuntimeData(template, locations) {
  let output = template;
  if (Array.isArray(locations)) {
    const safeJson = JSON.stringify(locations).replace(/<\//g, '<\\/');
    output = output.replace(/const DATA=\[[\s\S]*?\];/, `const DATA=${safeJson};`);
  }

  const maptilerKey = process.env.MAPTILER_KEY || '';
  const safeKey = JSON.stringify(maptilerKey).replace(/<\//g, '<\\/');
  output = output.replace(
    /window\.__MAPTILER_KEY__\s*=\s*[^;]*;/,
    `window.__MAPTILER_KEY__=${safeKey};`
  );
  return output;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  try {
    if (!pool) {
      return res.status(200).json({ ok: true, database: 'not-configured', service: 'vaccine-self-pay-registry' });
    }
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS price_count,
             COUNT(DISTINCT provider)::int AS provider_count
      FROM vaccine_prices
    `);
    res.json({
      ok: true,
      database: 'connected',
      service: 'vaccine-self-pay-registry',
      price_count: rows[0].price_count,
      provider_count: rows[0].provider_count,
    });
  } catch (error) {
    res.status(503).json({ ok: false, database: 'error', message: error.message });
  }
});

app.get('/api/locations', async (_req, res) => {
  try {
    const locations = await getLocations();
    if (!locations) return res.status(503).json({ error: 'DATABASE_URL is not configured' });
    res.set('Cache-Control', 'no-store');
    res.json(locations);
  } catch (error) {
    console.error('GET /api/locations failed:', error);
    res.status(500).json({ error: 'Unable to load vaccine price locations' });
  }
});

app.get('/api/vaccines', async (_req, res) => {
  try {
    const vaccines = await getVaccineCatalog();
    if (!vaccines) return res.status(503).json({ error: 'DATABASE_URL is not configured' });
    res.set('Cache-Control', 'no-store');
    res.json(vaccines);
  } catch (error) {
    console.error('GET /api/vaccines failed:', error);
    res.status(500).json({ error: 'Unable to load vaccine catalog' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'DATABASE_URL is not configured' });
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS price_count,
             COUNT(DISTINCT CONCAT_WS('|', provider, COALESCE(address, ''), city, state))::int AS location_count,
             COUNT(DISTINCT provider)::int AS provider_count,
             COUNT(DISTINCT state)::int AS state_count,
             COUNT(DISTINCT vaccine_code)::int AS vaccine_count,
             MIN(price)::numeric AS lowest_price,
             MAX(price)::numeric AS highest_price,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::numeric AS median_price
      FROM vaccine_prices
    `);
    const stats = rows[0];
    stats.lowest_price = num(stats.lowest_price);
    stats.highest_price = num(stats.highest_price);
    stats.median_price = num(stats.median_price);
    res.set('Cache-Control', 'no-store');
    res.json(stats);
  } catch (error) {
    console.error('GET /api/stats failed:', error);
    res.status(500).json({ error: 'Unable to load registry stats' });
  }
});

async function serveRegistry(_req, res) {
  try {
    let locations = null;
    try {
      locations = await getLocations();
    } catch (dbError) {
      console.error('Neon query failed; serving the registry without live rows:', dbError.message);
    }
    res.type('html').send(injectRuntimeData(htmlTemplate, locations));
  } catch (error) {
    console.error('Unable to serve registry:', error);
    res.status(500).send('Unable to load the Vaccine Self-Pay Registry.');
  }
}

app.get('/', serveRegistry);
app.get('/catalogue', serveRegistry);
app.get('/Vaccine_Self_Pay_Registry.html', serveRegistry);

app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

let server = null;

async function start() {
  try {
    await initializeDatabase();
  } catch (error) {
    console.error('Unable to initialize Neon vaccine schema/data:', error.message);
  }

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Vaccine Self-Pay Registry listening on port ${PORT}`);
  });
}

async function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  if (!server) {
    if (pool) await pool.end().catch(() => {});
    process.exit(0);
  }
  server.close(async () => {
    if (pool) await pool.end().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
