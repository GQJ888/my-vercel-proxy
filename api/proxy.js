// api/proxy.js
const { URL } = require('url'); // Node.js 内置的 URL 模块

module.exports = async (req, res) => {
    try {
        // 1. 解析传入请求的 URL，获取 'url' 查询参数
        // req.url 在 Vercel Serverless Function 中通常是 '/api/proxy?url=...'
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const targetUrl = requestUrl.searchParams.get('url');

        if (!targetUrl) {
            res.statusCode = 400;
            res.end('Bad Request: "url" parameter is missing.');
            return;
        }

        // 2. 准备转发给目标订阅服务器的请求头部
        // 确保转发 Cloudflare Workers 发送的 User-Agent 和 Accept-Encoding
        const proxyHeaders = {};
        if (req.headers['user-agent']) {
            proxyHeaders['User-Agent'] = req.headers['user-agent'];
        } else {
            // 提供一个默认的 User-Agent，以防 Cloudflare Worker 没有发送
            proxyHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.75 Safari/537.36';
        }

        if (req.headers['accept-encoding']) {
            proxyHeaders['Accept-Encoding'] = req.headers['accept-encoding'];
        } else {
            // 提供一个默认的 Accept-Encoding
            proxyHeaders['Accept-Encoding'] = 'gzip, deflate, br';
        }

        // 转发其他可能的有用头部，但要小心可能导致问题的头部
        // 例如，不要转发 'host', 'connection' 等
        for (const headerName in req.headers) {
            if (!['host', 'connection', 'content-length'].includes(headerName.toLowerCase())) {
                proxyHeaders[headerName] = req.headers[headerName];
            }
        }
        
        // Vercel 内部可能已经处理了 X-Forwarded-For，但为了确保，可以手动添加
        if (req.headers['x-forwarded-for']) {
            proxyHeaders['X-Forwarded-For'] = req.headers['x-forwarded-for'];
        } else if (req.socket && req.socket.remoteAddress) {
            proxyHeaders['X-Forwarded-For'] = req.socket.remoteAddress;
        }


        // 3. 向目标订阅服务器发起请求
        const response = await fetch(targetUrl, {
            method: req.method, // 保留原始请求方法
            headers: proxyHeaders, // 使用准备好的头部
            // 对于非 GET/HEAD 请求，转发请求体
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined,
            redirect: 'follow', // 遵循重定向
        });

        // 4. 将目标订阅服务器的响应头部完整地转发回 Cloudflare Workers
        for (const [key, value] of response.headers.entries()) {
            // 避免转发一些可能由 Vercel 或 Cloudflare Workers 自动处理的头部，
            // 或者可能导致问题的头部（如 'transfer-encoding'）。
            // 常见的需要转发的订阅信息头部：
            // 'subscription-userinfo', 'content-disposition', 'expires', 'cache-control'
            // 默认情况下，转发所有非受限制的头部是安全的。
            try {
                res.setHeader(key, value);
            } catch (e) {
                // 有些头部可能无法通过 setHeader 设置，例如 'content-encoding' 如果响应已经被解压缩
                console.warn(`无法设置响应头部 '${key}': ${e.message}`);
            }
        }

        // 5. 设置响应状态码
        res.statusCode = response.status;

        // 6. 将目标订阅服务器的响应体完整地转发回 Cloudflare Workers
        // 使用 Node.js 的管道流进行高效转发
        if (response.body) {
            // Convert web stream to Node.js stream for piping
            const { Readable } = require('stream');
            const nodeReadable = Readable.fromWeb(response.body);
            nodeReadable.pipe(res);
        } else {
            res.end(); // 没有响应体
        }

    } catch (error) {
        console.error('Vercel 代理错误:', error);
        res.statusCode = 500;
        res.end(`Vercel Proxy Error: ${error.message}`);
    }
};
