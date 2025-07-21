// api/proxy.js
const { URL } = require('url'); // Node.js 内置的 URL 模块
const { Readable } = require('stream'); // Node.js 内置的 stream 模块，用于处理响应体

module.exports = async (req, res) => {
    try {
        // 1. 解析传入请求的 URL，获取 'url' 查询参数
        // req.url 在 Vercel Serverless Function 中通常是 '/api/proxy?url=...'
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const targetUrl = requestUrl.searchParams.get('url');

        if (!targetUrl) {
            res.statusCode = 400;
            res.end('Bad Request: "url" parameter is missing.');
            console.error('[Vercel Proxy] Bad Request: "url" parameter is missing.');
            return;
        }
        
        console.log(`[Vercel Proxy] 收到请求，目标URL: ${targetUrl}`);

        // 2. 准备转发给目标订阅服务器的请求头部
        // 确保转发 Cloudflare Workers 发送的 User-Agent 和 Accept-Encoding
        const proxyHeaders = {};

        // 从 Cloudflare Worker 接收到的头部，并将其转发给目标服务器
        // Cloudflare Worker 的 User-Agent 和 Accept-Encoding 会在 req.headers 中
        if (req.headers['user-agent']) {
            proxyHeaders['User-Agent'] = req.headers['user-agent'];
            console.log(`[Vercel Proxy] 转发 User-Agent: ${proxyHeaders['User-Agent']}`);
        } else {
            // 提供一个默认的 User-Agent，以防 Cloudflare Worker 没有发送
            proxyHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.75 Safari/537.36';
            console.log(`[Vercel Proxy] 使用默认 User-Agent: ${proxyHeaders['User-Agent']}`);
        }

        if (req.headers['accept-encoding']) {
            proxyHeaders['Accept-Encoding'] = req.headers['accept-encoding'];
            console.log(`[Vercel Proxy] 转发 Accept-Encoding: ${proxyHeaders['Accept-Encoding']}`);
        } else {
            // 提供一个默认的 Accept-Encoding
            proxyHeaders['Accept-Encoding'] = 'gzip, deflate, br';
            console.log(`[Vercel Proxy] 使用默认 Accept-Encoding: ${proxyHeaders['Accept-Encoding']}`);
        }

        // 转发其他所有非跳逐头部，除了 Content-Length（由fetch自动处理）和Host（由Vercel自动处理）
        for (const headerName in req.headers) {
            const lowerCaseHeaderName = headerName.toLowerCase();
            // 避免转发 hop-by-hop headers 和 Content-Length, Host
            if (!['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'expect', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade'].includes(lowerCaseHeaderName)) {
                proxyHeaders[headerName] = req.headers[headerName];
                // console.log(`[Vercel Proxy] 转发请求头: ${headerName}: ${req.headers[headerName]}`); // 太多日志，按需开启
            }
        }
        
        // Vercel 内部可能已经处理了 X-Forwarded-For，但为了确保，可以手动添加
        if (req.headers['x-forwarded-for']) {
            proxyHeaders['X-Forwarded-For'] = req.headers['x-forwarded-for'];
        } else if (req.socket && req.socket.remoteAddress) {
            proxyHeaders['X-Forwarded-For'] = req.socket.remoteAddress;
        }

        console.log(`[Vercel Proxy] 最终转发请求头到目标URL: ${JSON.stringify(proxyHeaders, null, 2)}`);

        // 3. 向目标订阅服务器发起请求
        const response = await fetch(targetUrl, {
            method: req.method, // 保留原始请求方法
            headers: proxyHeaders, // 使用准备好的头部
            // 对于非 GET/HEAD 请求，转发请求体
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined,
            redirect: 'follow', // 遵循重定向
        });

        // --- 核心调试点：打印 Vercel 代理从目标服务器收到的所有响应头 ---
        console.log(`--- [Vercel Proxy] Received Response from ${targetUrl} (Status: ${response.status}) ---`);
        console.log('Headers received from target:');
        for (const [key, value] of response.headers.entries()) {
            console.log(`  ${key}: ${value}`);
        }
        console.log('--- End [Vercel Proxy] Received Response Headers ---');
        // --- 核心调试点结束 ---

        // 4. 将目标订阅服务器的响应头部完整地转发回 Cloudflare Workers
        for (const [key, value] of response.headers.entries()) {
            // 避免转发一些可能由 Vercel 或 Cloudflare Workers 自动处理的头部，
            // 或者可能导致问题的头部（如 'transfer-encoding'）。
            // 默认情况下，转发所有非受限制的头部是安全的。
            const lowerCaseKey = key.toLowerCase();
            if (!['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length'].includes(lowerCaseKey)) {
                try {
                    res.setHeader(key, value);
                    // console.log(`[Vercel Proxy] 转发响应头给 CF Worker: ${key}: ${value}`); // 太多日志，按需开启
                } catch (e) {
                    console.warn(`[Vercel Proxy] WARN: 无法设置响应头部 '${key}': ${e.message}`);
                }
            } else {
                console.log(`[Vercel Proxy] Skipping response header for CF Worker: ${key}`);
            }
        }

        // 5. 设置响应状态码
        res.statusCode = response.status;
        console.log(`[Vercel Proxy] 设置响应状态码: ${response.status}`);

        // 6. 将目标订阅服务器的响应体完整地转发回 Cloudflare Workers
        // 使用 Node.js 的管道流进行高效转发
        if (response.body) {
            // Convert web stream to Node.js stream for piping
            const nodeReadable = Readable.fromWeb(response.body);
            nodeReadable.pipe(res);
            console.log('[Vercel Proxy] 响应体通过管道流转发。');
        } else {
            res.end(); // 没有响应体
            console.log('[Vercel Proxy] 目标响应体为空。');
        }

    } catch (error) {
        console.error('[Vercel Proxy] 代理错误:', error);
        res.statusCode = 500;
        res.end(`Vercel Proxy Error: ${error.message}`);
    }
};
