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
  const tileRequestHeaders = [];

  await page.route('https://tile.openstreetmap.org/**', route => {
    tileRequestHeaders.push(route.request().headers());
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: transparentPng
    });
  });

  const response = await page.goto('/crime_map.html', { waitUntil: 'domcontentloaded' });
  expect(response).not.toBeNull();
  expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');

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

  expect(tileRequestHeaders.some(headers => {
    const referer = headers.referer || headers.referrer;
    return referer && referer.startsWith('http://127.0.0.1:');
  })).toBeTruthy();

  await page.selectOption('#dateSelector', 'all');
  await page.getByRole('button', { name: /apply filters/i }).click();
  await page.waitForFunction(() => {
    const countText = document.querySelector('#crimeCount')?.textContent || '0';
    return Number(countText.replace(/,/g, '')) > 1000;
  }, null, { timeout: 90000 });

  for (let i = 0; i < 6; i += 1) {
    const zoom = await page.evaluate(() => window.opCrimeMap.getMapState()?.zoom || 0);
    if (zoom >= 18) break;

    const clickedClusterSize = await page.evaluate(() => {
      const largestCluster = [...document.querySelectorAll('.marker-cluster')]
        .map(el => ({ el, count: Number(el.textContent.trim()) || 0 }))
        .sort((a, b) => b.count - a.count)[0];

      if (!largestCluster) return 0;

      largestCluster.el.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window
      }));
      return largestCluster.count;
    });

    expect(clickedClusterSize).toBeGreaterThan(1);
    await page.waitForTimeout(1000);
  }

  const maxZoomClusterState = await page.evaluate(() => {
    const clusterCounts = [...document.querySelectorAll('.marker-cluster')]
      .map(el => Number(el.textContent.trim()) || 0);
    return {
      zoom: window.opCrimeMap.getMapState()?.zoom,
      largestCluster: clusterCounts.length ? Math.max(...clusterCounts) : 0
    };
  });

  expect(maxZoomClusterState.zoom).toBe(18);
  expect(maxZoomClusterState.largestCluster).toBeGreaterThan(1);
});
