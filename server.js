require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const {
  CDC_YF_SEARCH_URL,
  CDC_YF_REFRESH_MS,
  STATE_SLUGS,
  ensureTables: ensureYellowFeverTables,
  syncState: syncYellowFeverState,
  syncAll: syncAllYellowFever,
  stateNeedsRefresh: yellowFeverStateNeedsRefresh,
  queryCenters: queryYellowFeverCenters,
  status: yellowFeverStatus,
} = require('./cdc_yellow_fever');

const app = express();
const PORT = process.env.PORT || 3000;
const HTML_FILE = path.join(__dirname, 'Vaccine_Self_Pay_Registry.html');
const SCHEMA_FILE = path.join(__dirname, 'db', 'schema.sql');
const SEED_FILE = path.join(__dirname, 'db', 'seed_private_prices.sql');
const htmlTemplate = fs.readFileSync(HTML_FILE, 'utf8');
const schemaSql = fs.readFileSync(SCHEMA_FILE, 'utf8');
const seedSql = fs.existsSync(SEED_FILE) ? fs.readFileSync(SEED_FILE, 'utf8') : '';

const CDC_ADULT_PRICE_PAGE_URL = 'https://www.cdc.gov/vaccines-for-children/php/price-list/index.html#cdc_generic_section_2-adult-vaccine-price-list';
const CDC_ADULT_FETCH_URL = 'https://www.cdc.gov/vaccines-for-children/php/price-list/index.html';
const CDC_ADULT_FALLBACK_PDF_URL = 'https://www.cdc.gov/vaccines-for-children/media/pdfs/2026/07/Adult-Vaccine-Price-List-08-03-26.pdf';
const CDC_REFRESH_MS = 60 * 60 * 1000;

let cdcAdultPriceCache = {
  pageUrl: CDC_ADULT_PRICE_PAGE_URL,
  pdfUrl: CDC_ADULT_FALLBACK_PDF_URL,
  listDate: 'July 29, 2026',
  checkedAt: null,
  discoveredAt: null,
  source: 'fallback',
  error: null,
};

function htmlToText(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function nearestCdcDate(html, pdfMatchIndex) {
  const datePattern = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},\s+\d{4}\b/i;
  const after = htmlToText(html.slice(pdfMatchIndex, Math.min(html.length, pdfMatchIndex + 2200))).match(datePattern);
  if (after) return after[0];
  const before = htmlToText(html.slice(Math.max(0, pdfMatchIndex - 2200), pdfMatchIndex)).match(datePattern);
  return before ? before[0] : null;
}

async function refreshCdcAdultPriceSource(force = false) {
  const lastCheck = cdcAdultPriceCache.checkedAt ? Date.parse(cdcAdultPriceCache.checkedAt) : 0;
  if (!force && lastCheck && Date.now() - lastCheck < CDC_REFRESH_MS) return cdcAdultPriceCache;

  try {
    const response = await fetch(CDC_ADULT_FETCH_URL, {
      headers: {
        'user-agent': 'Occu-Med Vaccine Self-Pay Registry/1.0 (+CDC price reference)',
        accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`CDC page returned HTTP ${response.status}`);

    const html = await response.text();
    const matches = [...html.matchAll(/href=["']([^"']*Adult-Vaccine-Price-List[^"']*\.pdf(?:\?[^"']*)?)["']/gi)];
    if (!matches.length) throw new Error('Current Adult Vaccine Price List PDF link was not found on the CDC page.');

    const match = matches[0];
    const href = match[1].replace(/&amp;/gi, '&');
    const pdfUrl = new URL(href, CDC_ADULT_FETCH_URL).toString();
    const listDate = nearestCdcDate(html, match.index || 0) || cdcAdultPriceCache.listDate;

    cdcAdultPriceCache = {
      pageUrl: CDC_ADULT_PRICE_PAGE_URL,
      pdfUrl,
      listDate,
      checkedAt: new Date().toISOString(),
      discoveredAt: new Date().toISOString(),
      source: 'cdc',
      error: null,
    };
  } catch (error) {
    cdcAdultPriceCache = {
      ...cdcAdultPriceCache,
      checkedAt: new Date().toISOString(),
      error: error.message,
    };
    console.warn('CDC adult vaccine price refresh failed; using last-known document:', error.message);
  }

  return cdcAdultPriceCache;
}

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

app.get('/api/cdc-yellow-fever/states', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    sourceUrl: CDC_YF_SEARCH_URL,
    states: Object.entries(STATE_SLUGS).map(([label, slug]) => ({ label, slug })),
  });
});

app.get('/api/cdc-yellow-fever/status', async (_req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'DATABASE_URL is not configured' });
    const summary = await yellowFeverStatus(pool);
    res.set('Cache-Control', 'no-store');
    res.json({ ...summary, sourceUrl: CDC_YF_SEARCH_URL, refreshHours: CDC_YF_REFRESH_MS / 3600000 });
  } catch (error) {
    console.error('GET /api/cdc-yellow-fever/status failed:', error);
    res.status(500).json({ error: 'Unable to load CDC Yellow Fever sync status', detail: error.message });
  }
});

app.get('/api/cdc-yellow-fever', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'DATABASE_URL is not configured' });
    const stateSlug = String(req.query.state || '').trim().toLowerCase();
    const force = req.query.refresh === '1';
    const q = String(req.query.q || '').trim();

    if (stateSlug && !Object.values(STATE_SLUGS).includes(stateSlug)) {
      return res.status(400).json({ error: 'Unknown state or territory slug' });
    }

    let sync = null;
    if (stateSlug) {
      if (force || await yellowFeverStateNeedsRefresh(pool, stateSlug)) {
        sync = await syncYellowFeverState(pool, stateSlug);
      }
    } else if (force) {
      syncAllYellowFever(pool).catch(error => console.warn('Manual full CDC Yellow Fever refresh failed:', error.message));
    }

    const centers = await queryYellowFeverCenters(pool, { stateSlug, q, limit: 20000 });
    const summary = await yellowFeverStatus(pool);
    res.set('Cache-Control', 'no-store');
    res.json({
      sourceUrl: CDC_YF_SEARCH_URL,
      state: stateSlug || null,
      count: centers.length,
      centers,
      status: summary,
      sync,
    });
  } catch (error) {
    console.error('GET /api/cdc-yellow-fever failed:', error);
    res.status(502).json({ error: 'Unable to load the CDC Yellow Fever registry', detail: error.message });
  }
});

app.get('/api/cdc-yellow-fever/changes', async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'DATABASE_URL is not configured' });
    await ensureYellowFeverTables(pool);
    const stateSlug = String(req.query.state || '').trim().toLowerCase();
    const values = [];
    let where = '';
    if (stateSlug) {
      values.push(stateSlug);
      where = 'WHERE h.state_slug=$1';
    }
    values.push(200);
    const limitParam = values.length;
    const { rows } = await pool.query(`
      SELECT h.change_type,h.detected_at,h.state_slug,
             c.facility_name,c.address,c.city,c.state_code,c.zip,c.cdc_active,c.source_url
      FROM cdc_yellow_fever_changes h
      LEFT JOIN cdc_yellow_fever_centers c USING(provider_key)
      ${where}
      ORDER BY h.detected_at DESC,c.facility_name
      LIMIT ${limitParam}
    `, values);
    res.set('Cache-Control', 'no-store');
    res.json(rows);
  } catch (error) {
    console.error('GET /api/cdc-yellow-fever/changes failed:', error);
    res.status(500).json({ error: 'Unable to load CDC Yellow Fever change history', detail: error.message });
  }
});

app.get('/api/cdc-prices', async (req, res) => {
  const meta = await refreshCdcAdultPriceSource(req.query.refresh === '1');
  res.set('Cache-Control', 'no-store');
  res.json({
    title: 'CDC Adult Vaccine Price List',
    description: 'Official CDC adult vaccine contract and manufacturer-reported private-sector price list.',
    pageUrl: meta.pageUrl,
    pdfUrl: meta.pdfUrl,
    listDate: meta.listDate,
    checkedAt: meta.checkedAt,
    discoveredAt: meta.discoveredAt,
    source: meta.source,
    error: meta.error,
    autoRefreshMinutes: Math.round(CDC_REFRESH_MS / 60000),
  });
});

app.get('/api/cdc-prices/pdf', async (_req, res) => {
  try {
    const meta = await refreshCdcAdultPriceSource(false);
    const upstream = await fetch(meta.pdfUrl, {
      headers: {
        'user-agent': 'Occu-Med Vaccine Self-Pay Registry/1.0 (+CDC price reference)',
        accept: 'application/pdf,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    if (!upstream.ok) throw new Error(`CDC PDF returned HTTP ${upstream.status}`);
    const contentType = upstream.headers.get('content-type') || 'application/pdf';
    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', contentType.includes('pdf') ? contentType : 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="CDC-Adult-Vaccine-Price-List.pdf"');
    res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=21600');
    res.send(bytes);
  } catch (error) {
    console.error('Unable to proxy CDC adult vaccine price PDF:', error.message);
    res.status(502).json({ error: 'Unable to load the current CDC Adult Vaccine Price List', detail: error.message });
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
app.get('/cdc-prices', serveRegistry);
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

  refreshCdcAdultPriceSource(true).catch((error) => console.warn('Initial CDC refresh failed:', error.message));

  if (pool) {
    ensureYellowFeverTables(pool)
      .then(() => yellowFeverStatus(pool))
      .then((summary) => {
        const expectedStates = Object.keys(STATE_SLUGS).length;
        if (
          !summary.synced_states ||
          Number(summary.synced_states) < expectedStates ||
          Number(summary.error_states || 0) > 0
        ) {
          return syncAllYellowFever(pool);
        }
        return null;
      })
      .then((result) => {
        if (result) console.log(`CDC Yellow Fever initial sync completed: ${result.records} centers across ${result.statesCompleted} states/territories.`);
      })
      .catch((error) => console.warn('Initial CDC Yellow Fever sync failed:', error.message));
  }
  const cdcRefreshTimer = setInterval(
    () => refreshCdcAdultPriceSource(true).catch((error) => console.warn('Scheduled CDC refresh failed:', error.message)),
    CDC_REFRESH_MS
  );
  if (typeof cdcRefreshTimer.unref === 'function') cdcRefreshTimer.unref();

  if (pool) {
    const yellowFeverRefreshTimer = setInterval(
      () => syncAllYellowFever(pool)
        .then(result => console.log(`Scheduled CDC Yellow Fever sync: ${result.records} centers across ${result.statesCompleted} states/territories.`))
        .catch(error => console.warn('Scheduled CDC Yellow Fever sync failed:', error.message)),
      CDC_YF_REFRESH_MS
    );
    if (typeof yellowFeverRefreshTimer.unref === 'function') yellowFeverRefreshTimer.unref();
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
