import { expect, test } from '@playwright/test';

const oakParkCenter = {
  lat: 41.87984134058715,
  lng: -87.7789930902372
};

// 1x1 transparent PNG. Avoid real OSM network traffic in CI.
const transparentPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
);

test('crime map loads, centers on Oak Park, and populates app caches', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', route => {
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: transparentPng
    });
  });

  await page.goto('/crime_map.html', { waitUntil: 'domcontentloaded' });

  const acceptButton = page.getByRole('button', { name: /i accept/i });
  if (await acceptButton.isVisible().catch(() => false)) {
    await acceptButton.click();
  }

  await expect(page.locator('#loading')).toBeHidden({ timeout: 90000 });
  await expect(page.locator('#panelHeader')).toContainText('Oak Park Crime Map');
  await expect(page.locator('#centerOakPark')).toBeVisible();

  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {
    timeout: 15000
  });

  await page.waitForFunction(() => Boolean(window.opCrimeMap?.getMapState?.()), null, {
    timeout: 90000
  });

  await page.evaluate(() => window.opCrimeMap.centerOnOakPark());
  const state = await page.evaluate(() => window.opCrimeMap.getMapState());

  expect(state.zoom).toBe(13);
  expect(state.center.lat).toBeCloseTo(oakParkCenter.lat, 5);
  expect(state.center.lng).toBeCloseTo(oakParkCenter.lng, 5);

  const mapBox = await page.locator('#map').boundingBox();
  expect(mapBox).not.toBeNull();

  await page.mouse.move(mapBox.x + 80, mapBox.y + 80);
  await page.mouse.wheel(0, -900);
  await page.waitForFunction(
    previousZoom => window.opCrimeMap.getMapState()?.zoom > previousZoom,
    state.zoom
  );

  const zoomedState = await page.evaluate(() => window.opCrimeMap.getMapState());
  expect(zoomedState.center.lat).toBeCloseTo(oakParkCenter.lat, 4);
  expect(zoomedState.center.lng).toBeCloseTo(oakParkCenter.lng, 4);

  const cacheNames = await page.evaluate(() => caches.keys());
  expect(cacheNames.some(name => name.startsWith('op-crime-duckdb-runtime-'))).toBeTruthy();
  expect(cacheNames.some(name => name.startsWith('op-crime-duckdb-data-'))).toBeTruthy();
});
