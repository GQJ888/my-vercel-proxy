// 例如，命名为 proxy.js
const express = require('express');
const app = express();
// const fetch = require('node-fetch'); // Vercel环境通常自带fetch，可能不需要显式引入

app。use(express.json());
app。use(express.urlencoded({ extended: true }));

app。all('/proxy', async (req, res) => {
    const targetUrl = req.query.url; // 从查询参数 'url' 获取目标 URL

    if (!targetUrl) {
        return res.status(400).send('Error: Missing "url" query parameter.');
    }

    try {
        const proxyOptions = {
            method: req.method,
            headers: {}
        };

        for (const key in req.headers) {
            if (!['host', 'connection', 'x-forwarded-for', 'x-real-ip', 'x-vercel-forwarded-for', 'user-agent'].includes(key.toLowerCase())) {
                proxyOptions.headers[key] = req.headers[key];
            }
        }
        proxyOptions.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.75 Safari/537.36 Proxy/Vercel';

        if (req.body && Object.keys(req.body).length > 0) {
            proxyOptions.body = JSON.stringify(req.body);
            proxyOptions.headers['Content-Type'] = req.headers['content-type'] || 'application/json';
        } else if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            // 这里可以处理原始流，但对于大多数订阅请求，req.body为空或JSON足够
        }

        const proxyResponse = await fetch(targetUrl, proxyOptions);

        proxyResponse.headers.forEach((value, name) => {
            if (!['transfer-encoding', 'content-encoding', 'connection'].includes(name.toLowerCase())) {
                res.setHeader(name, value);
            }
        });

        res.status(proxyResponse.status);
        const responseBuffer = await proxyResponse.buffer();
        res.send(responseBuffer);

    } catch (error) {
        console.error('Proxy Error:', error);
        res.status(500).send(`Proxy Error: ${error.message}`);
    }
});

// 这是 Vercel Serverless Function 关键的导出方式
module。exports = app;
