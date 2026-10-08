/**
 * 诊断：Node 侧对本地桩的 HTTP 调用到底卡在哪。
 * 用法：node scripts/diag-http.cjs [url]
 */
const url = process.argv[2] || 'http://127.0.0.1:8081/internal/products';

(async () => {
  console.log(`目标: ${url}\n`);

  // 1) 原始 http 模块
  await new Promise((resolve) => {
    const http = require('node:http');
    const started = Date.now();
    const req = http.get(url, { headers: { 'x-internal-key': 'stub-storage-key' }, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        console.log(`[http.get ] 成功 ${res.statusCode} ${Date.now() - started}ms  ${body.slice(0, 80)}`);
        resolve();
      });
    });
    req.on('timeout', () => {
      console.log(`[http.get ] 超时 ${Date.now() - started}ms`);
      req.destroy();
      resolve();
    });
    req.on('error', (error) => {
      console.log(`[http.get ] 失败 ${Date.now() - started}ms ${error.code ?? ''} ${error.message}`);
      resolve();
    });
  });

  // 2) 全局 fetch（undici）
  {
    const started = Date.now();
    try {
      const response = await fetch(url, { headers: { 'x-internal-key': 'stub-storage-key' } });
      const text = await response.text();
      console.log(`[fetch    ] 成功 ${response.status} ${Date.now() - started}ms  ${text.slice(0, 80)}`);
    } catch (error) {
      console.log(`[fetch    ] 失败 ${Date.now() - started}ms ${error.cause?.code ?? ''} ${error.message}`);
    }
  }

  // 3) axios（与门户内部用法一致）
  {
    const axios = require('axios');
    const started = Date.now();
    try {
      const response = await axios.get(url, {
        timeout: 5000,
        headers: { 'x-internal-key': 'stub-storage-key' },
      });
      console.log(`[axios    ] 成功 ${response.status} ${Date.now() - started}ms  ${JSON.stringify(response.data).slice(0, 80)}`);
    } catch (error) {
      console.log(
        `[axios    ] 失败 ${Date.now() - started}ms code=${error.code ?? ''} ${error.message}`,
      );
      if (error.cause) console.log(`             cause: ${error.cause.code ?? ''} ${error.cause.message}`);
    }
  }
})();
