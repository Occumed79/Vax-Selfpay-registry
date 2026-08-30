CREATE TABLE IF NOT EXISTS vaccine_catalog (
  vaccine_code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  brand_name TEXT,
  route TEXT,
  dose_description TEXT,
  sort_order INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO vaccine_catalog (vaccine_code, display_name, brand_name, route, dose_description, sort_order)
VALUES
  ('mmr', 'Measles, Mumps, Rubella (MMR)', NULL, 'Injectable', 'Per dose', 10),
  ('td', 'Tetanus-Diphtheria (Td)', NULL, 'Injectable', 'Per dose', 20),
  ('tdap', 'Tetanus-Diphtheria-Pertussis (Tdap)', NULL, 'Injectable', 'Per dose', 30),
  ('hep-a', 'Hepatitis A', NULL, 'Injectable', 'Per dose', 40),
  ('hep-b', 'Hepatitis B', NULL, 'Injectable', 'Per dose', 50),
  ('twinrix', 'Hepatitis A & B', 'Twinrix', 'Injectable', 'Per dose', 60),
  ('typhoid-injectable', 'Typhoid', NULL, 'Injectable', 'Per dose', 70),
  ('typhoid-oral', 'Typhoid', NULL, 'Oral', 'Per course / package when posted', 80),
  ('polio-injectable', 'Polio', NULL, 'Injectable', 'Per dose', 90),
  ('polio-oral', 'Polio', NULL, 'Oral', 'Per dose / course when posted', 100),
  ('influenza-seasonal', 'Seasonal Influenza', NULL, 'Injectable', 'Per dose', 110),
  ('varicella', 'Varicella', NULL, 'Injectable', 'Per dose', 120),
  ('pneumovax-23', 'Pneumococcal', 'Pneumovax 23', 'Injectable', 'Per dose', 130),
  ('prevnar-13', 'Pneumococcal', 'Prevnar 13', 'Injectable', 'Per dose', 140),
  ('prevnar-20', 'Pneumococcal', 'Prevnar 20', 'Injectable', 'Per dose', 150),
  ('menactra', 'Meningococcal', 'Menactra', 'Injectable', 'Per dose', 160),
  ('menveo', 'Meningococcal', 'Menveo', 'Injectable', 'Per dose', 170),
  ('menquadfi', 'Meningococcal', 'MenQuadfi', 'Injectable', 'Per dose', 180),
  ('yellow-fever', 'Yellow Fever', NULL, 'Injectable', 'Per dose', 190),
  ('japanese-encephalitis', 'Japanese Encephalitis', NULL, 'Injectable', 'Per dose', 200),
  ('rabies', 'Rabies', NULL, 'Injectable', 'Per dose', 210),
  ('covid-19', 'COVID-19', NULL, 'Injectable', 'Per dose', 220)
ON CONFLICT (vaccine_code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  brand_name = EXCLUDED.brand_name,
  route = EXCLUDED.route,
  dose_description = EXCLUDED.dose_description,
  sort_order = EXCLUDED.sort_order,
  active = TRUE;

CREATE TABLE IF NOT EXISTS vaccine_prices (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  clinic_name TEXT,
  address TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT,
  vaccine_code TEXT NOT NULL REFERENCES vaccine_catalog(vaccine_code),
  brand_name TEXT,
  formulation TEXT,
  route TEXT,
  dose_description TEXT,
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  price_basis TEXT NOT NULL DEFAULT 'per dose',
  administration_fee NUMERIC(10,2),
  consultation_fee NUMERIC(10,2),
  other_fee NUMERIC(10,2),
  posted_total NUMERIC(10,2),
  access TEXT,
  access_notes TEXT,
  source_url TEXT NOT NULL,
  source_title TEXT,
  source_date DATE,
  evidence_note TEXT,
  evidence_image_url TEXT,
  latitude NUMERIC(10,7),
  longitude NUMERIC(10,7),
  phone TEXT,
  fax TEXT,
  email TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vaccine_prices_vaccine ON vaccine_prices(vaccine_code);
CREATE INDEX IF NOT EXISTS idx_vaccine_prices_state_city ON vaccine_prices(state, city);
CREATE INDEX IF NOT EXISTS idx_vaccine_prices_price ON vaccine_prices(price);
CREATE INDEX IF NOT EXISTS idx_vaccine_prices_provider ON vaccine_prices(provider);
CREATE INDEX IF NOT EXISTS idx_vaccine_prices_geo ON vaccine_prices(latitude, longitude);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vaccine_prices_source_identity
  ON vaccine_prices(provider, city, state, vaccine_code, COALESCE(brand_name, ''), price, source_url);
