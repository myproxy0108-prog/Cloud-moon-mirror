const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const archiver = require('archiver');
const app = express();

// ==========================================
// 1. 設定：Cloudflare Workers クラスター
// ==========================================
const WORKER_CONFIGS = [
    "https://api-nemu.myproxy0108.workers.dev",
    "https://tuneninemui.nemu0001.workers.dev"
];

// Workerの状態管理プール
const workers = WORKER_CONFIGS.map(url => ({
    url: url.replace(/\/$/, ''), // 末尾スラッシュを自動正規化
    isAlive: true,
    failCount: 0
}));

let rrIndex = 0;

// 【ヘルパー】生存している Worker をラウンドロビンで1つ選出
function getActiveWorker() {
    const active = workers.filter(w => w.isAlive);

    // 万が一全滅した場合は緊急リセットして再チャレンジ（全滅セーフティ）
    if (active.length === 0) {
        console.warn('⚠️ ALL WORKERS DOWN! Emergency resetting pool...');
        workers.forEach(w => { w.isAlive = true; w.failCount = 0; });
        return workers[0];
    }

    return active[rrIndex++ % active.length];
}

// 障害判定
function markWorkerFailure(worker) {
    worker.failCount++;
    console.warn(`⚠️ Worker [${worker.url}] failed (${worker.failCount}/3)`);
    if (worker.failCount >= 3) {
        worker.isAlive = false;
        console.error(`🚨 Worker [${worker.url}] IS ISOLATED due to failures!`);
    }
}

// 正常復帰
function markWorkerSuccess(worker) {
    worker.failCount = 0;
    worker.isAlive = true;
}

// 通信安定化エージェント（setIntervalより先に定義）
const proxyAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 600,
    timeout: 60000
});

// 【バックグラウンドヘルスチェック】障害Workerの自動復帰診断（30秒周期）
setInterval(async () => {
    for (const w of workers) {
        if (!w.isAlive) {
            try {
                const res = await fetch(w.url + '/favicon.ico', {
                    method: 'GET',
                    agent: proxyAgent,
                    timeout: 5000
                });
                if (res.ok || res.status === 404 || res.status === 302) {
                    console.log(`✅ Worker [${w.url}] RECOVERED & BACK ALIVE!`);
                    markWorkerSuccess(w);
                }
            } catch (e) {
                // 復帰失敗時は静観
            }
        }
    }
}, 30000);

app.use(express.raw({ type: '*/*', limit: '50mb' }));

// ==========================================
// 2. 広告抹殺パターン設定
// ==========================================
const AD_DOMAINS = [
    'universityshocksooner.com',
    'adexchangerapid.com',
    'platform.pubadx.one',
    'preferencenail.com',
    'gomuraw.js',
    'vntsm.com'
];

const DOWNLOAD_BUTTON_CODE = `
<script>
(function() {
  if (window.__zipDlLoaded) return;
  window.__zipDlLoaded = 1;

  function isReadPage() {
    try {
      const u = new URL(location.href);
      return u.pathname === '/read' && u.searchParams.has('id');
    } catch (_) { return false; }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 表示されているか（高さ0・display:none は押しても効かない）
  function visible(el) {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // 「続きを読む / さらに読み込む」ボタンを押す
  async function clickLoadMore() {
    const sels = [
      '#load-more-chapters', '.load-more', '.read-more',
      '[id*="load-more"]', '[class*="load-more"]',
      'button[onclick*="load"]', 'a[onclick*="load"]'
    ];
    for (const sel of sels) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (!visible(el) || el.disabled) continue;
        const txt = (el.textContent || '').trim();
        // 明らかに「読み込み」系でなければスキップ（誤爆防止）
        if (txt && !/続き|もっと|さらに|次|読み込|load|more/i.test(txt) && !sel.includes('load-more')) continue;
        try { el.click(); await sleep(600); return true; } catch (_) {}
      }
    }
    return false;
  }

  // メイン: 最下部まで自動スクロールして、すべての画像を読み込ませる
  async function autoScrollAll(setStatus) {
    const STEP_WAIT = 280;      // 1回のスクロール後の待ち
    const STABLE_LIMIT = 4;     // 高さ・画像数が N 回連続で変わらなければ終了
    const MAX_LOOPS = 500;      // 無限スクロール暴走の安全弁

    // 一度最下部 → 最上部 → 最下部 とすると、lazy-load が全発火しやすい
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(200);
    window.scrollTo(0, 0);
    await sleep(200);

    let lastH = 0, lastN = 0, stable = 0;

    for (let loop = 0; loop < MAX_LOOPS; loop++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(STEP_WAIT);

      // 「続きを読む」があれば押す（高さが変わるので、stable カウントはリセットされる）
      await clickLoadMore();

      const h = document.documentElement.scrollHeight;
      const n = document.querySelectorAll('img').length;

      if (setStatus) {
        const pct = Math.min(99, Math.round((loop / 30) * 100));
        setStatus('ページを読み込み中... (' + pct + '%)');
      }

      if (h === lastH && n === lastN) {
        stable++;
        if (stable >= STABLE_LIMIT) break;
      } else {
        stable = 0; lastH = h; lastN = n;
      }
    }

    // IntersectionObserver が発火しなかった画像への保険:
    // data-src / data-original を src に強制反映
    document.querySelectorAll('img[data-src], img[data-original]').forEach(img => {
      const real = img.dataset.src || img.dataset.original;
      if (real && img.getAttribute('src') !== real) {
        try { img.setAttribute('src', real); } catch (_) {}
      }
    });

    // すべての img が load 完了 or error になるまで待つ（最大15秒）
    const imgs = Array.from(document.querySelectorAll('img'));
    await Promise.all(imgs.map(img => {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(res => {
        const done = () => res();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        setTimeout(done, 15000);
      });
    }));

    // 収集前に一呼吸（img.src が実URLになっていないことがある）
    await sleep(500);
    window.scrollTo(0, 0);
  }

  // 画像候補を収集
  function collect() {
    const all = Array.from(document.querySelectorAll('img'));
    const cands = all.filter(img => {
      const src = img.dataset.src || img.dataset.original || img.src || '';
      if (!src || src.startsWith('data:') || src.startsWith('blob:')) return false;
      if (img.dataset.src || img.dataset.original) return true;
      return img.naturalWidth >= 200 && img.naturalHeight >= 200;
    });
    const items = cands.map(img => {
      const raw = img.dataset.src || img.dataset.original || img.src;
      try {
        const abs = new URL(raw, location.href);
        if (abs.host === location.host) return { path: abs.pathname + abs.search };
        return { url: abs.href };
      } catch (_) { return null; }
    }).filter(Boolean);
    const seen = new Set();
    const uniq = [];
    items.forEach(it => {
      const k = it.path || it.url;
      if (seen.has(k)) return;
      seen.add(k); uniq.push(it);
    });
    return uniq;
  }

  function addBtn() {
    if (!isReadPage()) return;
    if (document.getElementById('__zip_dl_btn')) return;

    const btn = document.createElement('button');
    btn.id = '__zip_dl_btn';
    btn.type = 'button';
    btn.innerHTML = '📦 ZIPダウンロード';
    btn.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px',
      'z-index:2147483000',
      'padding:12px 20px',
      'background:#be185d', 'color:#fff', 'border:none',
      'border-radius:8px', 'font-size:16px', 'font-weight:bold',
      'cursor:pointer', 'box-shadow:0 4px 12px rgba(0,0,0,.4)',
      'font-family:system-ui,-apple-system,sans-serif'
    ].join(';');

    const setStatus = (txt) => { btn.textContent = txt; };

    btn.onclick = async () => {
      if (!isReadPage()) { btn.remove(); return; }
      if (btn.disabled) return;
      btn.disabled = true;
      const original = '📦 ZIPダウンロード';

      try {
        // ① 自動で全部読み込ませる
        await autoScrollAll(setStatus);

        // ② 画像を収集
        const items = collect();
        if (items.length === 0) {
          alert('画像が見つかりませんでした');
          btn.disabled = false; btn.textContent = original;
          return;
        }

        // ③ サーバーへ送ってZIP化
        setStatus('⏳ ' + items.length + '枚を取得中...');
        const u = new URL(location.href);
        const mangaId = (u.searchParams.get('id') || 'manga')
          .replace(/[\\\\/:*?"<>|]/g, '_').substring(0, 40);
        const title = 'manga_' + mangaId;

        const resp = await fetch('/__download_zip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, title, referer: location.href })
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        // ④ ダウンロード
        const blob = await resp.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = title + '.zip';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);

        setStatus('✅ 完了! (' + items.length + '枚)');
        setTimeout(() => { btn.disabled = false; btn.textContent = original; }, 3000);
      } catch (e) {
        console.error('[ZIP]', e);
        alert('ダウンロード失敗: ' + e.message);
        btn.disabled = false; btn.textContent = original;
      }
    };

    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addBtn);
  } else {
    addBtn();
  }

  // SPA遷移対策（/read を外れたら消す、戻ったら再表示）
  setInterval(() => {
    const b = document.getElementById('__zip_dl_btn');
    if (!b) { addBtn(); return; }
    b.style.display = isReadPage() ? 'block' : 'none';
  }, 1500);
})();
</script>
`;
// ==========================================
// 3. 画像の拡張子判定（マジックバイト検出）
// ==========================================
function detectImageExt(buffer) {
    if (!buffer || buffer.length < 12) return null;
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'jpg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'webp';
    return null;
}

// ==========================================
// 4. ZIPダウンロードエンドポイント
//    ※ 必ず catch-all（app.all('*')）より前に登録すること
// ==========================================
app.post('/__download_zip', async (req, res) => {
    // express.raw で Buffer になっているボディを手動パース
    let body;
    try {
        if (Buffer.isBuffer(req.body)) {
            body = JSON.parse(req.body.toString('utf-8'));
        } else if (typeof req.body === 'string') {
            body = JSON.parse(req.body);
        } else if (req.body && typeof req.body === 'object') {
            body = req.body;
        } else {
            throw new Error('Body is empty');
        }
    } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON: ' + e.message });
    }

    const { items, title, referer } = body || {};
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'No items' });
    }

    // 有効なアイテムだけ抽出
    const validItems = items.filter(it => it && typeof it === 'object' && (it.path || it.url));
    if (validItems.length === 0) {
        return res.status(400).json({ error: 'No valid items' });
    }

    const safeTitle = String(title || 'manga')
        .replace(/[\\/:*?"<>|]/g, '_')
        .substring(0, 80) || 'manga';

    console.log(`[ZIP] Starting download: ${validItems.length} images → "${safeTitle}.zip"`);

    // ヘッダー設定（ZIPストリーミング開始）
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(safeTitle)}.zip"; filename*=UTF-8''${encodeURIComponent(safeTitle)}.zip`
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', err => console.warn('[ZIP] warning:', err));
    archive.on('error', err => {
        console.error('[ZIP] archiver error:', err);
        try { res.destroy(); } catch (_) {}
    });
    archive.pipe(res);

    let successCount = 0;
    let failCount = 0;

    // ★ 順次取得（メモリ節約：1枚ずつバッファ→append→破棄）
    for (let i = 0; i < validItems.length; i++) {
        const item = validItems[i];
        try {
            let fetchUrl;
            if (item.path) {
                // プロキシ経由（Workerへ直接アクセス：二重プロキシ回避）
                fetchUrl = getActiveWorker().url + item.path;
            } else {
                fetchUrl = item.url;
            }

            // Refererをセット（直リンクブロック対策）
            let ref;
            try {
                ref = referer || new URL(fetchUrl).origin + '/';
            } catch (_) {
                ref = undefined;
            }

            const resp = await fetch(fetchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    ...(ref ? { 'Referer': ref } : {})
                },
                agent: proxyAgent,
                timeout: 30000,
                redirect: 'follow',
                compress: true
            });

            if (!resp.ok) {
                console.warn(`[ZIP] Image ${i + 1} HTTP ${resp.status}: ${fetchUrl}`);
                failCount++;
                continue;
            }

            const buffer = Buffer.from(await resp.arrayBuffer());
            if (buffer.length === 0) {
                console.warn(`[ZIP] Image ${i + 1} empty: ${fetchUrl}`);
                failCount++;
                continue;
            }

            // 画像シグネチャで検証（HTMLエラーページ等を排除）
            const ext = detectImageExt(buffer);
            if (!ext) {
                console.warn(`[ZIP] Image ${i + 1} not a valid image (${buffer.length} bytes)`);
                failCount++;
                continue;
            }

            const filename = `${String(successCount + 1).padStart(4, '0')}.${ext}`;
            archive.append(buffer, { name: filename });
            successCount++;

            if ((i + 1) % 10 === 0) {
                console.log(`[ZIP] Progress: ${i + 1}/${validItems.length} (${successCount} OK, ${failCount} NG)`);
            }
        } catch (e) {
            console.error(`[ZIP] Image ${i + 1} error:`, e.message);
            failCount++;
        }
    }

    if (successCount === 0) {
        console.error('[ZIP] No images could be fetched, destroying response');
        try { archive.abort(); } catch (_) {}
        try { res.destroy(); } catch (_) {}
        return;
    }

    console.log(`[ZIP] Finalizing: ${successCount} images, ${failCount} failed`);
    await archive.finalize();
});

// ==========================================
// 5. メインプロキシロジック（自動リトライ機能付）
// ==========================================
app.all('*', async (req, res) => {
    if (req.url === '/favicon.ico') return res.status(204).end();

    // ★ /read?id=xxx 判定（クエリ順序や他パラメータに強いURLパース方式）
    let isReadPage = false;
    try {
        const u = new URL('http://x' + req.url);
        isReadPage = u.pathname === '/read' && u.searchParams.has('id');
    } catch (_) { isReadPage = false; }

    const maxRetries = workers.length;
    let attempt = 0;

    // 生きている Worker を探して自動リトライループ
    while (attempt < maxRetries) {
        attempt++;
        const worker = getActiveWorker();
        const targetUrl = worker.url + req.url;

        // ヘッダー整理
        const headers = { ...req.headers };
        delete headers.host;
        delete headers.connection;
        headers['X-Forwarded-Host'] = req.get('host');
        headers['X-Forwarded-Proto'] = 'https';

        try {
            const response = await fetch(targetUrl, {
                method: req.method,
                headers: headers,
                agent: proxyAgent,
                compress: true,
                redirect: 'follow',
                timeout: 12000, // 12秒応答がなければタイムアウト判定して次へ
                body: (req.method !== 'GET' && req.method !== 'HEAD') ? req.body : undefined
            });

            // 5xx (500, 502, 503, 504) は Worker の障害とみなして次の Worker へ切り替え
            if (response.status >= 500) {
                console.warn(`⚠️ Worker [${worker.url}] returned HTTP ${response.status}. Retrying another worker...`);
                markWorkerFailure(worker);
                continue;
            }

            // 成功！Workerの状態を正常にリセット
            markWorkerSuccess(worker);

            // レスポンスヘッダーの設定
            response.headers.forEach((v, k) => {
                if (!['content-encoding', 'transfer-encoding', 'content-length', 'content-security-policy'].includes(k.toLowerCase())) {
                    res.set(k, v);
                }
            });

            const contentType = response.headers.get("content-type") || "";

            // --- HTMLの場合：広告を検閲・物理削除 ---
            if (contentType.includes("text/html")) {
                let text = await response.text();

                // 1. 指定ドメインの広告コードを物理削除
                AD_DOMAINS.forEach(domain => {
                    const regex = new RegExp('<script[^>]*' + domain.replace('.', '\\.') + '[^>]*><\\/script>', 'gi');
                    text = text.replace(regex, "");
                    text = text.split(domain).join("localhost");
                });

                // 2. 末尾の強制リンクを削除
                text = text.replace(/<a[^>]*adexchangerapid\.com[^>]*>.*?<\/a>/gi, "");

                // 3. 広告ブロックコードは常時、ZIPボタンは /read?id=xxx のみ注入
                const inject = INJECT_CODE + (isReadPage ? DOWNLOAD_BUTTON_CODE : '');
                text = text.replace('<head>', '<head>' + inject);

                // 4. 文字化け対策
                res.set("Content-Type", "text/html; charset=utf-8");
                return res.status(response.status).send(text);
            }

            // --- 画像・JS・CSSの場合：爆速ストリーミング ---
            if (req.url.includes('_p_')) {
                res.set('Cache-Control', 'public, max-age=31536000, immutable');
            }
            res.status(response.status);
            return response.body.pipe(res);

        } catch (error) {
            console.error(`Attempt ${attempt} failed on [${worker.url}]:`, error.message);
            markWorkerFailure(worker);
        }
    }

    // すべての Worker で失敗した場合
    console.error('Fatal Error: All Workers failed.');
    if (!res.headersSent) {
        res.status(502).send("Proxy Service Unavailable (All workers unreachable)");
    }
});

// ==========================================
// 6. サーバー起動
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`--- ULTIMATE CLUSTER PROXY ENGINE ONLINE (port ${PORT}) ---`));
