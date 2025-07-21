// 文件名：api/proxy.js (依然放在 api 目录下)

// 不再需要 require('express')
// 不再需要 require('node-fetch')，因为Vercel环境支持全局的fetch

// Vercel Serverless Function 的标准入口是导出一个异步函数，接收 request 和 response 对象
module.exports = async (req, res) => {
    // 解析请求方法和URL参数
    const method = req.method;
    const url = new URL(req.url);
    const targetUrl = url.searchParams.get('url'); // 从查询参数 'url' 获取目标 URL

    if (!targetUrl) {
        // 使用原生的 res.status 和 res.send
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Error: Missing "url" query parameter.');
        return;
    }

    try {
        const proxyOptions = {
            method: method,
            headers: {}
        };

        // 复制原始请求的Header
        // 注意：req.headers 是一个 Headers 对象，可以直接迭代
        for (const [key, value] of Object.entries(req.headers)) {
            // 避免转发可能导致问题的Header
            if (!['host', 'connection', 'x-forwarded-for', 'x-real-ip', 'x-vercel-forwarded-for', 'user-agent'].includes(key.toLowerCase())) {
                proxyOptions.headers[key] = value;
            }
        }
        // 添加自定义User-Agent
        proxyOptions.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.75 Safari/537.36 Proxy/Vercel-Native';

        // 处理请求体 (POST/PUT/PATCH)
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            // Vercel的req对象通常会自动解析JSON或文本体
            // 这里我们假设如果内容类型是JSON，则尝试解析
            if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
                // req.body 在Vercel原生函数中可能需要通过流读取
                // 最简单的方法是等待Vercel自动处理，或者手动读取流
                // 对于简单的POST，req.body可能已解析，但更稳健是读流
                // 注意：在Vercel的Node.js运行时中，req对象可以直接读取body流
                let body = '';
                await new Promise((resolve, reject) => {
                    req.on('data', chunk => {
                        body += chunk.toString();
                    });
                    req.on('end', () => {
                        proxyOptions.body = body;
                        resolve();
                    });
                    req.on('error', reject);
                });
            } else {
                 // 对于非JSON的POST请求，如果需要转发原始体，逻辑会更复杂
                 // 这里简化处理，只转发JSON
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
            proxyResponse.body.pipe(res); // 将响应流直接导向 Vercel 的响应流
        } else {
            res.end(); // 没有响应体则直接结束
        }

    } catch (error) {
        console.error('Proxy Error:', error);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain');
        res.end(`Proxy Error: ${error.message}`);
    }
};

