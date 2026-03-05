const { URL } = require('url');
const { Readable } = require('stream');
const { ungzip } = require('pako');
const { load } = require('js-yaml');

const SUPPORTED_PROTOCOLS = [
  'ss', 'ssr', 'trojan', 'vmess', 'vless', 'http', 'socks5',
  'hysteria', 'hysteria2', 'tuic', 'wireguard', 'brook', 'snell',
  'reality', 'juicity', 'xray', 'shadowtls', 'v2ray', 'outline',
  'warp', 'naive', 'httpobfs', 'websocket', 'quic', 'grpc', 'http2', 'http3'
];

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Mihomo/1.18.0',
  'Clash Verge/v1.7.8',
  'FlClash/v0.8.76 clash-verge Platform/android',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 Clash-Meta/1.18.0',
];

function pickClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') return xff.split(',')[0].trim();
  const xr = req.headers['x-real-ip'];
  if (xr && typeof xr === 'string') return xr.trim();
  return req.socket?.remoteAddress || '';
}

function getHeaderAny(headers, keys) {
  for (const k of keys) {
    const v = headers.get(k);
    if (v) return v;
  }
  return '';
}

async function fetchWithUARotation(targetUrl, req, maxRetriesPerUA = 2) {
  let lastError = null;
  const clientIp = pickClientIp(req);

  for (let uaIndex = 0; uaIndex < USER_AGENTS.length; uaIndex++) {
    const ua = USER_AGENTS[uaIndex];

    for (let attempt = 1; attempt <= maxRetriesPerUA; attempt++) {
      try {
        const proxyHeaders = {
          'User-Agent': ua,
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'X-Forwarded-For': clientIp
        };

        const response = await fetch(targetUrl, {
          method: req.method,
          headers: proxyHeaders,
          body: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined,
          redirect: 'follow',
          signal: AbortSignal.timeout(12000)
        });

        if ([403, 429, 503].includes(response.status)) {
          lastError = new Error(`HTTP ${response.status} (UA blocked: ${ua})`);
          break;
        }

        if (!response.ok) {
          if (attempt < maxRetriesPerUA) {
            await new Promise(r => setTimeout(r, 700 * attempt));
            continue;
          }
          lastError = new Error(`HTTP ${response.status}`);
          break;
        }

        return { response, usedUA: ua, uaIndex };
      } catch (error) {
        lastError = error;
        if (attempt < maxRetriesPerUA) {
          await new Promise(r => setTimeout(r, 1000 * attempt));
          continue;
        }
        if (uaIndex < USER_AGENTS.length - 1) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
  }

  throw lastError || new Error('All User-Agents failed');
}

module.exports = async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const targetUrl = requestUrl.searchParams.get('url');

    if (!targetUrl) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Bad Request: "url" parameter is missing.');
      return;
    }

    const { response, usedUA } = await fetchWithUARotation(targetUrl, req, 2);
    const buffer = await response.arrayBuffer();

    let contentString = '';
    const decoder = new TextDecoder('utf-8', { fatal: false });
    try {
      contentString = ungzip(new Uint8Array(buffer), { to: 'string' });
    } catch {
      contentString = decoder.decode(buffer);
    }

    let nodeProtocols = { total: 0, protocols: {} };
    try {
      let textToParse = contentString;
      let isClashYaml = false;

      try {
        const decoded = Buffer.from(textToParse, 'base64').toString('utf8');
        if (decoded.includes('://') || decoded.includes('proxies:')) textToParse = decoded;
      } catch {}

      try {
        if (textToParse.includes('proxies:') && textToParse.includes('proxy-groups:')) {
          const config = load(textToParse);
          if (config && Array.isArray(config.proxies)) isClashYaml = true;
        }
      } catch {}

      if (isClashYaml) {
        const config = load(textToParse);
        config.proxies.forEach(proxy => {
          const protocol = proxy.type ? String(proxy.type).toLowerCase() : 'unknown';
          nodeProtocols.protocols[protocol] = (nodeProtocols.protocols[protocol] || 0) + 1;
          nodeProtocols.total++;
        });
      } else {
        const lines = textToParse.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          for (const proto of SUPPORTED_PROTOCOLS) {
            if (trimmed.toLowerCase().startsWith(`${proto}://`)) {
              nodeProtocols.protocols[proto] = (nodeProtocols.protocols[proto] || 0) + 1;
              nodeProtocols.total++;
              break;
            }
          }
        }
      }
    } catch {
      nodeProtocols = { total: 0, protocols: {} };
    }

    res.statusCode = response.status;

    for (const [key, value] of response.headers.entries()) {
      const lower = key.toLowerCase();
      if (!['transfer-encoding', 'connection', 'keep-alive'].includes(lower)) {
        try { res.setHeader(key, value); } catch {}
      }
    }

    const subInfo = getHeaderAny(response.headers, [
      'subscription-userinfo',
      'Subscription-Userinfo',
      'x-subscription-userinfo',
      'X-Subscription-Userinfo'
    ]);

    if (subInfo) {
      try {
        res.setHeader('subscription-userinfo', subInfo);
        res.setHeader('Subscription-Userinfo', subInfo);
        res.setHeader('x-subscription-userinfo', subInfo);
      } catch {}
    }

    try {
      res.setHeader('X-Node-Protocols', JSON.stringify(nodeProtocols));
      res.setHeader('X-Used-User-Agent', usedUA);
      res.setHeader('X-Proxy-Has-Subinfo', subInfo ? '1' : '0');
    } catch {}

    if (buffer.byteLength > 0) {
      Readable.from(Buffer.from(buffer)).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    let statusCode = 500;
    let errorMessage = `Vercel Proxy Error: ${error.message}`;

    if (String(error.message).includes('ECONNRESET')) {
      statusCode = 403;
      errorMessage = '访问被拒绝，可能IP被限制或订阅已失效';
    }

    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(errorMessage);
  }
};
