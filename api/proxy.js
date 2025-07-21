// 文件名：api/proxy.js

module.exports = async (req, res) => {
    // 确保req.url是一个完整的URL，以便URL对象能正确解析
    // Vercel的req.url通常是路径和查询字符串，例如 '/api/proxy?url=...'
    // 为了正确解析查询参数，我们提供一个虚拟的baseURL
    const fullUrl = new URL(req.url, `http://${req.headers.host}`);
    const targetUrl = fullUrl.searchParams.get('url');

    if (!targetUrl) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Error: Missing "url" query parameter.');
        return;
    }

    try {
        const proxyOptions = {
            method: req.method,
            headers: {}
        };

        // 复制原始请求的Header
        // req.headers 是一个普通的JavaScript对象
        for (const key in req.headers) {
            // 避免转发可能导致问题的Header
            if (!['host', 'connection', 'x-forwarded-for', 'x-real-ip', 'x-vercel-forwarded-for', 'user-agent'].includes(key.toLowerCase())) {
                proxyOptions.headers[key] = req.headers[key];
            }
        }
        // 添加自定义User-Agent
        proxyOptions.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.75 Safari/537.36 Proxy/Vercel-Native';

        // 处理请求体 (POST/PUT/PATCH)
        // 对于fetch API，可以直接将原始请求流作为body传递
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            // 检查是否有Content-Length或Transfer-Encoding头，表明有请求体
            if (req.headers['content-length'] || req.headers['transfer-encoding']) {
                proxyOptions.body = req; // 直接将原始请求流作为body传递给fetch
            }
        }

        // 发起请求到目标URL，使用Vercel环境自带的全局fetch
        const proxyResponse = await fetch(targetUrl, proxyOptions);

        // 复制目标响应的Header
        for (const [key, value] of proxyResponse.headers.entries()) {
            if (!['transfer-encoding', 'content-encoding', 'connection'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        }

        // 设置响应状态码
        res.statusCode = proxyResponse.status;

        // 发送响应体
        // proxyResponse.body 是一个 ReadableStream，直接 pipe 到 res
        if (proxyResponse.body) {
            proxyResponse.body.pipe(res);
            // 确保流结束时响应也结束
            proxyResponse.body.on('end', () => res.end());
            proxyResponse.body.on('error', (err) => {
                console.error('Proxy response body pipe error:', err);
                if (!res.headersSent) { // 确保头未发送时才设置
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end('Proxy response body stream error.');
                }
            });
        } else {
            res.end();
        }

    } catch (error) {
        console.error('Proxy Error:', error);
        // 确保在错误发生时，如果响应头还没发送，可以设置错误状态码
        if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain');
            res.end(`Proxy Error: ${error.message}`);
        } else {
            // 如果头已发送，尝试结束响应以避免挂起
            res.end();
        }
    }
};
