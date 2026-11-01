// 维基问答机器人 - 后端：静态页 + Wiki 检索代理（多源降级：中文维基 → 英文维基 → Bing 百科检索）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const WIKI_TIMEOUT_MS = 4500;   // 维基可达性差的环境快速失败
const BING_TIMEOUT_MS = 8000;
const MAX_QUERY_LEN = 120;

// 维基熔断：连续不可达时 10 分钟内跳过，避免每次检索白等超时
let wikiFailStreak = 0;
let wikiDisabledUntil = 0;

// ---------- 简易限流（每 IP 每分钟 30 次） ----------
const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 30;
}

// ---------- 工具 ----------
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&ensp;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&middot;/g, '·').replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}
function stripTags(s) { return s.replace(/<[^>]+>/g, ''); }

async function fetchText(url, headers, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6', ...(headers || {}) },
    signal: AbortSignal.timeout(timeoutMs || BING_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// ---------- 源 1/2：维基百科 MediaWiki API ----------
async function searchWikipedia(lang, query) {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const searchUrl = api + '?action=query&list=search&format=json&srlimit=3&srsearch=' + encodeURIComponent(query);
  const searchData = JSON.parse(await fetchText(searchUrl, null, WIKI_TIMEOUT_MS));
  const hits = (searchData.query && searchData.query.search) || [];
  if (!hits.length) return [];

  const titles = hits.map(h => h.title);
  const extUrl = api + '?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&titles='
    + encodeURIComponent(titles.join('|'));
  let pages = {};
  try {
    const extData = JSON.parse(await fetchText(extUrl, null, WIKI_TIMEOUT_MS));
    pages = (extData.query && extData.query.pages) || {};
  } catch (e) { /* 摘要拿不到就退回 snippet */ }

  return hits.map(hit => {
    const page = Object.values(pages).find(p => p.title === hit.title);
    let snippet = (page && page.extract) || stripTags(hit.snippet || '');
    if (snippet.length > 1200) snippet = snippet.slice(0, 1200) + '…';
    return {
      title: hit.title,
      url: `https://${lang}.wikipedia.org/wiki/` + encodeURIComponent(hit.title.replace(/ /g, '_')),
      snippet: snippet || '（无摘要）',
      source: `${lang === 'zh' ? '中文' : '英文'}维基百科`,
    };
  });
}

// ---------- 源 3：Bing 检索（国内可达，侧重百科类结果） ----------
async function searchBing(query) {
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-hans&count=8';
  const html = await fetchText(url);
  const results = [];
  const re = /<li class="b_algo"[\s\S]*?<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 5) {
    const link = m[1].startsWith('http') ? m[1] : 'https://www.bing.com' + m[1];
    const title = decodeEntities(stripTags(m[2]));
    const capMatch = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    let snippet = decodeEntities(capMatch ? stripTags(capMatch[1]) : '');
    if (snippet.length > 600) snippet = snippet.slice(0, 600) + '…';
    if (title && link) results.push({ title, url: link, snippet: snippet || '（无摘要）', source: 'Bing 检索' });
  }
  return results;
}

// ---------- 百度语音识别（ASR）----------
// Key 优先读 asr.keys.json（{"api_key":"...","secret_key":"..."}），其次环境变量
function loadAsrKeys() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'asr.keys.json'), 'utf8'));
    if (j.api_key && j.secret_key) return j;
  } catch (e) { /* 无配置文件 */ }
  if (process.env.BAIDU_ASR_API_KEY && process.env.BAIDU_ASR_SECRET_KEY) {
    return { api_key: process.env.BAIDU_ASR_API_KEY, secret_key: process.env.BAIDU_ASR_SECRET_KEY };
  }
  return null;
}
let asrToken = null; // {token, expiresAt}
function asrConfigured() { return !!loadAsrKeys(); }

async function getAsrToken() {
  if (asrToken && Date.now() < asrToken.expiresAt - 60_000) return asrToken.token;
  const keys = loadAsrKeys();
  if (!keys) throw Object.assign(new Error('语音识别未配置'), { code: 'ASR_NOT_CONFIGURED' });
  const url = 'https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id='
    + encodeURIComponent(keys.api_key) + '&client_secret=' + encodeURIComponent(keys.secret_key);
  const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('获取百度 token 失败 HTTP ' + res.status);
  const j = await res.json();
  if (!j.access_token) throw new Error('百度 token 响应异常：' + (j.error_description || 'unknown'));
  asrToken = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 2592000) * 1000 };
  return asrToken.token;
}

async function baiduAsr(wavBuf) {
  if (wavBuf.length > 5 * 1024 * 1024) throw Object.assign(new Error('录音太长'), { code: 'ASR_AUDIO_TOO_LONG' });
  const token = await getAsrToken();
  const body = {
    format: 'wav',
    rate: 16000,
    dev_pid: 1537, // 普通话（支持简单英文）
    cuid: 'wiki-qa-bot',
    channel: 1,
    token,
    speech: wavBuf.toString('base64'),
    len: wavBuf.length,
  };
  const res = await fetch('https://vop.baidu.com/server_api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json();
  if (j.err_no === 0 && j.result && j.result.length) {
    let text = j.result.join('').trim();
    if (text.endsWith('，') || text.endsWith('。') || text.endsWith('，')) text = text.slice(0, -1);
    return text;
  }
  const msgMap = {
    3300: '识别请求参数有误',
    3301: '音频质量太差，未能识别出内容，请靠近麦克风重试',
    3302: '语音识别鉴权失败，请检查 API Key 配置',
    3303: '百度语音服务暂时不可用，请稍后重试',
    3304: '语音识别免费额度已用完',
    3305: '语音识别请求过于频繁，请稍后重试',
  };
  throw Object.assign(new Error(msgMap[j.err_no] || ('识别失败（错误码 ' + j.err_no + '）')), { code: 'ASR_UPSTREAM', baiduErr: j.err_no });
}

// ---------- 检索入口：多源降级（中/英维基并行探测，失败熔断） ----------
async function wikiSearch(query) {
  const errors = [];
  if (Date.now() < wikiDisabledUntil) {
    errors.push('wikipedia: 熔断跳过（近期不可达）');
  } else {
    const [zhRes, enRes] = await Promise.allSettled([
      searchWikipedia('zh', query),
      searchWikipedia('en', query),
    ]);
    if (zhRes.status === 'fulfilled' && zhRes.value.length) {
      wikiFailStreak = 0;
      return { source: 'zh-wikipedia', results: zhRes.value };
    }
    if (enRes.status === 'fulfilled' && enRes.value.length) {
      wikiFailStreak = 0;
      return { source: 'en-wikipedia', results: enRes.value };
    }
    wikiFailStreak++;
    if (wikiFailStreak >= 2) wikiDisabledUntil = Date.now() + 10 * 60_000;
    for (const r of [zhRes, enRes]) {
      if (r.status === 'rejected') errors.push('wikipedia: ' + r.reason.message);
    }
  }
  try {
    const results = await searchBing(query);
    if (results.length) return { source: 'bing', results };
  } catch (e) { errors.push('bing: ' + e.message); }
  return { source: 'none', results: [], errors };
}

// ---------- HTTP 服务 ----------
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
  '/icons/icon.svg': ['icons/icon.svg', 'image/svg+xml'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  const staticEntry = STATIC_FILES[u.pathname];
  if (staticEntry) {
    fs.readFile(path.join(__dirname, staticEntry[0]), (err, buf) => {
      if (err) { res.writeHead(500); res.end('read ' + staticEntry[0] + ' failed'); return; }
      const headers = { 'Content-Type': staticEntry[1] };
      if (u.pathname === '/sw.js') headers['Cache-Control'] = 'no-cache';
      res.writeHead(200, headers);
      res.end(buf);
    });
    return;
  }

  if (u.pathname === '/api/asr/status') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(200);
    res.end(JSON.stringify({ configured: asrConfigured() }));
    return;
  }

  if (u.pathname === '/api/asr') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'method not allowed' })); return; }
    if (rateLimited(ip)) { res.writeHead(429); res.end(JSON.stringify({ error: '请求过于频繁，请稍后再试' })); return; }
    if (!asrConfigured()) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: '语音识别未配置：请在服务端 asr.keys.json 中填入百度 API Key', code: 'ASR_NOT_CONFIGURED' }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 6 * 1024 * 1024) req.destroy(); else chunks.push(c); });
    req.on('error', () => {});
    req.on('end', async () => {
      try {
        const text = await baiduAsr(Buffer.concat(chunks));
        res.writeHead(200);
        res.end(JSON.stringify({ text }));
      } catch (e) {
        const status = e.code === 'ASR_NOT_CONFIGURED' ? 503 : (e.code === 'ASR_AUDIO_TOO_LONG' ? 413 : 502);
        res.writeHead(status);
        res.end(JSON.stringify({ error: e.message, code: e.code || 'ASR_FAIL' }));
      }
    });
    return;
  }

  if (u.pathname === '/api/wiki') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'GET') { res.writeHead(405); res.end(JSON.stringify({ error: 'method not allowed' })); return; }
    if (rateLimited(ip)) { res.writeHead(429); res.end(JSON.stringify({ error: '请求过于频繁，请稍后再试' })); return; }

    const q = (u.searchParams.get('q') || '').trim().slice(0, MAX_QUERY_LEN);
    if (!q) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少检索词 q' })); return; }

    try {
      const data = await wikiSearch(q);
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: '检索服务暂时不可用，请稍后重试' }));
    }
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`wiki-qa-bot listening on 0.0.0.0:${PORT}`);
});
