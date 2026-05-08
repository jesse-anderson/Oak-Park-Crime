import { expect, test } from '@playwright/test';

const transparentPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

test.describe('Phase 3 schema v4: PDF + dashboard merge', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://tile.openstreetmap.org/**', route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng })
    );
    await page.goto('/crime_map.html', { waitUntil: 'domcontentloaded' });
    const accept = page.getByRole('button', { name: /i accept/i });
    if (await accept.isVisible().catch(() => false)) await accept.click();
    await expect(page.locator('#loading')).toBeHidden({ timeout: 90000 });
    await page.waitForFunction(() => typeof window.opCrimeMap?.runSql === 'function', null, { timeout: 30000 });
  });

  test('crimes table has v4 columns including LIST<VARCHAR> arrays', async ({ page }) => {
    const cols = await page.evaluate(() => window.opCrimeMap.runSql(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'crimes'
    `));
    const byName = Object.fromEntries(cols.map(c => [c.column_name, c.data_type]));

    expect(byName.source).toBe('VARCHAR');
    expect(byName.join_key).toBe('VARCHAR');
    expect(byName.incident_id_raw).toBe('VARCHAR');
    expect(byName.pd_zone).toBe('SMALLINT');
    expect(byName.charge_count).toBe('SMALLINT');
    expect(byName.date_mismatch).toBe('BOOLEAN');
    expect(byName.merge_notes).toBe('VARCHAR');
    expect(byName.pdf_offense_text).toBe('VARCHAR');

    for (const arrCol of ['nibrs_codes', 'crime_against_groups', 'offense_types', 'offense_descriptions']) {
      expect(byName[arrCol]).toBe('VARCHAR[]');
    }
  });

  test('all three source values are populated', async ({ page }) => {
    const rows = await page.evaluate(() => window.opCrimeMap.runSql(`
      SELECT source, COUNT(*) AS n FROM crimes GROUP BY source ORDER BY source
    `));
    const sources = rows.map(r => r.source).sort();
    expect(sources).toEqual(['both', 'dashboard', 'pdf']);
    for (const r of rows) expect(Number(r.n)).toBeGreaterThan(0);
  });

  test('NIBRS arrays roundtrip from WASM as JS arrays', async ({ page }) => {
    const rows = await page.evaluate(() => window.opCrimeMap.runSql(`
      SELECT nibrs_codes, offense_descriptions, charge_count
      FROM crimes
      WHERE charge_count > 1
      LIMIT 3
    `));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Array.isArray(r.nibrs_codes)).toBe(true);
      expect(Array.isArray(r.offense_descriptions)).toBe(true);
      expect(r.nibrs_codes.length).toBe(Number(r.charge_count));
      expect(r.offense_descriptions.length).toBe(Number(r.charge_count));
    }
  });

  test('dashboard-only rows have null pdf_url; pdf rows have a URL', async ({ page }) => {
    const dash = await page.evaluate(() => window.opCrimeMap.runSql(`
      SELECT pdf_url FROM crimes WHERE source = 'dashboard' LIMIT 5
    `));
    expect(dash.length).toBeGreaterThan(0);
    for (const r of dash) expect(r.pdf_url == null).toBe(true);

    const pdf = await page.evaluate(() => window.opCrimeMap.runSql(`
      SELECT pdf_url FROM crimes WHERE source = 'pdf' AND pdf_url IS NOT NULL LIMIT 5
    `));
    expect(pdf.length).toBeGreaterThan(0);
    for (const r of pdf) expect(typeof r.pdf_url).toBe('string');
  });

  test('source=both rows preserve PDF freeform offense in pdf_offense_text', async ({ page }) => {
    const rows = await page.evaluate(() => window.opCrimeMap.runSql(`
      SELECT offense, pdf_offense_text
      FROM crimes
      WHERE source = 'both' AND pdf_offense_text IS NOT NULL
      LIMIT 5
    `));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(typeof r.pdf_offense_text).toBe('string');
  });
});
