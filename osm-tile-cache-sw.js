/* osm-tile-cache-sw.js */

/*
  Oak Park OSM tile cache for OP Crime Map.

  Four caches:
  - Backbone (z9-13, ~100 tiles max): low-zoom orientation tiles.
    Never evicted. Tiny footprint (~3 MB).
  - Hot (z14-18, LRU capped at 5000 entries / ~85 MB): high-zoom browse/detail.
    LRU-evicted when capacity is exceeded.
  - DuckDB runtime: the local DuckDB WASM/module/worker assets.
  - DuckDB data: .duckdb files pinned for 11 hours, matching the twice-daily
    update cadence. Stale DB files are used only if refresh fails.

  Both tiers cache only tiles whose geographic footprint intersects a 5-mile
  radius around Oak Park Village Hall. Outside the radius: no interference.

  Caches are naturally filled by Leaflet requests. No bulk prefetch.
  Freshness uses TTLs written into an 'sw-cached-at' header. Cached tiles are
  served immediately even when stale, then refreshed in the background.
*/

const TILE_CACHE_PREFIX = 'op-crime-osm-tiles-';
const BACKBONE_CACHE_NAME = 'op-crime-osm-tiles-backbone-v2';
const HOT_CACHE_NAME = 'op-crime-osm-tiles-hot-v2';
const DUCKDB_RUNTIME_CACHE_PREFIX = 'op-crime-duckdb-runtime-';
const DUCKDB_RUNTIME_CACHE_NAME = `${DUCKDB_RUNTIME_CACHE_PREFIX}v1`;
const DUCKDB_DATA_CACHE_PREFIX = 'op-crime-duckdb-data-';
const DUCKDB_DATA_CACHE_NAME = `${DUCKDB_DATA_CACHE_PREFIX}v1`;

const DUCKDB_RUNTIME_FILE_NAMES = new Set([
    'duckdb-browser.mjs',
    'duckdb-browser-eh.worker.js',
    'duckdb-eh.wasm'
]);

const DUCKDB_REMOTE_RUNTIME_HOSTS = new Set([
    'wasm-proxy.jesse200755.workers.dev',
    'cdn.jsdelivr.net'
]);

const TILE_HOSTS = new Set([
    'tile.openstreetmap.org',
    'a.tile.openstreetmap.org',
    'b.tile.openstreetmap.org',
    'c.tile.openstreetmap.org'
]);

// Same center as the existing crime_map.html constants.
const OAK_PARK_CENTER = {
    lat: 41.87984134058715,
    lng: -87.7789930902372
};

const OAK_PARK_CACHE_RADIUS_MILES = 5;
const OAK_PARK_CACHE_RADIUS_METERS = OAK_PARK_CACHE_RADIUS_MILES * 1609.344;

// Zoom tiers.
const BACKBONE_MIN_ZOOM = 9;
const BACKBONE_MAX_ZOOM = 13;
const HOT_MIN_ZOOM = 14;
const HOT_MAX_ZOOM = 18;

// Only the hot tier is capped. Backbone is bounded by geometry (~100 tiles).
// At ~17 KB per tile in practice, 5000 entries ≈ ~85 MB ceiling.
const MAX_HOT_CACHE_ENTRIES = 5000;

// Zoom-tiered TTL. OSM high-zoom tiles change slowly.
const BACKBONE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const HOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DUCKDB_RUNTIME_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const DUCKDB_DATA_MAX_AGE_MS = 11 * 60 * 60 * 1000;

function isTileHost(hostname) {
    return TILE_HOSTS.has(hostname);
}

function lastPathSegment(pathname) {
    const index = pathname.lastIndexOf('/');
    return index === -1 ? pathname : pathname.slice(index + 1);
}

function isSameOriginDuckDBRuntime(url, fileName) {
    return (
        url.origin === self.location.origin &&
        url.pathname.endsWith(`/js/duckdb/${fileName}`)
    );
}

function isRemoteDuckDBRuntime(url, fileName) {
    if (!DUCKDB_REMOTE_RUNTIME_HOSTS.has(url.hostname)) return false;

    if (url.hostname === 'wasm-proxy.jesse200755.workers.dev') {
        return fileName === 'duckdb-browser-eh.worker.js' || fileName === 'duckdb-eh.wasm';
    }

    return (
        url.hostname === 'cdn.jsdelivr.net' &&
        url.pathname.includes('/@duckdb/duckdb-wasm@') &&
        (fileName === 'duckdb-browser-eh.worker.js' || fileName === 'duckdb-eh.wasm')
    );
}

function isDuckDBRuntimeRequest(request) {
    if (request.method !== 'GET') return false;

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return false;
    }

    // Runtime matching must not claim DB files; data caching has a separate
    // 11-hour TTL below.
    if (url.pathname.includes('/db/')) return false;

    const fileName = lastPathSegment(url.pathname);
    if (!DUCKDB_RUNTIME_FILE_NAMES.has(fileName)) return false;

    return isSameOriginDuckDBRuntime(url, fileName) || isRemoteDuckDBRuntime(url, fileName);
}

function isDuckDBDataRequest(request) {
    if (request.method !== 'GET') return false;

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return false;
    }

    return (
        url.origin === self.location.origin &&
        url.pathname.includes('/db/') &&
        url.pathname.endsWith('.duckdb')
    );
}

function parseTilePath(pathname) {
    const match = pathname.match(/^\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (!match) return null;

    const z = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);

    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
        return null;
    }

    return { z, x, y };
}

function tile2lon(x, z) {
    return x / Math.pow(2, z) * 360 - 180;
}

function tile2lat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

function getTileBounds(z, x, y) {
    return {
        north: tile2lat(y, z),
        south: tile2lat(y + 1, z),
        east: tile2lon(x + 1, z),
        west: tile2lon(x, z)
    };
}

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

function haversineMeters(a, b) {
    const earthRadiusMeters = 6371008.8;
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const deltaLat = toRadians(b.lat - a.lat);
    const deltaLng = toRadians(b.lng - a.lng);
    const sinLat = Math.sin(deltaLat / 2);
    const sinLng = Math.sin(deltaLng / 2);
    const h = sinLat * sinLat +
        Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

// Closest-point-to-circle test: does tile rect intersect the 5-mile circle?
function tileIntersectsOakParkCacheCircle(tileBounds) {
    const closestPoint = {
        lat: clamp(OAK_PARK_CENTER.lat, tileBounds.south, tileBounds.north),
        lng: clamp(OAK_PARK_CENTER.lng, tileBounds.west, tileBounds.east)
    };
    return haversineMeters(OAK_PARK_CENTER, closestPoint) <= OAK_PARK_CACHE_RADIUS_METERS;
}

function chooseCacheForTile(tile) {
    if (tile.z >= BACKBONE_MIN_ZOOM && tile.z <= BACKBONE_MAX_ZOOM) {
        return BACKBONE_CACHE_NAME;
    }
    if (tile.z >= HOT_MIN_ZOOM && tile.z <= HOT_MAX_ZOOM) {
        return HOT_CACHE_NAME;
    }
    return null;
}

function maxAgeForCache(cacheName) {
    return cacheName === BACKBONE_CACHE_NAME ? BACKBONE_MAX_AGE_MS : HOT_MAX_AGE_MS;
}

function getTargetCacheForRequest(request) {
    if (request.method !== 'GET') return null;

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return null;
    }

    if (!isTileHost(url.hostname)) return null;

    const tile = parseTilePath(url.pathname);
    if (!tile) return null;

    const cacheName = chooseCacheForTile(tile);
    if (!cacheName) return null;

    const tileBounds = getTileBounds(tile.z, tile.x, tile.y);
    if (!tileIntersectsOakParkCacheCircle(tileBounds)) return null;

    return cacheName;
}

function isOsmTileRequest(request) {
    if (request.method !== 'GET') return false;

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return false;
    }

    if (!isTileHost(url.hostname)) return false;
    return parseTilePath(url.pathname) !== null;
}

// In-memory LRU tracking. Map: request URL -> last-access timestamp.
// Avoids doing extra IDB writes on every cache hit (the previous bumpLRU
// approach saturated IndexedDB and caused multi-second cache reads).
// Map resets on SW restart; we rebuild it on the fly from hits/puts.
const tileLastTouched = new Map();

function touchTile(url) {
    tileLastTouched.set(url, Date.now());
}

// LRU trim using the in-memory touch map. Tiles with no tracked timestamp
// (e.g., cached before the most recent SW restart) are treated as oldest
// and evicted first.
async function trimCache(cacheName, maxEntries) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;

    const deleteCount = keys.length - maxEntries;

    const ranked = keys.map(req => ({
        req,
        touched: tileLastTouched.get(req.url) ?? 0
    }));
    ranked.sort((a, b) => a.touched - b.touched);

    for (let i = 0; i < deleteCount; i++) {
        await cache.delete(ranked[i].req);
        tileLastTouched.delete(ranked[i].req.url);
    }
    console.log(`[SW] ${cacheName} trimmed ${deleteCount} (was ${keys.length}, now ${maxEntries})`);
}

function responseWithCacheTimestamp(response) {
    const headers = new Headers(response.headers);
    headers.set('sw-cached-at', String(Date.now()));
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

function getCachedAt(response) {
    const cachedAt = response.headers.get('sw-cached-at');
    if (!cachedAt) return 0;
    const timestamp = Number(cachedAt);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function isFreshEnough(cachedResponse, maxAgeMs) {
    const cachedAt = getCachedAt(cachedResponse);
    if (!cachedAt) return false;
    return Date.now() - cachedAt < maxAgeMs;
}

function canStoreResponse(response) {
    return (
        response &&
        response.ok &&
        (response.type === 'basic' || response.type === 'cors' || response.type === 'default')
    );
}

// Throttle trim so it doesn't fire on every single put under load.
let trimScheduled = false;
function scheduleTrim() {
    if (trimScheduled) return;
    trimScheduled = true;
    setTimeout(() => {
        trimScheduled = false;
        trimCache(HOT_CACHE_NAME, MAX_HOT_CACHE_ENTRIES).catch(() => {});
    }, 5000);
}

const revalidationsInFlight = new Map();

function waitUntil(event, promise) {
    if (event && event.waitUntil) {
        event.waitUntil(promise);
    }
}

async function writeResponseToCache(cache, request, response, options = {}) {
    if (!canStoreResponse(response)) return;

    const responseForCache = responseWithCacheTimestamp(response.clone());
    await cache.put(request, responseForCache);

    if (options.touchTile) {
        touchTile(request.url);
    }
    if (options.trimHotCache) {
        scheduleTrim();
    }
}

async function fetchAndCache(request, cache, event, options = {}) {
    const networkResponse = await fetch(request);

    if (canStoreResponse(networkResponse)) {
        const putPromise = writeResponseToCache(cache, request, networkResponse, options)
            .catch(() => {});

        if (options.waitForCache) {
            await putPromise;
        } else {
            waitUntil(event, putPromise);
        }
    }

    return networkResponse;
}

function revalidateInBackground(request, cacheName, event, options = {}) {
    const key = `${cacheName}|${request.url}`;
    if (revalidationsInFlight.has(key)) return;

    const promise = (async () => {
        const cache = await caches.open(cacheName);
        await fetchAndCache(request, cache, event, {
            ...options,
            waitForCache: true
        });
    })()
        .catch(() => {})
        .finally(() => {
            revalidationsInFlight.delete(key);
        });

    revalidationsInFlight.set(key, promise);
    waitUntil(event, promise);
}

async function serveCacheFirst(request, cacheName, maxAgeMs, event, options = {}) {
    const cache = await caches.open(cacheName);
    const cachedResponse = await cache.match(request, { ignoreVary: true });

    if (cachedResponse) {
        if (options.touchTile) {
            touchTile(request.url);
        }
        if (!isFreshEnough(cachedResponse, maxAgeMs)) {
            revalidateInBackground(request, cacheName, event, options);
        }
        return cachedResponse;
    }

    try {
        return await fetchAndCache(request, cache, event, options);
    } catch (error) {
        throw error;
    }
}

async function serveTile(request, cacheName, event) {
    return serveCacheFirst(request, cacheName, maxAgeForCache(cacheName), event, {
        touchTile: true,
        trimHotCache: cacheName === HOT_CACHE_NAME
    });
}

async function serveDuckDBRuntime(request, event) {
    return serveCacheFirst(request, DUCKDB_RUNTIME_CACHE_NAME, DUCKDB_RUNTIME_MAX_AGE_MS, event);
}

async function serveDuckDBData(request, event) {
    const cache = await caches.open(DUCKDB_DATA_CACHE_NAME);
    const cachedResponse = await cache.match(request, { ignoreVary: true });

    if (cachedResponse && isFreshEnough(cachedResponse, DUCKDB_DATA_MAX_AGE_MS)) {
        return cachedResponse;
    }

    try {
        return await fetchAndCache(request, cache, event);
    } catch (error) {
        if (cachedResponse) return cachedResponse;
        throw error;
    }
}

async function logCacheStats() {
    try {
        const [backboneKeys, hotKeys, duckdbRuntimeKeys, duckdbDataKeys] = await Promise.all([
            caches.open(BACKBONE_CACHE_NAME).then(c => c.keys()),
            caches.open(HOT_CACHE_NAME).then(c => c.keys()),
            caches.open(DUCKDB_RUNTIME_CACHE_NAME).then(c => c.keys()),
            caches.open(DUCKDB_DATA_CACHE_NAME).then(c => c.keys())
        ]);
        console.log(
            `[SW] caches: tile backbone=${backboneKeys.length} | tile hot=${hotKeys.length}/${MAX_HOT_CACHE_ENTRIES} | duckdb runtime=${duckdbRuntimeKeys.length} | duckdb data=${duckdbDataKeys.length}`
        );
    } catch {
        // ignore
    }
}

self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        (async () => {
            const cacheNames = await caches.keys();
            const keep = new Set([
                BACKBONE_CACHE_NAME,
                HOT_CACHE_NAME,
                DUCKDB_RUNTIME_CACHE_NAME,
                DUCKDB_DATA_CACHE_NAME
            ]);

            await Promise.all(
                cacheNames
                    .filter(name => (
                        (
                            name.startsWith(TILE_CACHE_PREFIX) ||
                            name.startsWith(DUCKDB_RUNTIME_CACHE_PREFIX) ||
                            name.startsWith(DUCKDB_DATA_CACHE_PREFIX)
                        ) &&
                        !keep.has(name)
                    ))
                    .map(name => caches.delete(name))
            );

            await self.clients.claim();
            logCacheStats();
        })()
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;

    if (isDuckDBRuntimeRequest(request)) {
        event.respondWith(serveDuckDBRuntime(request, event));
        return;
    }

    if (isDuckDBDataRequest(request)) {
        event.respondWith(serveDuckDBData(request, event));
        return;
    }

    if (!isOsmTileRequest(request)) return;

    const cacheName = getTargetCacheForRequest(request);
    if (!cacheName) return; // outside radius or outside zoom range -> normal fetch

    event.respondWith(serveTile(request, cacheName, event));
});

// Debug hook: page can postMessage({ type: 'app-cache-stats' }) to log counts.
// 'ping' messages keep the SW alive across idle gaps so the next tile fetch
// doesn't pay cold-start latency.
self.addEventListener('message', event => {
    if (!event.data) return;
    if (event.data.type === 'tile-cache-stats' || event.data.type === 'app-cache-stats') {
        logCacheStats();
    }
    // 'ping' is a no-op; just receiving the message keeps us alive.
});
