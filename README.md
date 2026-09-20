# Vaccine Self-Pay Registry

This repository is the vaccine-focused version of the Occu-Med self-pay registry structure: a MapTiler location explorer plus a page-turning E-Catalogue, backed by Neon Postgres and deployable as a normal Render Web Service.

The registry contains **vaccine pricing only**. Its vaccine taxonomy is based on the requested fee-per-dose list:

- Measles, Mumps, Rubella (MMR)
- Tetanus-Diphtheria (Td)
- Tetanus-Diphtheria-Pertussis (Tdap)
- Hepatitis A
- Hepatitis B
- Hepatitis A & B (Twinrix)
- Injectable Typhoid
- Oral Typhoid
- Injectable Polio
- Oral Polio
- Seasonal Influenza
- Varicella
- Pneumococcal — Pneumovax 23
- Pneumococcal — Prevnar 13
- Pneumococcal — Prevnar 20
- Meningococcal — Menactra
- Meningococcal — Menveo
- Meningococcal — MenQuadfi
- Yellow Fever
- Japanese Encephalitis
- Rabies
- COVID-19, with brand/kind stored on the price row when stated

## Runtime

- Node.js 20+
- Express
- Neon Postgres
- MapTiler Landscape v4

## Render Web Service settings

Create a normal **Web Service** from this GitHub repository.

- Repository: `Occumed79/Vax-Selfpay-registry`
- Branch: `main`
- Runtime / Language: `Node`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

The application listens on Render's `PORT` and binds to `0.0.0.0`.

## Environment variables

Set these on the Render service:

- `DATABASE_URL` — Neon pooled Postgres connection string
- `MAPTILER_KEY` — MapTiler API key
- `NODE_ENV=production`

`.env.example` contains the expected names only.

## Neon database

On startup, the server automatically executes `db/schema.sql` and then `db/seed_private_prices.sql` against the configured `DATABASE_URL`.

The schema creates:

- `vaccine_catalog` — the controlled vaccine list used by the registry
- `vaccine_prices` — posted self-pay price records, clinic/location details, fees, contact data, geocodes, and source evidence

The private-price seed is idempotent and uses duplicate protection, so redeploying the service safely applies newly committed price rows without duplicating existing provider/vaccine/source/price combinations.

The price stored in `vaccine_prices.price` is the primary posted vaccine price. Separate fields are available for administration, consultation, other fees, and a posted total so the source can be represented without collapsing unlike charges into one number.

## CDC adult price reference

The app includes a separate **CDC Prices** view for the official CDC Adult Vaccine Price List. This reference is intentionally kept separate from clinic self-pay pricing.

At runtime the server:
- checks the CDC vaccine price-list page on startup and every 60 minutes,
- discovers the current Adult Vaccine Price List PDF instead of hard-coding a permanent document,
- serves the current PDF through `/api/cdc-prices/pdf`, and
- exposes source metadata through `/api/cdc-prices`.

The CDC reference shows CDC contract prices and manufacturer-reported private-sector prices. These are reference values and are not inserted into `vaccine_prices` as clinic self-pay records.

## Routes

- `/` — Vaccine Self-Pay Registry
- `/catalogue` — same application entry point
- `/cdc-prices` — opens the registry directly on the live CDC Adult Vaccine Price List section
- `/api/locations` — live Neon-backed vaccine price rows
- `/api/cdc-prices` — current CDC Adult Vaccine Price List metadata
- `/api/cdc-prices/pdf` — current CDC Adult Vaccine Price List PDF proxy
- `/api/vaccines` — controlled vaccine taxonomy
- `/api/stats` — registry totals and price statistics
- `/health` — Render health check and database connectivity state, including live price/provider counts

## Frontend structure

`Vaccine_Self_Pay_Registry.html` has three separate data views:

1. **Map** — search and filter by vaccine, state, route, maximum price, provider, city, and brand. Pins group matching price records by clinic location.
2. **E-Catalogue** — a page-turning catalogue built from the same filtered records, with provider, location, vaccine/brand, price basis, additional posted fees, contact information, and direct source evidence.
3. **CDC Prices** — the live CDC Adult Vaccine Price List, kept visually and analytically separate from clinic self-pay prices and refreshed automatically from the CDC source page.

The HTML contains an empty fallback dataset. When Neon is connected, `server.js` injects the current database rows into the application at request time.

## Core `vaccine_prices` fields

For price collection, the most important fields are:

- `provider`, `clinic_name`, `address`, `city`, `state`, `zip`
- `vaccine_code`, `brand_name`, `formulation`, `route`, `dose_description`
- `price`, `price_basis`
- `administration_fee`, `consultation_fee`, `other_fee`, `posted_total`
- `access`, `access_notes`
- `source_url`, `source_title`, `source_date`, `evidence_note`, `evidence_image_url`
- `latitude`, `longitude`
- `phone`, `fax`, `email`, `verified_at`

## Local run

```bash
npm install
cp .env.example .env
# Add DATABASE_URL and MAPTILER_KEY to .env or export them in your shell.
npm start
```

Then open `http://localhost:3000`.
