/* osm-tile-cache-sw.js */

/*
  Oak Park OSM tile cache for OP Crime Map.

  Two-tier cache:
  - Backbone (z9-13, ~100 tiles max): low-zoom orientation tiles.
    Never evicted. Tiny footprint (~3 MB).
  - Hot (z14-18, LRU capped at 2500 entries / ~75 MB): high-zoom browse/detail.
    LRU-evicted when capacity is exceeded.

  Both tiers cache only tiles whose geographic footprint intersects a 5-mile
  radius around Oak Park Village Hall. Outside the radius: no interference.

  Caches are naturally filled by Leaflet requests. No bulk prefetch.
  Freshness uses zoom-tiered TTL written into an 'sw-cached-at' header.
*/

const BACKBONE_CACHE_NAME = 'op-crime-osm-tiles-backbone-v2';
const HOT_CACHE_NAME = 'op-crime-osm-tiles-hot-v2';

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

function isTileHost(hostname) {
    return TILE_HOSTS.has(hostname);
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

async function serveTiered(request, cacheName, event) {
    const cache = await caches.open(cacheName);
    const cachedResponse = await cache.match(request);
    const maxAgeMs = maxAgeForCache(cacheName);

    if (cachedResponse && isFreshEnough(cachedResponse, maxAgeMs)) {
        // Cheap in-memory recency update. No IDB write on hit.
        touchTile(request.url);
        return cachedResponse;
    }

    try {
        const networkResponse = await fetch(request);
        if (
            networkResponse &&
            networkResponse.ok &&
            networkResponse.type !== 'opaque'
        ) {
            // Fire-and-forget cache write. Don't block the page on IDB.
            // event.waitUntil keeps the SW alive until the put completes.
            const responseForCache = responseWithCacheTimestamp(networkResponse.clone());
            const putPromise = cache.put(request, responseForCache)
                .then(() => {
                    touchTile(request.url);
                    if (cacheName === HOT_CACHE_NAME) {
                        scheduleTrim();
                    }
                })
                .catch(() => {});
            if (event && event.waitUntil) {
                event.waitUntil(putPromise);
            }
        }
        return networkResponse;
    } catch (error) {
        // Network failed. Stale cache is better than nothing.
        if (cachedResponse) return cachedResponse;
        throw error;
    }
}

async function logCacheStats() {
    try {
        const [backboneKeys, hotKeys] = await Promise.all([
            caches.open(BACKBONE_CACHE_NAME).then(c => c.keys()),
            caches.open(HOT_CACHE_NAME).then(c => c.keys())
        ]);
        console.log(
            `[SW] tile cache: backbone=${backboneKeys.length} | hot=${hotKeys.length}/${MAX_HOT_CACHE_ENTRIES}`
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
            const keep = new Set([BACKBONE_CACHE_NAME, HOT_CACHE_NAME]);

            await Promise.all(
                cacheNames
                    .filter(name => name.startsWith('op-crime-osm-tiles-') && !keep.has(name))
                    .map(name => caches.delete(name))
            );

            await self.clients.claim();
            logCacheStats();
        })()
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;

    if (!isOsmTileRequest(request)) return;

    const cacheName = getTargetCacheForRequest(request);
    if (!cacheName) return; // outside radius or outside zoom range -> normal fetch

    event.respondWith(serveTiered(request, cacheName, event));
});

// Debug hook: page can postMessage({ type: 'tile-cache-stats' }) to log counts.
// 'ping' messages keep the SW alive across idle gaps so the next tile fetch
// doesn't pay cold-start latency.
self.addEventListener('message', event => {
    if (!event.data) return;
    if (event.data.type === 'tile-cache-stats') {
        logCacheStats();
    }
    // 'ping' is a no-op; just receiving the message keeps us alive.
});
