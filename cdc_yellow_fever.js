const crypto = require('crypto');
const https = require('https');
const cheerio = require('cheerio');

const CDC_YF_BASE = 'https://wwwnc.cdc.gov/travel/yellow-fever-vaccination-clinics';
const CDC_YF_SEARCH_URL = `${CDC_YF_BASE}/search`;
const CDC_YF_REFRESH_MS = 6 * 60 * 60 * 1000;

const STATE_SLUGS = {
  Alabama:'alabama', Alaska:'alaska', Arizona:'arizona', Arkansas:'arkansas', California:'california',
  Colorado:'colorado', Connecticut:'connecticut', Delaware:'delaware',
  'District of Columbia':'district-of-columbia', Florida:'florida', Georgia:'georgia', Hawaii:'hawaii',
  Idaho:'idaho', Illinois:'illinois', Indiana:'indiana', Iowa:'iowa', Kansas:'kansas', Kentucky:'kentucky',
  Louisiana:'louisiana', Maine:'maine', Maryland:'maryland', Massachusetts:'massachusetts', Michigan:'michigan',
  Minnesota:'minnesota', Mississippi:'mississippi', Missouri:'missouri', Montana:'montana', Nebraska:'nebraska',
  Nevada:'nevada', 'New Hampshire':'new-hampshire', 'New Jersey':'new-jersey', 'New Mexico':'new-mexico',
  'New York':'new-york', 'North Carolina':'north-carolina', 'North Dakota':'north-dakota', Ohio:'ohio',
  Oklahoma:'oklahoma', Oregon:'oregon', Pennsylvania:'pennsylvania', 'Rhode Island':'rhode-island',
  'South Carolina':'south-carolina', 'South Dakota':'south-dakota', Tennessee:'tennessee', Texas:'texas',
  Utah:'utah', Vermont:'vermont', Virginia:'virginia', Washington:'washington', 'West Virginia':'west-virginia',
  Wisconsin:'wisconsin', Wyoming:'wyoming', 'Puerto Rico':'puerto-rico', Guam:'guam',
  'U.S. Virgin Islands':'virgin-islands', 'American Samoa':'american-samoa',
  'Northern Mariana Islands':'northern-mariana-islands'
};

const SLUG_TO_LABEL = Object.fromEntries(Object.entries(STATE_SLUGS).map(([label, slug]) => [slug, label]));

function clean(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function providerKey(record) {
  const streetNumber = (record.address.match(/^\s*(\d+[A-Za-z-]*)/) || [,''])[1].toLowerCase();
  const identity = [
    record.facilityName, record.city, record.stateCode, record.zip, streetNumber
  ].map(v => clean(v).toLowerCase()).join('|');
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function sourceHash(record) {
  return crypto.createHash('sha256').update(JSON.stringify({
    facilityName: record.facilityName,
    address: record.address,
    city: record.city,
    stateCode: record.stateCode,
    zip: record.zip,
    phone: record.phone,
    county: record.county,
    website: record.website,
    seesUnder18: record.seesUnder18,
    limitedAccess: record.limitedAccess,
    accessNote: record.accessNote
  })).digest('hex');
}

function parseClinicCell($, cell, fallbackCity = '') {
  const clone = $(cell).clone();
  clone.find('br').replaceWith('\n');
  const lines = clone.text().split(/\r?\n/).map(clean).filter(Boolean).filter(x => x.toLowerCase() !== 'website');
  if (!lines.length) return null;

  const facilityName = lines[0];
  const locationRe = /^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i;
  const phoneRe = /(?:\+?1[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]\d{4}/;
  let locationIndex = -1;
  let city = '';
  let stateCode = '';
  let zip = '';
  let addressLines = [];
  let phone = '';

  for (let i = 1; i < lines.length; i += 1) {
    const match = lines[i].match(locationRe);
    if (match) {
      locationIndex = i;
      city = clean(match[1]);
      stateCode = match[2].toUpperCase();
      zip = match[3];
      break;
    }
  }

  if (locationIndex >= 0) {
    addressLines = lines.slice(1, locationIndex);
    for (const line of lines.slice(locationIndex + 1)) {
      if (phoneRe.test(line)) {
        phone = line;
        break;
      }
    }
  } else {
    const cityParts = clean(fallbackCity).split(',');
    if (cityParts.length >= 2) {
      city = clean(cityParts.slice(0, -1).join(','));
      stateCode = clean(cityParts[cityParts.length - 1]).toUpperCase();
    } else {
      city = clean(fallbackCity);
    }
    const phoneIndex = lines.slice(1).findIndex(line => phoneRe.test(line));
    if (phoneIndex >= 0) {
      const absoluteIndex = phoneIndex + 1;
      addressLines = lines.slice(1, absoluteIndex);
      phone = lines[absoluteIndex];
    } else {
      addressLines = lines.slice(1);
    }
  }

  const flags = lines.filter(line => {
    const upper = line.toUpperCase();
    return upper.includes('SEES PATIENTS <18 Y/O') ||
      upper.includes('MEMBERS / AFFILIATES / STAFF / STUDENTS ONLY');
  });
  addressLines = addressLines.filter(line => !flags.includes(line));

  const website = $(cell).find('a[href]').map((_, a) => $(a).attr('href')).get()
    .map(href => {
      try { return new URL(href, CDC_YF_SEARCH_URL).toString(); } catch { return ''; }
    })
    .find(url => url && !url.includes('wwwnc.cdc.gov')) || '';

  return {
    facilityName,
    address: addressLines.join(', '),
    city,
    stateCode,
    zip,
    phone,
    website,
    seesUnder18: flags.some(x => x.toUpperCase().includes('SEES PATIENTS <18 Y/O')),
    limitedAccess: flags.some(x => x.toUpperCase().includes('MEMBERS / AFFILIATES / STAFF / STUDENTS ONLY')),
    accessNote: flags.join('; ')
  };
}

function parseStatePage(html, stateSlug) {
  const $ = cheerio.load(html);
  let resultTable = null;

  $('table').each((_, table) => {
    if (resultTable) return;
    const header = $(table).find('tr').first().find('th,td').map((__, c) => clean($(c).text()).toLowerCase()).get();
    if (header.length >= 3 && header[0] === 'clinic' && header[1] === 'city' && header[2] === 'county') {
      resultTable = table;
    }
  });

  if (!resultTable) throw new Error('CDC Yellow Fever registry table was not found.');

  const sourceUrl = `${CDC_YF_BASE}/state/${stateSlug}`;
  const records = [];

  $(resultTable).find('tr').slice(1).each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;
    const clinic = parseClinicCell($, cells.eq(0), cells.eq(1).text());
    if (!clinic || !clinic.facilityName) return;

    const record = {
      ...clinic,
      county: clean(cells.eq(2).text()),
      stateSlug,
      stateLabel: SLUG_TO_LABEL[stateSlug] || stateSlug,
      sourceUrl
    };
    record.providerKey = providerKey(record);
    record.sourceHash = sourceHash(record);
    records.push(record);
  });

  if (!records.length) throw new Error(`CDC returned zero parsed Yellow Fever clinics for ${stateSlug}.`);
  return records;
}

function fetchTextIpv4(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      family: 4,
      headers: {
        'user-agent': 'Occu-Med Vaccine Self-Pay Registry/1.0 (+CDC Yellow Fever Registry)',
        accept: 'text/html,application/xhtml+xml'
      }
    }, response => {
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        if (redirects >= 5) return reject(new Error('Too many CDC redirects.'));
        return fetchTextIpv4(new URL(location, url).toString(), redirects + 1).then(resolve, reject);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`CDC Yellow Fever page returned HTTP ${response.statusCode}`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.setTimeout(45000, () => request.destroy(new Error('CDC IPv4 request timed out.')));
    request.on('error', reject);
  });
}

async function fetchState(stateSlug) {
  if (!Object.values(STATE_SLUGS).includes(stateSlug)) throw new Error('Unsupported state or territory.');
  const sourceUrl = `${CDC_YF_BASE}/state/${stateSlug}`;
  let html = '';
  let primaryError = null;
  try {
    const response = await fetch(sourceUrl, {
      headers: {
        'user-agent': 'Occu-Med Vaccine Self-Pay Registry/1.0 (+CDC Yellow Fever Registry)',
        accept: 'text/html,application/xhtml+xml'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) throw new Error(`CDC Yellow Fever page returned HTTP ${response.status}`);
    html = await response.text();
  } catch (error) {
    primaryError = error;
    try {
      html = await fetchTextIpv4(sourceUrl);
    } catch (ipv4Error) {
      const message = `CDC connection failed: ${primaryError.message}; IPv4 retry failed: ${ipv4Error.message}`;
      const combined = new Error(message);
      combined.cause = ipv4Error;
      throw combined;
    }
  }
  return parseStatePage(html, stateSlug);
}

async function ensureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cdc_yellow_fever_centers (
      provider_key TEXT PRIMARY KEY,
      state_slug TEXT NOT NULL,
      state_label TEXT NOT NULL,
      facility_name TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state_code TEXT NOT NULL DEFAULT '',
      zip TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      county TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      sees_under_18 BOOLEAN NOT NULL DEFAULT FALSE,
      limited_access BOOLEAN NOT NULL DEFAULT FALSE,
      access_note TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      cdc_active BOOLEAN NOT NULL DEFAULT TRUE,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cdc_yf_state_active ON cdc_yellow_fever_centers(state_slug, cdc_active);
    CREATE INDEX IF NOT EXISTS idx_cdc_yf_location ON cdc_yellow_fever_centers(state_code, city, zip);

    CREATE TABLE IF NOT EXISTS cdc_yellow_fever_sync_status (
      state_slug TEXT PRIMARY KEY,
      last_started_at TIMESTAMPTZ,
      last_completed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'never',
      record_count INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS cdc_yellow_fever_changes (
      id BIGSERIAL PRIMARY KEY,
      provider_key TEXT NOT NULL,
      state_slug TEXT NOT NULL,
      change_type TEXT NOT NULL,
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      previous_hash TEXT NOT NULL DEFAULT '',
      current_hash TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_cdc_yf_changes_detected ON cdc_yellow_fever_changes(detected_at DESC);
  `);
}

async function syncState(pool, stateSlug) {
  const records = await fetchState(stateSlug);
  await ensureTables(pool);
  const client = await pool.connect();
  const now = new Date();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO cdc_yellow_fever_sync_status(state_slug,last_started_at,status,error)
      VALUES($1,$2,'running','')
      ON CONFLICT(state_slug) DO UPDATE SET last_started_at=EXCLUDED.last_started_at,status='running',error=''
    `, [stateSlug, now]);

    const existingResult = await client.query(
      'SELECT provider_key, source_hash, cdc_active FROM cdc_yellow_fever_centers WHERE state_slug=$1',
      [stateSlug]
    );
    const existing = new Map(existingResult.rows.map(row => [row.provider_key, row]));
    const seen = new Set(records.map(record => record.providerKey));
    const changes = { added:0, updated:0, reactivated:0, removed:0 };
    const changeRows = [];

    for (const record of records) {
      const prior = existing.get(record.providerKey);
      let changeType = '';
      let previousHash = '';
      if (!prior) changeType = 'added';
      else {
        previousHash = prior.source_hash || '';
        if (!prior.cdc_active) changeType = 'reactivated';
        else if (previousHash !== record.sourceHash) changeType = 'updated';
      }
      if (changeType) {
        changes[changeType] += 1;
        changeRows.push({
          provider_key: record.providerKey,
          state_slug: stateSlug,
          change_type: changeType,
          previous_hash: previousHash,
          current_hash: record.sourceHash
        });
      }
    }

    const payload = records.map(record => ({
      provider_key: record.providerKey,
      state_slug: record.stateSlug,
      state_label: record.stateLabel,
      facility_name: record.facilityName,
      address: record.address,
      city: record.city,
      state_code: record.stateCode,
      zip: record.zip,
      phone: record.phone,
      county: record.county,
      website: record.website,
      sees_under_18: record.seesUnder18,
      limited_access: record.limitedAccess,
      access_note: record.accessNote,
      source_url: record.sourceUrl,
      source_hash: record.sourceHash
    }));

    await client.query(`
      WITH incoming AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          provider_key TEXT,
          state_slug TEXT,
          state_label TEXT,
          facility_name TEXT,
          address TEXT,
          city TEXT,
          state_code TEXT,
          zip TEXT,
          phone TEXT,
          county TEXT,
          website TEXT,
          sees_under_18 BOOLEAN,
          limited_access BOOLEAN,
          access_note TEXT,
          source_url TEXT,
          source_hash TEXT
        )
      )
      INSERT INTO cdc_yellow_fever_centers(
        provider_key,state_slug,state_label,facility_name,address,city,state_code,zip,phone,county,website,
        sees_under_18,limited_access,access_note,source_url,source_hash,cdc_active,first_seen_at,last_seen_at,last_checked_at
      )
      SELECT provider_key,state_slug,state_label,facility_name,address,city,state_code,zip,phone,county,website,
             sees_under_18,limited_access,access_note,source_url,source_hash,TRUE,$2,$2,$2
      FROM incoming
      ON CONFLICT(provider_key) DO UPDATE SET
        state_slug=EXCLUDED.state_slug,state_label=EXCLUDED.state_label,facility_name=EXCLUDED.facility_name,
        address=EXCLUDED.address,city=EXCLUDED.city,state_code=EXCLUDED.state_code,zip=EXCLUDED.zip,
        phone=EXCLUDED.phone,county=EXCLUDED.county,website=EXCLUDED.website,
        sees_under_18=EXCLUDED.sees_under_18,limited_access=EXCLUDED.limited_access,
        access_note=EXCLUDED.access_note,source_url=EXCLUDED.source_url,source_hash=EXCLUDED.source_hash,
        cdc_active=TRUE,last_seen_at=EXCLUDED.last_seen_at,last_checked_at=EXCLUDED.last_checked_at
    `, [JSON.stringify(payload), now]);

    if (changeRows.length) {
      await client.query(`
        INSERT INTO cdc_yellow_fever_changes(
          provider_key,state_slug,change_type,detected_at,previous_hash,current_hash
        )
        SELECT provider_key,state_slug,change_type,$2,previous_hash,current_hash
        FROM jsonb_to_recordset($1::jsonb) AS x(
          provider_key TEXT,
          state_slug TEXT,
          change_type TEXT,
          previous_hash TEXT,
          current_hash TEXT
        )
      `, [JSON.stringify(changeRows), now]);
    }

    const removed = [...existing.entries()]
      .filter(([key, row]) => row.cdc_active && !seen.has(key))
      .map(([key]) => key);
    if (removed.length) {
      changes.removed = removed.length;
      await client.query(`
        INSERT INTO cdc_yellow_fever_changes(provider_key,state_slug,change_type,detected_at,previous_hash,current_hash)
        SELECT provider_key,state_slug,'removed',$1,source_hash,'' FROM cdc_yellow_fever_centers
        WHERE provider_key = ANY($2::text[])
      `, [now, removed]);
      await client.query(
        'UPDATE cdc_yellow_fever_centers SET cdc_active=FALSE,last_checked_at=$1 WHERE provider_key=ANY($2::text[])',
        [now, removed]
      );
    }

    await client.query(`
      INSERT INTO cdc_yellow_fever_sync_status(state_slug,last_started_at,last_completed_at,status,record_count,error)
      VALUES($1,$2,$2,'ok',$3,'')
      ON CONFLICT(state_slug) DO UPDATE SET last_started_at=EXCLUDED.last_started_at,
        last_completed_at=EXCLUDED.last_completed_at,status='ok',record_count=EXCLUDED.record_count,error=''
    `, [stateSlug, now, records.length]);

    await client.query('COMMIT');
    return { stateSlug, records:records.length, ...changes, completedAt:now.toISOString() };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(`
      INSERT INTO cdc_yellow_fever_sync_status(state_slug,last_started_at,status,error)
      VALUES($1,NOW(),'error',$2)
      ON CONFLICT(state_slug) DO UPDATE SET status='error',error=EXCLUDED.error,last_started_at=NOW()
    `, [stateSlug, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

let fullSyncPromise = null;
async function syncAll(pool) {
  if (fullSyncPromise) return fullSyncPromise;
  fullSyncPromise = (async () => {
    const slugs = Object.values(STATE_SLUGS);
    const results = [];
    const errors = [];
    const queue = [...slugs];

    async function worker() {
      while (queue.length) {
        const slug = queue.shift();
        try {
          results.push(await syncState(pool, slug));
        } catch (error) {
          console.warn(`CDC Yellow Fever sync failed for ${slug}:`, error.message);
          errors.push({ stateSlug:slug, error:error.message });
        }
      }
    }

    await Promise.all(Array.from({ length: 4 }, () => worker()));
    return {
      statesAttempted: slugs.length,
      statesCompleted: results.length,
      records: results.reduce((sum, item) => sum + item.records, 0),
      errors
    };
  })();

  try {
    return await fullSyncPromise;
  } finally {
    fullSyncPromise = null;
  }
}

async function stateNeedsRefresh(pool, stateSlug, maxAgeMs = CDC_YF_REFRESH_MS) {
  await ensureTables(pool);
  const { rows } = await pool.query(
    'SELECT last_completed_at,status FROM cdc_yellow_fever_sync_status WHERE state_slug=$1',
    [stateSlug]
  );
  if (!rows.length || rows[0].status !== 'ok' || !rows[0].last_completed_at) return true;
  return Date.now() - new Date(rows[0].last_completed_at).getTime() >= maxAgeMs;
}

async function queryCenters(pool, { stateSlug = '', q = '', activeOnly = true, limit = 10000 } = {}) {
  await ensureTables(pool);
  const clauses = [];
  const values = [];
  let n = 1;
  if (activeOnly) clauses.push('cdc_active=TRUE');
  if (stateSlug) {
    clauses.push(`state_slug=$${n++}`);
    values.push(stateSlug);
  }
  if (q) {
    clauses.push(`(facility_name ILIKE $${n} OR city ILIKE $${n} OR county ILIKE $${n} OR zip ILIKE $${n})`);
    values.push(`%${q.trim()}%`);
    n += 1;
  }
  values.push(Math.max(1, Math.min(Number(limit) || 10000, 20000)));
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const { rows } = await pool.query(`
    SELECT provider_key,state_slug,state_label,facility_name,address,city,state_code,zip,phone,county,website,
           sees_under_18,limited_access,access_note,source_url,cdc_active,first_seen_at,last_seen_at,last_checked_at
    FROM cdc_yellow_fever_centers
    ${where}
    ORDER BY state_code,city,facility_name
    LIMIT $${n}
  `, values);
  return rows;
}

async function status(pool) {
  await ensureTables(pool);
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM cdc_yellow_fever_centers WHERE cdc_active=TRUE) AS active_centers,
      (SELECT COUNT(DISTINCT state_slug)::int FROM cdc_yellow_fever_centers WHERE cdc_active=TRUE) AS active_states,
      (SELECT MAX(last_completed_at) FROM cdc_yellow_fever_sync_status WHERE status='ok') AS newest_sync,
      (SELECT COUNT(*)::int FROM cdc_yellow_fever_sync_status WHERE status='ok') AS synced_states,
      (SELECT COUNT(*)::int FROM cdc_yellow_fever_sync_status WHERE status='error') AS error_states
  `);
  return rows[0];
}

module.exports = {
  CDC_YF_BASE,
  CDC_YF_SEARCH_URL,
  CDC_YF_REFRESH_MS,
  STATE_SLUGS,
  SLUG_TO_LABEL,
  parseStatePage,
  fetchState,
  ensureTables,
  syncState,
  syncAll,
  stateNeedsRefresh,
  queryCenters,
  status
};
