// 真实浏览器功能测试（Playwright + headless Chromium）
// 用法: E2E_URL=https://xxx node scripts/e2e.mjs
//
// 与 curl 静态校验的区别：这里会真的把应用跑起来 —— 执行 JS、实例化 wasm、
// 检查有没有未捕获异常、UI 是否挂载（canvas）、并截图留证。
//
// 退出码: 0 = 无硬性错误; 1 = 有硬性错误（导航失败 / wasm 非 200 / JS 未捕获异常）

import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = (process.env.E2E_URL || '').trim();
if (!URL) {
  console.error('缺少 E2E_URL 环境变量');
  process.exit(1);
}

const TIMEOUT = Number(process.env.E2E_TIMEOUT_MS || 180000);
const report = {
  url: URL,
  startedAt: new Date().toISOString(),
  navigation: null,
  wasmResponses: [],
  consoleErrors: [],
  consoleWarnings: [],
  pageErrors: [],
  requestFailures: [],
  page: null,
  hardFailures: [],
  warnings: [],
};

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

const page = await context.newPage();

page.on('console', (msg) => {
  const t = msg.type();
  const text = msg.text();
  if (t === 'error') report.consoleErrors.push(text);
  else if (t === 'warning') report.consoleWarnings.push(text);
});
page.on('pageerror', (err) => report.pageErrors.push(String(err && err.stack ? err.stack : err)));
page.on('requestfailed', (req) => {
  report.requestFailures.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText || '?'}`);
});
page.on('response', (res) => {
  const u = res.url();
  if (/\.wasm(\?|$)/.test(u) || /\.js(\?|$)/.test(u)) {
    report.wasmResponses.push({
      url: u,
      status: res.status(),
      contentType: res.headers()['content-type'] || '',
      contentEncoding: res.headers()['content-encoding'] || '',
      contentLength: res.headers()['content-length'] || '',
    });
  }
});

console.log('导航到 ' + URL);
try {
  const resp = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  report.navigation = { status: resp ? resp.status() : null, ok: resp ? resp.ok() : false };
  console.log('导航 HTTP ' + (resp ? resp.status() : 'null'));
  if (!resp || !resp.ok()) {
    report.hardFailures.push('首页返回 ' + (resp ? resp.status() : '无响应'));
  }
} catch (e) {
  report.navigation = { error: String(e) };
  report.hardFailures.push('导航失败: ' + String(e));
}

// 等应用挂载 canvas（iced/wgpu 渲染目标）
let canvasFound = false;
if (report.hardFailures.length === 0) {
  console.log('等待应用挂载 canvas（最多 ' + Math.round(TIMEOUT / 1000) + 's）...');
  try {
    await page.waitForSelector('canvas', { timeout: TIMEOUT });
    canvasFound = true;
    console.log('检测到 canvas ✔');
  } catch {
    console.log('未在超时内检测到 canvas');
    report.warnings.push('未检测到 canvas，UI 可能没有渲染');
  }
  // 给 wasm 初始化留点时间
  await page.waitForTimeout(8000);

  try {
    report.page = await page.evaluate(() => {
      const pick = (n) => document.querySelectorAll(n).length;
      let webgl2 = false, webgpu = false;
      try {
        const c = document.createElement('canvas');
        webgl2 = !!c.getContext('webgl2');
      } catch {}
      try {
        webgpu = !!navigator.gpu;
      } catch {}
      return {
        title: document.title,
        canvases: pick('canvas'),
        scripts: pick('script'),
        links: pick('link'),
        bodyTextLen: (document.body && document.body.innerText ? document.body.innerText.length : 0),
        bodyTextHead: (document.body && document.body.innerText ? document.body.innerText.slice(0, 300) : ''),
        htmlLen: document.documentElement.outerHTML.length,
        crossOriginIsolated: !!window.crossOriginIsolated,
        webgl2,
        webgpu,
        readyState: document.readyState,
      };
    });
  } catch (e) {
    report.warnings.push('页面内取值失败: ' + String(e));
  }

  try {
    await page.screenshot({ path: 'e2e-shot.png' });
    console.log('已截图 e2e-shot.png');
  } catch (e) {
    report.warnings.push('截图失败: ' + String(e));
  }
}

// 判定
for (const r of report.wasmResponses) {
  if (r.url.endsWith('.wasm') && r.status !== 200) {
    report.hardFailures.push(`wasm 返回 ${r.status}: ${r.url}`);
  }
}
for (const e of report.pageErrors) {
  report.hardFailures.push('JS 未捕获异常: ' + e.split('\n')[0]);
}
if (!report.page || report.page.canvases === 0) {
  report.warnings.push('页面里没有 canvas');
}
if (report.page && !report.page.webgl2) {
  report.warnings.push('该浏览器环境没有 WebGL2（swiftshader 可能未生效），渲染是否正常无法据此判断');
}

report.finishedAt = new Date().toISOString();
report.summary = {
  navigationStatus: report.navigation?.status ?? null,
  canvasFound,
  canvasCount: report.page?.canvases ?? 0,
  consoleErrors: report.consoleErrors.length,
  pageErrors: report.pageErrors.length,
  requestFailures: report.requestFailures.length,
  hardFailures: report.hardFailures.length,
  warnings: report.warnings.length,
};

fs.writeFileSync('e2e-report.json', JSON.stringify(report, null, 2));

console.log('\n================ E2E 报告 ================');
console.log(JSON.stringify(report.summary, null, 2));
if (report.page) console.log('页面信息: ' + JSON.stringify(report.page, null, 2));
if (report.consoleErrors.length) {
  console.log('\n--- console.error ---');
  report.consoleErrors.slice(0, 20).forEach((x) => console.log('  ' + x));
}
if (report.pageErrors.length) {
  console.log('\n--- 未捕获异常 ---');
  report.pageErrors.slice(0, 10).forEach((x) => console.log('  ' + x.split('\n').slice(0, 4).join('\n  ')));
}
if (report.requestFailures.length) {
  console.log('\n--- 请求失败 ---');
  report.requestFailures.slice(0, 20).forEach((x) => console.log('  ' + x));
}
if (report.wasmResponses.length) {
  console.log('\n--- wasm/js 响应 ---');
  report.wasmResponses.slice(0, 20).forEach((x) => console.log('  ' + JSON.stringify(x)));
}
if (report.hardFailures.length) {
  console.log('\n--- 硬性失败 ---');
  report.hardFailures.forEach((x) => console.log('  ✗ ' + x));
} else {
  console.log('\n✔ 无硬性失败');
}
if (report.warnings.length) {
  console.log('\n--- 警告 ---');
  report.warnings.forEach((x) => console.log('  ! ' + x));
}
console.log('=========================================');

await browser.close();
process.exit(report.hardFailures.length ? 1 : 0);
