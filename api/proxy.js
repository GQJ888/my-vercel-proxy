const { URL } = require('url');
const { Readable } = require('stream');

module.exports = async (req, res) => {
    try {
        // 1. 解析传入请求的 URL
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        const targetUrl = requestUrl.searchParams.get('url');

        if (!targetUrl) {
            res.statusCode = 400;
            res.end('Bad Request: "url" parameter is missing.');
            console.error('[Vercel Proxy] Bad Request: "url" parameter is missing.');
            return;
        }

        console.log(`[Vercel Proxy] 收到请求，目标URL: ${targetUrl}`);

        // 2. 精简请求头部
        const proxyHeaders = {
            'User-Agent': req.headers['user-agent'] || 'clash-verge/v1.5.1, NekoBox/Android/1.3.0(Prefer ClashMeta Format)',
            'Accept-Encoding': req.headers['accept-encoding'] || 'gzip',
            'X-Forwarded-For': req.headers['x-forwarded-for'] || req.socket?.remoteAddress
        };

        console.log(`[Vercel Proxy] 最终转发请求头到目标URL: ${JSON.stringify(proxyHeaders, null, 2)}`);

        // 3. 向目标服务器发起请求
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: proxyHeaders,
            body: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined,
            redirect: 'follow',
            signal: AbortSignal.timeout(10000)
        });

        // 4. 记录目标服务器响应
        console.log(`[Vercel Proxy] 收到响应，状态码: ${response.status}`);
        console.log('响应头:');
        for (const [key, value] of response.headers.entries()) {
            console.log(`  ${key}: ${value}`);
        }

        // 5. 设置响应状态码（直接使用目标服务器的状态码）
        res.statusCode = response.status;

        // 6. 转发响应头部
        for (const [key, value] of response.headers.entries()) {
            const lowerCaseKey = key.toLowerCase();
            if (!['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length'].includes(lowerCaseKey)) {
                try {
                    res.setHeader(key, value);
                    console.log(`[Vercel Proxy] 转发响应头: ${key}: ${value}`);
                } catch (e) {
                    console.warn(`[Vercel Proxy] 无法设置响应头 '${key}': ${e.message}`);
                }
            }
        }

        // 7. 转发响应体
        if (response.body) {
            const nodeReadable = Readable.fromWeb(response.body);
            nodeReadable.pipe(res);
            console.log('[Vercel Proxy] 响应体通过管道流转发。');
        } else {
            res.end();
            console.log('[Vercel Proxy] 目标响应体为空。');
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

        // 尝试从错误中获取目标服务器的状态码和响应体
        let statusCode = 500;
        let errorMessage = `Vercel Proxy Error: ${error.message}`;
        let errorBody = null;

        if (error.cause && error.cause.response) {
            statusCode = error.cause.response.status;
            console.log(`[Vercel Proxy] 目标服务器错误详情: 状态码 ${statusCode}`);
            for (const [key, value] of error.cause.response.headers.entries()) {
                console.log(`  ${key}: ${value}`);
            }
            try {
                errorBody = await error.cause.response.text();
                console.log(`[Vercel Proxy] 错误响应体: ${errorBody.substring(0, 200)}...`);
            } catch (bodyError) {
                console.error('[Vercel Proxy] 无法读取错误响应体:', bodyError);
            }
        } else if (error.message.includes('ECONNRESET')) {
            // 推测为目标服务器限制（如 403）
            statusCode = 403;
            errorMessage = '访问被拒绝，可能IP被限制或订阅已失效';
            console.log('[Vercel Proxy] 推测目标服务器返回 403 (ECONNRESET)');
        }

        res.statusCode = statusCode;
        res.end(errorBody || errorMessage);
    }
};