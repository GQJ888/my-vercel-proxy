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

        console.log(`[Vercel Proxy] 尝试 UA(${uaIndex + 1}/${USER_AGENTS.length}) 第 ${attempt} 次: ${ua}`);
        console.log(`[Vercel Proxy] 转发请求头: ${JSON.stringify(proxyHeaders, null, 2)}`);

        const response = await fetch(targetUrl, {
          method: req.method,
          headers: proxyHeaders,
          body: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined,
          redirect: 'follow',
          signal: AbortSignal.timeout(12000)
        });

        if ([403, 429, 503].includes(response.status)) {
          lastError = new Error(`HTTP ${response.status} (UA blocked: ${ua})`);
          console.warn(`[Vercel Proxy] 状态码 ${response.status}，切换下一个 UA`);
          break;
        }

        if (!response.ok) {
          if (attempt < maxRetriesPerUA) {
            const waitMs = 700 * attempt;
            console.warn(`[Vercel Proxy] HTTP ${response.status}，${waitMs}ms 后重试同UA`);
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          lastError = new Error(`HTTP ${response.status}`);
          break;
        }

        return { response, usedUA: ua, uaIndex };
      } catch (error) {
        lastError = error;
        console.warn(`[Vercel Proxy] UA请求异常: ${error.message}`);

        if (attempt < maxRetriesPerUA) {
          const waitMs = 1000 * attempt;
          await new Promise(r => setTimeout(r, waitMs));
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
      console.error('[Vercel Proxy] Bad Request: "url" parameter is missing.');
      return;
    }

    console.log(`[Vercel Proxy] 收到请求，目标URL: ${targetUrl}`);

    const { response, usedUA } = await fetchWithUARotation(targetUrl, req, 2);
    console.log(`[Vercel Proxy] 请求成功，使用UA: ${usedUA}`);
    console.log(`[Vercel Proxy] 状态码: ${response.status}`);

    for (const [key, value] of response.headers.entries()) {
      console.log(`  ${key}: ${value}`);
    }

    const contentType = response.headers.get('content-type') || 'text/plain';
    const buffer = await response.arrayBuffer();

    // 不依赖 content-encoding 头，直接尝试 ungzip，失败则按文本解码
    let contentString = '';
    const decoder = new TextDecoder('utf-8', { fatal: false });
    try {
      contentString = ungzip(new Uint8Array(buffer), { to: 'string' });
      console.log('[Vercel Proxy] ungzip 成功');
    } catch {
      contentString = decoder.decode(buffer);
    }

    let nodeProtocols = { total: 0, protocols: {} };
    try {
      let textToParse = contentString;
      let isClashYaml = false;

      try {
        const decoded = Buffer.from(textToParse, 'base64').toString('utf8');
        if (decoded.includes('://') || decoded.includes('proxies:')) {
          textToParse = decoded;
          console.log('[Vercel Proxy] Base64 解码成功');
        }
      } catch (e) {
        console.log('[Vercel Proxy] Base64 解码失败，忽略:', e.message);
      }

      try {
        if (textToParse.includes('proxies:') && textToParse.includes('proxy-groups:')) {
          const config = load(textToParse);
          if (config && Array.isArray(config.proxies)) {
            isClashYaml = true;
          }
        }
      } catch (error) {
        console.warn('[Vercel Proxy] YAML 解析失败，按普通节点列表处理:', error.message);
      }

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

      console.log(`[Vercel Proxy] 节点协议解析结果: ${JSON.stringify(nodeProtocols)}`);
    } catch (error) {
      console.error(`[Vercel Proxy] 节点协议解析失败: ${error.message}`);
      nodeProtocols = { total: 0, protocols: {} };
    }

    res.statusCode = response.status;

    // 转发上游响应头
    for (const [key, value] of response.headers.entries()) {
      const lower = key.toLowerCase();
      if (!['transfer-encoding', 'connection', 'keep-alive'].includes(lower)) {
        try {
          res.setHeader(key, value);
        } catch (e) {
          console.warn(`[Vercel Proxy] 无法设置响应头 '${key}': ${e.message}`);
        }
      }
    }

    // 强制透传 subscription-userinfo（多大小写兼容）
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
        console.log('[Vercel Proxy] 强制透传 subscription-userinfo');
      } catch (e) {
        console.warn('[Vercel Proxy] 设置 subscription-userinfo 失败:', e.message);
      }
    }

    try {
      res.setHeader('X-Node-Protocols', JSON.stringify(nodeProtocols));
      res.setHeader('X-Used-User-Agent', usedUA);
      res.setHeader('X-Proxy-Has-Subinfo', subInfo ? '1' : '0');
      res.setHeader('X-Proxy-Content-Type', contentType);
    } catch (e) {
      console.warn(`[Vercel Proxy] 无法设置自定义响应头: ${e.message}`);
    }

    if (buffer.byteLength > 0) {
      const nodeReadable = Readable.from(Buffer.from(buffer));
      nodeReadable.pipe(res);
      console.log('[Vercel Proxy] 响应体已转发');
    } else {
      res.end();
      console.log('[Vercel Proxy] 目标响应体为空');
    }
  } catch (error) {
    console.error(`[Vercel Proxy] 代理错误: ${error.message}`, {
      stack: error.stack,
      cause: error.cause ? {
        message: error.cause.message,
        code: error.cause.code,
        errno: error.cause.errno,
        syscall: error.cause.syscall
      } : null
    });

    let statusCode = 500;
    let errorMessage = `Vercel Proxy Error: ${error.message}`;
    let errorBody = null;

    if (error.cause && error.cause.response) {
      statusCode = error.cause.response.status;
      try {
        errorBody = await error.cause.response.text();
      } catch {}
    } else if (String(error.message).includes('ECONNRESET')) {
      statusCode = 403;
      errorMessage = '访问被拒绝，可能IP被限制或订阅已失效';
    }

    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(errorBody || errorMessage);
  }
};
