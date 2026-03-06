// worker.js
// 完整最终版（文本可浏览，不强制下载）
// KV: TEXT_STORAGE, LINK_META
// ENV: ADMIN_TOKEN=zheshimima

const PROXY_SERVER_URL = 'https://my-vercel-proxy-one.vercel.app/api/proxy';
const YAML_CONVERT_API = 'https://dyzhapi.vercel.app/api/convert?clash&token=auto';
const PROXY_PLACEHOLDER = '__proxy_link_placeholder__';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'Clash Verge/v1.7.8',
  'Shadowrocket/1872 CFNetwork/1408.0.4 Darwin/22.5.0',
  'ClashforWindows/0.20.39',
];

function nowIso() {
  return new Date().toISOString();
}

function generateCustomShortId(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  return Array.from(randomValues, v => chars[v % chars.length]).join('');
}

function encodeBase64FromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function decodeBase64ToUint8Array(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function textResponse(text, status = 200, headers = {}) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
  });
}

function parseAuth(request, env) {
  const required = (env.ADMIN_TOKEN || '').trim();
  if (!required) return true;
  const auth = (request.headers.get('Authorization') || request.headers.get('authorization') || '').trim();
  if (!auth.toLowerCase().startsWith('bearer ')) return false;
  return auth.slice(7).trim() === required;
}

function getClientIp(request) {
  const xff = request.headers.get('x-forwarded-for');
  if (!xff) return '';
  return xff.split(',')[0].trim();
}

function isIPv4(hostname) {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  return ipv4Regex.test(hostname) && hostname.split('.').every(part => {
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function isIPv6(hostname) {
  return hostname.includes(':');
}

function buildUpstreamUrl(targetUrl, proxyServerUrl) {
  const u = new URL(targetUrl);
  if ((isIPv4(u.hostname) || isIPv6(u.hostname)) && proxyServerUrl) {
    return `${proxyServerUrl}?url=${encodeURIComponent(targetUrl)}`;
  }
  return targetUrl;
}

function headerAny(headers, keys) {
  for (const k of keys) {
    const v = headers.get(k);
    if (v !== null && v !== undefined) return v;
  }
  return '';
}

function getHeaderTrimmed(request, names) {
  for (const name of names) {
    const v = request.headers.get(name);
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

function copyHeadersRaw(upstreamHeaders, extra = {}, fallback = {}) {
  const out = new Headers();

  for (const [k, v] of upstreamHeaders.entries()) {
    const lk = k.toLowerCase();
    if (
      lk === 'transfer-encoding' ||
      lk === 'connection' ||
      lk === 'content-length' ||
      lk === 'content-disposition'
    ) continue;
    out.set(k, v);
  }

  const subInfo =
    headerAny(upstreamHeaders, [
      'subscription-userinfo',
      'Subscription-Userinfo',
      'x-subscription-userinfo',
      'X-Subscription-Userinfo'
    ]) || fallback.subscriptionUserinfo || '';
  if (subInfo) out.set('subscription-userinfo', subInfo);

  const pui =
    headerAny(upstreamHeaders, [
      'profile-update-interval',
      'Profile-Update-Interval',
      'x-profile-update-interval',
      'X-Profile-Update-Interval'
    ]) || fallback.profileUpdateInterval || '';
  if (pui) out.set('profile-update-interval', pui);

  for (const [k, v] of Object.entries(extra)) out.set(k, String(v));
  return out;
}

function normalizeTextContentType() {
  return 'text/plain; charset=utf-8';
}

async function generateUniqueShortId(textKV, metaKV, retries = 8) {
  for (let i = 0; i < retries; i++) {
    const shortId = generateCustomShortId(8);
    const [existsText, existsMeta] = await Promise.all([
      textKV.get(shortId),
      metaKV.get(shortId),
    ]);
    if (existsText === null && existsMeta === null) return shortId;
  }
  throw new Error('Failed to generate a unique short ID');
}

async function getMeta(env, shortId) {
  const raw = await env.LINK_META.get(shortId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveMeta(env, shortId, metaObj) {
  await env.LINK_META.put(shortId, JSON.stringify(metaObj));
}

async function fetchOriginWithRotation(targetUrl, clientIp = '', method = 'GET', proxyServerUrl = '') {
  let lastError = null;
  const finalUrl = buildUpstreamUrl(targetUrl, proxyServerUrl);

  for (let uaIdx = 0; uaIdx < USER_AGENTS.length; uaIdx++) {
    const ua = USER_AGENTS[uaIdx];

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const resp = await fetch(finalUrl, {
          method,
          headers: {
            'User-Agent': ua,
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'X-Forwarded-For': clientIp || '',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(12000),
        });

        if (resp.ok) return { response: resp, usedUA: ua, fetchedUrl: finalUrl };

        if ([403, 429, 503].includes(resp.status)) {
          lastError = new Error(`HTTP ${resp.status} blocked by upstream`);
          break;
        }

        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 700 * attempt));
          continue;
        }

        lastError = new Error(`HTTP ${resp.status}`);
      } catch (e) {
        lastError = e;
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 900 * attempt));
          continue;
        }
      }
    }

    if (uaIdx < USER_AGENTS.length - 1) {
      await new Promise(r => setTimeout(r, 250));
    }
  }

  throw lastError || new Error('All UA requests failed');
}

async function fetchYamlFromSubscription(targetUrl) {
  const convertUrl = `${YAML_CONVERT_API}&sub=${encodeURIComponent(targetUrl)}`;
  const resp = await fetch(convertUrl, {
    method: 'GET',
    headers: {
      'User-Agent': 'clash-verge/v1.5.1',
      'Accept': '*/*',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) {
    throw new Error(`yaml convert failed: HTTP ${resp.status}`);
  }

  const body = await resp.arrayBuffer();
  const text = new TextDecoder().decode(body);

  if (!text.includes('proxies:') || !text.includes('proxy-groups:')) {
    throw new Error('yaml convert failed: invalid clash yaml');
  }

  return {
    body,
    contentType: normalizeTextContentType(),
    contentDisposition: '',
  };
}

function isCacheKey(name) {
  return name.startsWith('cache_');
}

function buildTextCustomHeaders(meta) {
  const h = new Headers();
  const custom = meta?.custom || null;
  if (!custom) return h;

  const profileName = String(custom.profileName || '').trim();
  const subInfo = String(custom.subscriptionUserinfo || '').trim();

  if (subInfo) h.set('subscription-userinfo', subInfo);
  if (profileName) {
    h.set('profile-title', profileName);
    h.set('profile-name', profileName);
  }

  return h;
}

function buildProxyCustomHeaders(meta) {
  const h = new Headers();
  const profileName = String(meta?.custom?.profileName || '').trim();
  const subInfo = String(meta?.custom?.subscriptionUserinfo || '').trim();

  if (profileName) {
    h.set('profile-title', profileName);
    h.set('profile-name', profileName);
  }
  if (subInfo) h.set('subscription-userinfo', subInfo);

  return h;
}

function buildListItemFromMeta(meta, shortId, origin) {
  const type = meta?.type || 'text';
  const customName = String(meta?.custom?.profileName || '').trim();

  let targetDisplay = '';
  if (type === 'proxy') {
    targetDisplay = customName || String(meta?.targetUrl || '');
  } else {
    targetDisplay = '文本';
  }

  return {
    id: shortId,
    shortLink: `${origin}/${shortId}`,
    type,
    targetUrl: targetDisplay,
    rawTargetUrl: type === 'proxy' ? (meta?.targetUrl || '') : '',
    status: meta?.lastStatus ?? null,
    updatedAt: meta?.updatedAt || '',
    cacheUpdatedAt: meta?.cacheUpdatedAt || '',
    custom: meta?.custom || null,
    mode: meta?.mode || (type === 'proxy' ? 'raw' : ''),
  };
}

function buildListItemLegacy(shortId, origin) {
  return {
    id: shortId,
    shortLink: `${origin}/${shortId}`,
    type: 'text_legacy',
    targetUrl: '文本',
    rawTargetUrl: '',
    status: null,
    updatedAt: '',
    cacheUpdatedAt: '',
    custom: null,
    mode: '',
  };
}

async function getAllShortIds(env) {
  const metaIds = [];
  let metaCursor;

  while (true) {
    const listed = await env.LINK_META.list({ limit: 1000, cursor: metaCursor });
    for (const k of listed.keys || []) {
      if (!isCacheKey(k.name)) metaIds.push(k.name);
    }
    if (listed.list_complete) break;
    metaCursor = listed.cursor;
  }

  const metaSet = new Set(metaIds);
  const legacyIds = [];
  let textCursor;

  while (true) {
    const listed = await env.TEXT_STORAGE.list({ limit: 1000, cursor: textCursor });
    for (const k of listed.keys || []) {
      if (metaSet.has(k.name)) continue;
      const val = await env.TEXT_STORAGE.get(k.name);
      if (val !== null && val !== PROXY_PLACEHOLDER) legacyIds.push(k.name);
    }
    if (listed.list_complete) break;
    textCursor = listed.cursor;
  }

  const all = [...metaIds, ...legacyIds];
  all.sort((a, b) => b.localeCompare(a));
  return all;
}

function paginateArrayByCursor(allIds, limit = 8, cursor = '') {
  const safeLimit = Math.max(1, Math.min(50, limit));
  let startIndex = 0;

  if (cursor) {
    const idx = parseInt(cursor, 10);
    if (!Number.isNaN(idx) && idx >= 0 && idx < allIds.length) {
      startIndex = idx;
    }
  }

  const pageItems = allIds.slice(startIndex, startIndex + safeLimit);
  const nextIndex = startIndex + safeLimit;
  const nextCursor = nextIndex < allIds.length ? String(nextIndex) : null;

  return {
    pageItems,
    nextCursor,
    listComplete: nextCursor === null,
    startIndex,
  };
}

async function buildListItemsFromIds(env, ids, origin) {
  const items = [];
  for (const shortId of ids) {
    const meta = await getMeta(env, shortId);
    if (meta) items.push(buildListItemFromMeta(meta, shortId, origin));
    else items.push(buildListItemLegacy(shortId, origin));
  }
  return items;
}

async function filterIdsByKind(env, allIds, kind = 'all') {
  if (kind === 'all') return allIds;

  const filtered = [];
  for (const shortId of allIds) {
    const meta = await getMeta(env, shortId);

    if (kind === 'proxy') {
      if (meta?.type === 'proxy') filtered.push(shortId);
      continue;
    }

    if (kind === 'text') {
      if (!meta) {
        const val = await env.TEXT_STORAGE.get(shortId);
        if (val !== null && val !== PROXY_PLACEHOLDER) filtered.push(shortId);
      } else if (meta.type !== 'proxy') {
        filtered.push(shortId);
      }
      continue;
    }

    filtered.push(shortId);
  }
  return filtered;
}

async function listAllByCursor(env, origin, limit = 8, cursor = '', kind = 'all') {
  const allIds = await getAllShortIds(env);
  const filteredIds = await filterIdsByKind(env, allIds, kind);
  const paged = paginateArrayByCursor(filteredIds, limit, cursor);
  const items = await buildListItemsFromIds(env, paged.pageItems, origin);

  return {
    items,
    cursor: paged.nextCursor,
    listComplete: paged.listComplete,
    total: filteredIds.length,
    startIndex: paged.startIndex,
  };
}

async function listAllByPage(env, origin, page = 1, pageSize = 8, maxWalkPages = 50, kind = 'all') {
  const safePage = Math.max(1, page);
  const safeSize = Math.max(1, Math.min(50, pageSize));
  const allIds = await getAllShortIds(env);
  const filteredIds = await filterIdsByKind(env, allIds, kind);

  let note = '';
  const pageLimited = safePage > maxWalkPages ? maxWalkPages : safePage;
  if (safePage > maxWalkPages) {
    note = `page 跳页最多走 ${maxWalkPages} 页，已限制到第 ${maxWalkPages} 页`;
  }

  const startIndex = (pageLimited - 1) * safeSize;
  const pageIds = filteredIds.slice(startIndex, startIndex + safeSize);
  const items = await buildListItemsFromIds(env, pageIds, origin);
  const nextCursor = startIndex + safeSize < filteredIds.length ? String(startIndex + safeSize) : null;

  return {
    items,
    page: pageLimited,
    pageSize: safeSize,
    total: filteredIds.length,
    totalPages: Math.max(1, Math.ceil(filteredIds.length / safeSize)),
    startIndex,
    cursor: nextCursor,
    note,
  };
}

async function listLegacyIds(env) {
  const ids = [];
  let cursor;

  while (true) {
    const listed = await env.TEXT_STORAGE.list({ limit: 1000, cursor });
    for (const k of listed.keys || []) {
      const shortId = k.name;
      const meta = await getMeta(env, shortId);
      if (meta) continue;
      const val = await env.TEXT_STORAGE.get(shortId);
      if (val !== null && val !== PROXY_PLACEHOLDER) ids.push(shortId);
    }
    if (listed.list_complete) break;
    cursor = listed.cursor;
  }

  ids.sort((a, b) => b.localeCompare(a));
  return ids;
}

async function listLegacyCursor(env, origin, limit = 8, cursor = '') {
  const allIds = await listLegacyIds(env);
  const paged = paginateArrayByCursor(allIds, limit, cursor);
  const items = paged.pageItems.map(id => buildListItemLegacy(id, origin));

  return {
    items,
    cursor: paged.nextCursor,
    listComplete: paged.listComplete,
    total: allIds.length,
    startIndex: paged.startIndex,
  };
}

async function listLegacyByPage(env, origin, page = 1, pageSize = 8, maxWalkPages = 50) {
  const safePage = Math.max(1, page);
  const safeSize = Math.max(1, Math.min(50, pageSize));
  const allIds = await listLegacyIds(env);

  let note = '';
  const pageLimited = safePage > maxWalkPages ? maxWalkPages : safePage;
  if (safePage > maxWalkPages) {
    note = `page 跳页最多走 ${maxWalkPages} 页，已限制到第 ${maxWalkPages} 页`;
  }

  const startIndex = (pageLimited - 1) * safeSize;
  const pageIds = allIds.slice(startIndex, startIndex + safeSize);
  const items = pageIds.map(id => buildListItemLegacy(id, origin));
  const nextCursor = startIndex + safeSize < allIds.length ? String(startIndex + safeSize) : null;

  return {
    items,
    page: pageLimited,
    pageSize: safeSize,
    total: allIds.length,
    totalPages: Math.max(1, Math.ceil(allIds.length / safeSize)),
    startIndex,
    cursor: nextCursor,
    note,
  };
}

function sanitizeCustomInput(profileNameRaw, subInfoRaw) {
  const profileName = String(profileNameRaw || '').trim().slice(0, 64);
  const subscriptionUserinfo = String(subInfoRaw || '').trim().slice(0, 512);
  return { profileName, subscriptionUserinfo };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Filename, X-Profile-Name, X-Subscription-Userinfo',
      'Access-Control-Expose-Headers': 'subscription-userinfo, profile-update-interval, profile-title, profile-name',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (!env.TEXT_STORAGE) return textResponse('Missing KV binding: TEXT_STORAGE', 500, corsHeaders);
    if (!env.LINK_META) return textResponse('Missing KV binding: LINK_META', 500, corsHeaders);

    if (url.pathname === '/api/admin/list' && request.method === 'GET') {
      if (!parseAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '8', 10) || 8));
      const cursor = url.searchParams.get('cursor') || '';
      const page = parseInt(url.searchParams.get('page') || '0', 10) || 0;
      const kindRaw = String(url.searchParams.get('kind') || 'all').trim().toLowerCase();
      const kind = ['all', 'text', 'proxy'].includes(kindRaw) ? kindRaw : 'all';

      if (page > 0) {
        const data = await listAllByPage(env, url.origin, page, limit, 50, kind);
        return jsonResponse({
          items: data.items,
          page: data.page,
          totalPages: data.totalPages,
          total: data.total,
          startIndex: data.startIndex + 1,
          pageSize: data.pageSize,
          cursor: data.cursor,
          note: data.note || '',
          mode: 'page',
          kind,
        }, 200, corsHeaders);
      }

      const data = await listAllByCursor(env, url.origin, limit, cursor, kind);
      return jsonResponse({
        items: data.items,
        cursor: data.cursor,
        listComplete: data.listComplete,
        total: data.total,
        startIndex: data.startIndex + 1,
        pageSize: limit,
        mode: 'cursor',
        kind,
      }, 200, corsHeaders);
    }

    if (url.pathname === '/api/admin/legacy/list' && request.method === 'GET') {
      if (!parseAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '8', 10) || 8));
      const cursor = url.searchParams.get('cursor') || '';
      const page = parseInt(url.searchParams.get('page') || '0', 10) || 0;

      if (page > 0) {
        const data = await listLegacyByPage(env, url.origin, page, limit, 50);
        return jsonResponse({
          items: data.items,
          page: data.page,
          totalPages: data.totalPages,
          total: data.total,
          startIndex: data.startIndex + 1,
          pageSize: data.pageSize,
          cursor: data.cursor,
          note: data.note || '',
          mode: 'page',
        }, 200, corsHeaders);
      }

      const data = await listLegacyCursor(env, url.origin, limit, cursor);
      return jsonResponse({
        items: data.items,
        cursor: data.cursor,
        listComplete: data.listComplete,
        total: data.total,
        startIndex: data.startIndex + 1,
        pageSize: limit,
        mode: 'cursor',
      }, 200, corsHeaders);
    }

    if (url.pathname.startsWith('/api/admin/detail/') && request.method === 'GET') {
      if (!parseAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      const shortId = decodeURIComponent(url.pathname.replace('/api/admin/detail/', '').trim());
      if (!shortId) return jsonResponse({ error: 'Invalid shortId' }, 400, corsHeaders);

      const meta = await getMeta(env, shortId);
      const shortLink = `${url.origin}/${shortId}`;

      if (!meta) {
        const text = await env.TEXT_STORAGE.get(shortId);
        if (text === null) return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
        return jsonResponse({
          meta: {
            type: 'text_legacy',
            shortId,
            targetUrl: '文本',
            custom: null
          },
          cache: null,
          shortLink
        }, 200, corsHeaders);
      }

      const cache = await env.LINK_META.get(`cache_${shortId}`, { type: 'json' });
      const safeMeta = {
        ...meta,
        mode: meta.mode || 'raw',
        targetUrl: meta.type === 'proxy'
          ? (String(meta?.custom?.profileName || '').trim() || meta.targetUrl || '')
          : '文本',
      };

      return jsonResponse({ meta: safeMeta, cache: cache || null, shortLink }, 200, corsHeaders);
    }

    if (url.pathname.startsWith('/api/admin/delete/') && request.method === 'DELETE') {
      if (!parseAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      const shortId = decodeURIComponent(url.pathname.replace('/api/admin/delete/', '').trim());
      if (!shortId) return jsonResponse({ error: 'Invalid shortId' }, 400, corsHeaders);

      await env.TEXT_STORAGE.delete(shortId);
      await env.LINK_META.delete(shortId);
      await env.LINK_META.delete(`cache_${shortId}`);
      return jsonResponse({ ok: true, shortId }, 200, corsHeaders);
    }

    if (url.pathname.startsWith('/api/admin/refresh/') && request.method === 'POST') {
      if (!parseAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      const shortId = decodeURIComponent(url.pathname.replace('/api/admin/refresh/', '').trim());
      const meta = await getMeta(env, shortId);
      if (!meta || meta.type !== 'proxy') {
        return jsonResponse({ error: 'Only proxy link can refresh' }, 400, corsHeaders);
      }

      const nowMs = Date.now();
      const lastRefresh = meta.lastRefreshAt ? Date.parse(meta.lastRefreshAt) : 0;
      if (lastRefresh && !Number.isNaN(lastRefresh) && (nowMs - lastRefresh < 30_000)) {
        return jsonResponse({ error: 'refresh too frequent, wait 30s' }, 429, corsHeaders);
      }

      try {
        await env.LINK_META.delete(`cache_${shortId}`);

        const { response, usedUA, fetchedUrl } = await fetchOriginWithRotation(
          meta.targetUrl,
          getClientIp(request),
          'GET',
          PROXY_SERVER_URL
        );

        const originSubInfo = headerAny(response.headers, [
          'subscription-userinfo',
          'Subscription-Userinfo',
          'x-subscription-userinfo',
          'X-Subscription-Userinfo'
        ]);
        const originPui = headerAny(response.headers, [
          'profile-update-interval',
          'Profile-Update-Interval',
          'x-profile-update-interval',
          'X-Profile-Update-Interval'
        ]);

        let finalBody;
        if (meta.mode === 'yaml') {
          const yamlResult = await fetchYamlFromSubscription(meta.targetUrl);
          finalBody = yamlResult.body;
        } else {
          finalBody = await response.arrayBuffer();
        }

        const now = nowIso();
        const customSubInfo = String(meta?.custom?.subscriptionUserinfo || '').trim();
        const finalSubInfo = customSubInfo || originSubInfo || '';

        meta.snapshot = {
          bodyBase64: encodeBase64FromArrayBuffer(finalBody),
          contentType: normalizeTextContentType(),
          contentDisposition: '',
          subscriptionUserinfo: finalSubInfo,
          profileUpdateInterval: originPui,
          fetchedAt: now,
          upstreamStatus: response.status,
          usedUA,
          fetchedUrl,
        };
        meta.lastStatus = response.status;
        meta.updatedAt = now;
        meta.cacheUpdatedAt = now;
        meta.lastRefreshAt = now;
        await saveMeta(env, shortId, meta);

        await env.LINK_META.put(`cache_${shortId}`, JSON.stringify({
          bodyBase64: encodeBase64FromArrayBuffer(finalBody),
          contentType: normalizeTextContentType(),
          contentDisposition: '',
          subscriptionUserinfo: finalSubInfo,
          profileUpdateInterval: originPui,
          fetchedAt: now,
        }));

        return jsonResponse({ ok: true, shortId, cacheUpdatedAt: now }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: `refresh failed: ${e.message}` }, 502, corsHeaders);
      }
    }

    if (url.pathname.startsWith('/api/admin/update/') && request.method === 'PUT') {
      if (!parseAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      const shortId = decodeURIComponent(url.pathname.replace('/api/admin/update/', '').trim());
      const newText = await request.text();
      if (!shortId || !newText) return jsonResponse({ error: 'Invalid' }, 400, corsHeaders);

      const meta = await getMeta(env, shortId);
      if (meta?.type === 'proxy') return jsonResponse({ error: 'Proxy cannot update by text' }, 400, corsHeaders);

      await env.TEXT_STORAGE.put(shortId, newText);

      const metaNew = meta || { shortId, createdAt: nowIso() };
      metaNew.type = 'text';
      metaNew.shortId = shortId;
      metaNew.updatedAt = nowIso();
      metaNew.textLength = newText.length;
      if (!metaNew.createdAt) metaNew.createdAt = nowIso();
      await saveMeta(env, shortId, metaNew);

      await env.LINK_META.delete(`cache_${shortId}`);
      return jsonResponse({ ok: true, shortId }, 200, corsHeaders);
    }

    if (url.pathname.startsWith('/api/admin/customize/') && request.method === 'PUT') {
      if (!parseAuth(request, env)) return jsonResponse({ error: 'Unauthorized' }, 401, corsHeaders);

      const shortId = decodeURIComponent(url.pathname.replace('/api/admin/customize/', '').trim());
      if (!shortId) return jsonResponse({ error: 'Invalid shortId' }, 400, corsHeaders);

      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return jsonResponse({ error: 'Invalid JSON' }, 400, corsHeaders);

      const meta = await getMeta(env, shortId);
      if (!meta) {
        const old = await env.TEXT_STORAGE.get(shortId);
        if (old === null) return jsonResponse({ error: 'Not found' }, 404, corsHeaders);
      }

      const metaNew = meta || { shortId, createdAt: nowIso(), type: 'text' };

      if (body.clear === true) {
        delete metaNew.custom;
      } else {
        const safe = sanitizeCustomInput(body.profileName, body.subscriptionUserinfo);
        metaNew.custom = {
          profileName: safe.profileName,
          subscriptionUserinfo: safe.subscriptionUserinfo,
        };
      }

      metaNew.updatedAt = nowIso();
      await saveMeta(env, shortId, metaNew);

      return jsonResponse({ ok: true, shortId }, 200, corsHeaders);
    }

    if (
      (url.pathname === '/api/store/permanent' ||
        url.pathname === '/api/store/7d' ||
        url.pathname === '/api/store') &&
      request.method === 'POST'
    ) {
      const text = await request.text();
      if (!text) return textResponse('Text content is required.', 400, corsHeaders);

      const shortId = await generateUniqueShortId(env.TEXT_STORAGE, env.LINK_META);
      await env.TEXT_STORAGE.put(shortId, text);

      const profileName = getHeaderTrimmed(request, ['X-Profile-Name', 'x-profile-name']);
      const subscriptionUserinfo = getHeaderTrimmed(request, ['X-Subscription-Userinfo', 'x-subscription-userinfo']);

      const meta = {
        type: 'text',
        shortId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        textLength: text.length,
        ttlType: url.pathname === '/api/store/permanent'
          ? 'permanent'
          : (url.pathname === '/api/store/7d' ? '7d' : 'default'),
      };

      if (profileName || subscriptionUserinfo) {
        const safe = sanitizeCustomInput(profileName, subscriptionUserinfo);
        meta.custom = {
          profileName: safe.profileName,
          subscriptionUserinfo: safe.subscriptionUserinfo,
        };
      }

      await saveMeta(env, shortId, meta);
      return jsonResponse({ shortLink: `${url.origin}/${shortId}` }, 200, corsHeaders);
    }

    if (url.pathname === '/api/proxy/create' && request.method === 'POST') {
      const body = await request.json().catch(() => null);
      const targetUrl = String(body?.targetUrl || '').trim();
      const mode = String(body?.mode || 'raw').trim().toLowerCase() === 'yaml' ? 'yaml' : 'raw';

      if (!targetUrl) return jsonResponse({ error: 'targetUrl is required' }, 400, corsHeaders);

      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch {
        return jsonResponse({ error: 'targetUrl is invalid' }, 400, corsHeaders);
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return jsonResponse({ error: 'targetUrl protocol must be http/https' }, 400, corsHeaders);
      }

      const safe = sanitizeCustomInput(body?.profileName, body?.subscriptionUserinfo);

      try {
        const shortId = await generateUniqueShortId(env.TEXT_STORAGE, env.LINK_META);
        const now = nowIso();

        const { response } = await fetchOriginWithRotation(targetUrl, getClientIp(request), 'GET', PROXY_SERVER_URL);

        const originSubInfo = headerAny(response.headers, [
          'subscription-userinfo',
          'Subscription-Userinfo',
          'x-subscription-userinfo',
          'X-Subscription-Userinfo'
        ]);

        const originPui = headerAny(response.headers, [
          'profile-update-interval',
          'Profile-Update-Interval',
          'x-profile-update-interval',
          'X-Profile-Update-Interval'
        ]);

        let finalBody;
        if (mode === 'yaml') {
          const yamlResult = await fetchYamlFromSubscription(targetUrl);
          finalBody = yamlResult.body;
        } else {
          finalBody = await response.arrayBuffer();
        }

        const finalSubInfo = safe.subscriptionUserinfo || originSubInfo || '';

        const meta = {
          type: 'proxy',
          mode,
          shortId,
          targetUrl,
          createdAt: now,
          updatedAt: now,
          cacheUpdatedAt: now,
          lastStatus: response.status,
          custom: (safe.profileName || safe.subscriptionUserinfo)
            ? { profileName: safe.profileName, subscriptionUserinfo: safe.subscriptionUserinfo }
            : undefined,
          snapshot: {
            subscriptionUserinfo: finalSubInfo,
            profileUpdateInterval: originPui
          }
        };

        await saveMeta(env, shortId, meta);
        await env.TEXT_STORAGE.put(shortId, PROXY_PLACEHOLDER);

        await env.LINK_META.put(`cache_${shortId}`, JSON.stringify({
          bodyBase64: encodeBase64FromArrayBuffer(finalBody),
          contentType: normalizeTextContentType(),
          contentDisposition: '',
          subscriptionUserinfo: finalSubInfo,
          profileUpdateInterval: originPui,
          fetchedAt: now,
        }));

        return jsonResponse({
          shortLink: `${url.origin}/${shortId}`,
          type: 'proxy',
          mode,
          profileName: safe.profileName || ''
        }, 200, corsHeaders);
      } catch (e) {
        return jsonResponse({ error: `create proxy failed: ${e.message}` }, 502, corsHeaders);
      }
    }

    if (request.method === 'GET') {
      const shortId = url.pathname.substring(1);
      if (shortId && !shortId.includes('/')) {
        const meta = await getMeta(env, shortId);

        if (meta && meta.type === 'proxy') {
          const cached = await env.LINK_META.get(`cache_${shortId}`, { type: 'json' });
          if (!cached?.bodyBase64) return textResponse('Proxy cache missing. Refresh it.', 502, corsHeaders);

          const body = decodeBase64ToUint8Array(cached.bodyBase64);

          const fakeUpstream = new Headers();
          fakeUpstream.set('Content-Type', normalizeTextContentType());
          if (cached.subscriptionUserinfo) fakeUpstream.set('subscription-userinfo', cached.subscriptionUserinfo);
          if (cached.profileUpdateInterval) fakeUpstream.set('profile-update-interval', cached.profileUpdateInterval);

          const proxyCustom = buildProxyCustomHeaders(meta);
          const extra = { 'X-Shortlink-Type': 'proxy', ...corsHeaders };
          for (const [k, v] of proxyCustom.entries()) extra[k] = v;

          const headers = copyHeadersRaw(fakeUpstream, extra);
          headers.set('Content-Type', normalizeTextContentType());

          return new Response(body, { status: 200, headers });
        }

        const text = await env.TEXT_STORAGE.get(shortId);
        if (text && text !== PROXY_PLACEHOLDER) {
          const headers = new Headers({ 'Content-Type': normalizeTextContentType(), ...corsHeaders });
          const customHeaders = buildTextCustomHeaders(meta);
          for (const [k, v] of customHeaders.entries()) headers.set(k, v);
          return new Response(text, { status: 200, headers });
        }

        return textResponse('Not found.', 404, corsHeaders);
      }
    }

    return textResponse('Welcome.', 200, corsHeaders);
  },
};
