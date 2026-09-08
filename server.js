const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const ebayApi = require('./ebay-api');
const app = express();
let autoSyncRunning = false;
let lastSyncAt = 0;          // 最後に同期が成功した時刻（ミリ秒）
let syncLog = [];            // 直近の同期履歴（監査用）

function recordSync(entry) {
  syncLog.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  if (syncLog.length > 30) syncLog = syncLog.slice(0, 30);
}
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== Google Sheets JWT認証 =====
async function getGoogleAccessToken() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${b64(header)}.${b64(payload)}`;
  const { createSign } = require('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(creds.private_key, 'base64url');
  const jwt = `${signingInput}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  return data.access_token;
}

// ===== Sheetsへ状態を書き込む =====
async function writeStateToSheet(rowIndex, read, starred, replied, memo) {
  try {
    const sheetId = process.env.SHEET_ID;
    if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return;
    const token = await getGoogleAccessToken();
    const sheetName = encodeURIComponent('シート1');
    // rowIndex は1始まり（ヘッダー行=1、データ行=2〜）
    const dataRow = rowIndex + 1; // ヘッダー分+1
    // read=H列, starred=I列, replied=J列, memo=K列
    const range = `${sheetName}!H${dataRow}:K${dataRow}`;
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`;
    await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range: `シート1!H${dataRow}:K${dataRow}`,
        majorDimension: 'ROWS',
        values: [[
          read ? 'true' : 'false',
          starred ? 'true' : 'false',
          replied ? 'true' : 'false',
          memo || ''
        ]],
      }),
    });
  } catch (e) {
    console.error('writeStateToSheet error:', e.message);
  }
}

// ===== eBayメール解析関数 =====
function parseEbayEmail(rawBody, fromName) {
  if (!rawBody) return { buyer: fromName || 'unknown', newMsg: '', history: [], itemId: '', orderId: '', itemName: '', sold: false };

  // 1. バイヤー名
  let buyer = fromName || '';
  const buyerFromName = buyer.match(/eBay\s*-\s*(.+)/);
  if (buyerFromName) {
    buyer = buyerFromName[1].trim();
  } else {
    const buyerFromBody = rawBody.match(/New message from:\s*\n+\s*(\S+)/);
    if (buyerFromBody) buyer = buyerFromBody[1].trim();
  }

  // 2. 最新メッセージ抽出
  let newMsg = '';
  const newMsgMatch = rawBody.match(/New message from:[\s\S]*?\([^)]*\)\s*\n+([\s\S]*?)\n+-->/);
  if (newMsgMatch) newMsg = newMsgMatch[1].trim();
  if (!newMsg) {
    const fallback = rawBody.match(/New message:\s*(.+)/);
    if (fallback) newMsg = fallback[1].trim();
  }

  // 3. 会話履歴抽出（修正版）
  // Dear samuraisoul142142, [TEXT] - buyer → from:'buyer'
  // Dear buyer名, [TEXT] - samuraisoul142142 → from:'me'
  const SELLER = 'samuraisoul142142';
  const history = [];
  const seen = new Set();
  const blockRe = /Dear ([^,\n]+),\s*\n+([\s\S]*?)\n+- (\S+)(?:\n|$)/g;
  let blockMatch;
  const allBlocks = [];
  while ((blockMatch = blockRe.exec(rawBody)) !== null) {
    allBlocks.push({ recipient: blockMatch[1].trim(), text: blockMatch[2].trim(), sender: blockMatch[3].trim() });
  }
  const newMsgKey = newMsg ? newMsg.substring(0, 60) : '';
  for (const block of allBlocks) {
    const key = block.text.substring(0, 60);
    if (seen.has(key)) continue;
    if (newMsgKey && key === newMsgKey) continue;
    seen.add(key);
    let from;
    if (block.recipient.toLowerCase() === SELLER.toLowerCase()) {
      from = 'buyer'; // Dear セラー → バイヤーから来たメッセージ
    } else if (block.sender.toLowerCase() === SELLER.toLowerCase()) {
      from = 'me'; // - セラー → セラーが送ったメッセージ
    } else {
      from = 'buyer'; // どちらでもなければバイヤー扱い
    }
    history.push({ from, text: block.text });
  }
  history.reverse();

  // 4. Item ID / Order番号
  const itemIdMatch = rawBody.match(/Item ID:\s*(\d+)/);
  const orderMatch = rawBody.match(/Order number:\s*([\d-]+)/);

  // 5. 商品名（Item IDの前の行から）
  let itemName = '';
  const lines = rawBody.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/Item ID:\s*\d+/) && i > 0) {
      const candidate = lines[i - 1].trim();
      if (candidate && candidate.length > 3 && !candidate.match(/^(Dear|Hi|Hello|Thank|Best|Ken|View|Order|Email|We |©)/i)) {
        itemName = candidate;
        break;
      }
    }
  }

  // 6. SOLD判定
  const sold = /Order status:\s*(Paid|Shipped|Complete)/i.test(rawBody) || /Order number:/i.test(rawBody);

  return { buyer, newMsg, history, itemId: itemIdMatch ? itemIdMatch[1] : '', orderId: orderMatch ? orderMatch[1] : '', itemName, sold };
}

// ===== 件名から商品名を抽出 =====
function extractItemFromSubject(subject) {
  if (!subject) return '';
  // 最優先：PDT - 商品名
  let m = subject.match(/PDT\s+-\s+(.+)/i);
  if (m) return m[1].trim();
  // about 商品名 #ID（"item"という単語だけは除外）
  m = subject.match(/(?:about|regarding)\s+(.+?)(?:\s+#\d+|$)/i);
  if (m) {
    const candidate = m[1].trim();
    if (candidate.toLowerCase() !== 'item') return candidate;
  }
  // イタリア語
  m = subject.match(/relativo\s+a\s+(.+?)(?:\s+n[°o\s]*\d+|\s+#\d+|$)/i);
  if (m) return m[1].trim();
  // スペイン語
  m = subject.match(/sobre\s+(.+?)(?:\s+#\d+|$)/i);
  if (m) return m[1].trim();
  return '';
}

// ===== ヘルスチェック（スリープ防止用） =====
app.get('/ping', (req, res) => {
  res.send('OK');
});

// ===== eBay OAuth: 認証開始 =====
app.get('/api/ebay/auth', (req, res) => {
  try {
    res.redirect(ebayApi.getAuthUrl());
  } catch (e) {
    res.status(500).send('エラー: ' + e.message);
  }
});

// ===== eBay OAuth: コールバック（認証コード受け取り） =====
app.get('/api/ebay/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.send('<h2>認証エラー</h2><p>認証コードがありません。</p><p>' + JSON.stringify(req.query) + '</p>');
  }
  try {
    const tokens = await ebayApi.exchangeCodeForTokens(code);
    const rt = tokens.refresh_token || '';
    const expDays = Math.round((tokens.refresh_token_expires_in || 0) / 86400);
    res.send(
      '<html><head><meta charset="utf-8"><title>eBay認証完了</title>' +
      '<style>body{font-family:sans-serif;max-width:900px;margin:40px auto;padding:20px;line-height:1.7;}' +
      'textarea{width:100%;height:160px;font-family:monospace;font-size:12px;padding:10px;border:2px solid #2563eb;border-radius:8px;}' +
      '.box{background:#eff6ff;border:1px solid #93c5fd;border-radius:8px;padding:16px;margin:16px 0;}' +
      '.ok{color:#059669;font-weight:700;font-size:20px;}' +
      'button{background:#2563eb;color:#fff;border:none;padding:10px 20px;border-radius:6px;font-size:14px;cursor:pointer;}' +
      '</style></head><body>' +
      '<p class="ok">✓ 認証に成功しました</p>' +
      '<div class="box"><b>次の手順：</b><br>' +
      '1. 下のリフレッシュトークンをコピー<br>' +
      '2. Render の環境変数 <code>EBAY_REFRESH_TOKEN</code> に貼り付け<br>' +
      '3. <code>EBAY_ACCESS_TOKEN</code> は削除<br>' +
      '4. Save Changes</div>' +
      '<p><b>Refresh Token</b>（有効期限：約' + expDays + '日）</p>' +
      '<textarea id="rt" readonly onclick="this.select()">' + rt + '</textarea>' +
      '<p><button onclick="navigator.clipboard.writeText(document.getElementById(\'rt\').value);this.textContent=\'✓ コピーしました\';">クリップボードにコピー</button></p>' +
      '<p><a href="https://dashboard.render.com/web/srv-d7f0m44vikkc73c83ghg/env" target="_blank">→ Renderの環境変数ページを開く</a></p>' +
      '</body></html>'
    );
  } catch (e) {
    res.send('<html><head><meta charset="utf-8"></head><body><h2>交換エラー</h2><pre>' + e.message + '</pre></body></html>');
  }
});

// ===== eBay API: 接続テスト =====
app.get('/api/ebay/test', async (req, res) => {
  try {
    const result = await ebayApi.testConnection();
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== シートの重複行を削除 =====
app.get('/api/sheet/dedupe', async (req, res) => {
  try {
    const sheetId = process.env.SHEET_ID;
    if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      return res.json({ ok: false, error: 'シート設定がありません' });
    }
    const token = await getGoogleAccessToken();
    const sheetName = encodeURIComponent('シート1');
    const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A:O`;
    const r = await fetch(getUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await r.json();
    const rows = data.values || [];
    if (rows.length <= 1) return res.json({ ok: true, removed: 0 });

    const headers = rows[0];
    const convIdx = headers.indexOf('conversationId');
    if (convIdx < 0) return res.json({ ok: false, error: 'conversationId列がありません' });

    // 後ろから見て、同じconversationIdの初出（=最新）だけ残す
    const seen = {};
    const keep = [];
    for (let i = rows.length - 1; i >= 1; i--) {
      const cid = rows[i][convIdx] || '';
      if (cid) {
        if (seen[cid]) continue;
        seen[cid] = true;
      }
      keep.unshift(rows[i]);
    }
    const removed = (rows.length - 1) - keep.length;
    if (removed === 0) return res.json({ ok: true, removed: 0, total: keep.length });

    // 全消去して書き直す
    const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A2:O10000:clear`;
    await fetch(clearUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });

    const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A2?valueInputOption=RAW`;
    await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: keep }),
    });

    res.json({ ok: true, removed, remaining: keep.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 購入者一覧をキャッシュ（SOLD判定用） =====
let buyerOrderSet = new Set();
let buyerSetUpdatedAt = 0;
let orderByBuyer = {};   // username(lower) -> 注文オブジェクト（最新）
let cancelByBuyer = {};  // username(lower) -> キャンセル情報
let buyerByOrderId = {}; // orderId -> username(lower)

// Post-Order APIからキャンセル一覧を取得し、バイヤー単位のマップを作る
async function refreshCancelMap() {
  try {
    const cmap = await ebayApi.getCancellations(180);
    if (!cmap) return;
    const byBuyer = {};
    // キャンセル側から注文IDでバイヤーを引く（複数注文があっても取りこぼさない）
    Object.keys(cmap).forEach(oid => {
      const lu = buyerByOrderId[oid];
      if (!lu) return;
      const hit = cmap[oid];
      {
        const ci = ebayApi.cancelInfo(hit.state);
        // 未決着（対応が必要なもの）を優先して残す
        const cur = byBuyer[lu];
        if (cur && cur.kind !== 'open' && ci.kind === 'open') {
          // openを優先
        } else if (cur && cur.kind === 'open' && ci.kind !== 'open') {
          return;
        } else if (cur && new Date(cur.requestedAt || 0) > new Date(hit.requestedAt || 0)) {
          return;
        }
        byBuyer[lu] = {
          state: hit.state,
          label: ci.label,
          short: ci.short,
          kind: ci.kind,
          requestedAt: hit.requestedAt,
          closedAt: hit.closedAt,
          reason: hit.reason,
          reasonLabel: ebayApi.cancelReasonLabel(hit.reason),
          initiator: hit.initiator,
          cancelId: hit.cancelId,
        };
      }
    });
    cancelByBuyer = byBuyer;
    console.log('[cancelMap] ' + Object.keys(byBuyer).length + '件のキャンセルを紐付け');
  } catch (e) {
    console.error('refreshCancelMap error:', e.message);
  }
}
async function refreshBuyerSet() {
  if (Date.now() - buyerSetUpdatedAt < 10 * 60 * 1000) return buyerOrderSet;
  try {
    const at = await ebayApi.getAccessToken();
    const from = new Date(Date.now() - 180 * 86400000).toISOString();
    const f = encodeURIComponent('creationdate:[' + from + '..]');
    const s = new Set();
    let offset = 0;
    for (let p = 0; p < 30; p++) {
      const or = await fetch('https://api.ebay.com/sell/fulfillment/v1/order?filter=' + f
        + '&limit=200&offset=' + offset,
        { headers: { 'Authorization': 'Bearer ' + at, 'Accept': 'application/json' } });
      if (!or.ok) { console.error('[buyerSet] ' + or.status); break; }
      const od = await or.json();
      const batch = od.orders || [];
      batch.forEach(o => {
        const u = (o.buyer && o.buyer.username) || '';
        if (!u) return;
        const lu = u.toLowerCase();
        s.add(lu);
        // 最新の注文（表示用）
        const prev = orderByBuyer[lu];
        if (!prev || new Date(o.creationDate || 0) > new Date(prev.creationDate || 0)) {
          orderByBuyer[lu] = o;
        }
        // 注文IDからバイヤーを引けるようにする（キャンセル紐付け用）
        if (o.orderId) buyerByOrderId[o.orderId] = lu;
        if (o.legacyOrderId) buyerByOrderId[o.legacyOrderId] = lu;
      });
      if (batch.length < 200) break;
      offset += 200;
    }
    if (s.size > 0) {
      buyerOrderSet = s;
      buyerSetUpdatedAt = Date.now();
      console.log('[buyerSet] ' + s.size + '人の購入者を取得');
      // 注文が揃った後にキャンセル情報を紐付ける
      refreshCancelMap().catch(() => {});
    }
  } catch (e) { console.error('[buyerSet]', e.message); }
  return buyerOrderSet;
}

// ===== 既存データに商品情報とSOLD状態を一括反映 =====
// ===== 特定itemIdの画像・商品名をシートに強制反映 =====
app.get('/api/ebay/fiximage/:itemId', async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const info = await ebayApi.getItemInfo(itemId);
    if (!info) return res.json({ ok: false, error: '商品情報を取得できません' });

    const sheetId = process.env.SHEET_ID;
    const token = await getGoogleAccessToken();
    const sheetName = encodeURIComponent('シート1');
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A:O`,
      { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await r.json();
    const rows = data.values || [];
    const h = rows[0] || [];
    const iItemId = h.indexOf('itemId'), iItem = h.indexOf('item'), iImg = h.indexOf('imgUrl');
    if (iItemId < 0) return res.json({ ok: false, error: 'itemId列なし' });

    const updates = [];
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][iItemId] || '') !== String(itemId)) continue;
      const rowNum = i + 1;
      if (iItem >= 0 && info.title) {
        updates.push({ range: `シート1!${String.fromCharCode(65 + iItem)}${rowNum}`, values: [[info.title]] });
      }
      if (iImg >= 0 && info.imageUrl) {
        updates.push({ range: `シート1!${String.fromCharCode(65 + iImg)}${rowNum}`, values: [[info.imageUrl]] });
      }
    }
    if (updates.length > 0) {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
      });
    }
    res.json({ ok: true, itemId, title: info.title, imageUrl: info.imageUrl, rowsUpdated: updates.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/api/ebay/enrich', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 60;
    const sheetId = process.env.SHEET_ID;
    if (!sheetId) return res.json({ ok: false, error: 'SHEET_ID未設定' });
    const token = await getGoogleAccessToken();
    const sheetName = encodeURIComponent('シート1');

    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A:O`,
      { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await r.json();
    const rows = data.values || [];
    if (rows.length <= 1) return res.json({ ok: true, updated: 0 });

    const h = rows[0];
    const iItem = h.indexOf('item'), iItemId = h.indexOf('itemId'), iBuyer = h.indexOf('buyer');
    if (iItem < 0 || iItemId < 0) return res.json({ ok: false, error: 'item/itemId列なし' });

    // 購入者一覧を取得（SOLD判定用）
    let buyerSet = new Set();
    try {
      const at = await ebayApi.getAccessToken();
      const from = new Date(Date.now() - 180 * 86400000).toISOString();
      const f = encodeURIComponent('creationdate:[' + from + '..]');
      const or = await fetch('https://api.ebay.com/sell/fulfillment/v1/order?filter=' + f + '&limit=200',
        { headers: { 'Authorization': 'Bearer ' + at, 'Accept': 'application/json' } });
      if (or.ok) {
        const od = await or.json();
        (od.orders || []).forEach(o => {
          const u = (o.buyer && o.buyer.username) || '';
          if (u) buyerSet.add(u.toLowerCase());
        });
      }
    } catch (e) { console.error('order fetch:', e.message); }

    const updates = [];
    let done = 0;
    for (let i = rows.length - 1; i >= 1 && done < limit; i--) {
      const row = rows[i];
      const itemId = row[iItemId] || '';
      const curItem = row[iItem] || '';
      const buyer = (row[iBuyer] || '').toLowerCase();
      const rowNum = i + 1;

      const iImg = h.indexOf('imgUrl');
      const curImg = iImg >= 0 ? (row[iImg] || '') : '';
      const forceAll = req.query.force === '1';
      // 商品名または画像が空の行を処理（force=1なら既存も上書き）
      if (itemId && (forceAll || !curItem || (iImg >= 0 && !curImg))) {
        const info = await ebayApi.getItemInfo(itemId);
        if (info) {
          if (info.title && (forceAll || !curItem)) {
            const col = String.fromCharCode(65 + iItem);
            updates.push({ range: `シート1!${col}${rowNum}`, values: [[info.title]] });
          }
          if (info.imageUrl && iImg >= 0 && (forceAll || !curImg)) {
            const icol = String.fromCharCode(65 + iImg);
            updates.push({ range: `シート1!${icol}${rowNum}`, values: [[info.imageUrl]] });
          }
          done++;
        }
      }
    }

    if (updates.length > 0) {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
      });
    }
    res.json({ ok: true, updated: updates.length, buyersFound: buyerSet.size });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== キャンセル紐付けの診断 =====
app.get('/api/ebay/cancel-map', async (req, res) => {
  try {
    if (req.query.refresh === '1') await refreshCancelMap();
    const cmap = await ebayApi.getCancellations(180);
    const cancelIds = cmap ? Object.keys(cmap) : [];
    const matched = cancelIds.filter(id => buyerByOrderId[id]);
    res.json({
      ok: true,
      cancellations: cancelIds.length,
      ordersIndexed: Object.keys(buyerByOrderId).length,
      matched: matched.length,
      mappedBuyers: Object.keys(cancelByBuyer).length,
      unmatchedSample: cancelIds.filter(id => !buyerByOrderId[id]).slice(0, 8),
      matchedSample: matched.slice(0, 8).map(id => id + ' -> ' + buyerByOrderId[id]),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== Post-Order キャンセル検索の確認（デバッグ用） =====
app.get('/api/ebay/cancellations', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 120;
    const map = await ebayApi.getCancellations(days);
    if (!map) return res.json({ ok: false, error: 'Post-Order APIから取得できません（スコープ不足の可能性）' });
    res.json({ ok: true, count: Object.keys(map).length, cancellations: map });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 単一注文の詳細を確認（デバッグ用） =====
app.get('/api/ebay/order-detail/:orderId', async (req, res) => {
  try {
    const d = await ebayApi.getOrderDetail(req.params.orderId);
    if (!d) return res.json({ ok: false, error: '取得できません（レスポンスなし）' });
    res.json({
      ok: true,
      orderId: d.orderId,
      cancelStatus: d.cancelStatus || null,
      hasCancelRequests: !!(d.cancelStatus && d.cancelStatus.cancelRequests && d.cancelStatus.cancelRequests.length),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 同期履歴（取りこぼし監査用） =====
app.get('/api/ebay/synclog', (req, res) => {
  res.json({
    ok: true,
    lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
    minutesAgo: lastSyncAt ? Math.round((Date.now()-lastSyncAt)/60000) : null,
    log: syncLog,
  });
});

// ===== 同期判定の診断 =====
app.get('/api/ebay/diag2', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 3;
    const ebayMsgs = await ebayApi.getMessagesForApp(days);
    const sheetTs = await getSheetConvTimestamps();
    const rows = ebayMsgs.slice(0, 12).map(em => {
      const cid = String(em.conversationId);
      const savedTs = sheetTs[cid] || 0;
      const newTs = new Date(em.timestamp || 0).getTime() || 0;
      return {
        buyer: em.buyer,
        cid,
        apiTs: em.timestamp,
        sheetTs: savedTs ? new Date(savedTs).toISOString() : '(なし)',
        newer: newTs > savedTs,
      };
    });
    res.json({
      ok: true,
      apiCount: ebayMsgs.length,
      sheetConvCount: Object.keys(sheetTs).length,
      sample: rows,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 会話取得の診断 =====
app.get('/api/ebay/diag', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 3;
    const convs = await ebayApi.getConversations(days, 500);
    const list = (convs && convs.conversations) || [];
    res.json({
      ok: true,
      days,
      total: convs ? convs.total : null,
      fetched: list.length,
      apiCalls: convs ? convs._calls : null,
      complete: (convs && convs.total) ? (list.length >= convs.total) : null,
      buyers: list.map(c => {
        const lm = c.latestMessage || {};
        return (lm.senderUsername || '?') + ' @' + (lm.createdDate || '').substring(5, 16);
      }),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 特定バイヤーの会話を生データで確認（デバッグ用） =====
app.get('/api/ebay/conv/:buyer', async (req, res) => {
  try {
    const target = String(req.params.buyer).toLowerCase();
    const convs = await ebayApi.getConversations(60, 50);
    const list = (convs && convs.conversations) || [];
    const hit = list.find(c => {
      const lm = c.latestMessage || {};
      return String(lm.senderUsername || '').toLowerCase() === target
          || String(lm.recipientUsername || '').toLowerCase() === target;
    });
    if (!hit) return res.json({ ok: false, error: 'その会話が見つかりません', checked: list.length });

    const detail = await ebayApi.getConversation(hit.conversationId);
    const msgs = (detail && detail.messages) || [];
    res.json({
      ok: true,
      conversationId: hit.conversationId,
      SELF: process.env.EBAY_SELLER_USERNAME || 'samuraisoul142142',
      latestMessageSender: (hit.latestMessage || {}).senderUsername,
      messages: msgs.map(m => ({
        sender: m.senderUsername,
        recipient: m.recipientUsername,
        date: m.createdDate,
        body: (m.messageBody || '').substring(0, 60),
      })),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 注文の生データ（納税者番号の調査用） =====
app.get('/api/ebay/order-full/:orderId', async (req, res) => {
  try {
    const d = await ebayApi.getOrderDetail(req.params.orderId);
    if (!d) return res.json({ ok: false, error: '取得できません' });
    const li = (d.lineItems && d.lineItems[0]) || {};
    res.json({
      ok: true,
      orderId: d.orderId,
      buyerKeys: d.buyer ? Object.keys(d.buyer) : [],
      buyer: d.buyer || null,
      lineItemKeys: Object.keys(li),
      ebayCollectAndRemitTax: d.ebayCollectAndRemitTax || null,
      lineItemTaxes: li.ebayCollectAndRemitTaxes || li.taxes || null,
      topKeys: Object.keys(d),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 注文番号・バイヤー名で注文を検索（メッセージがなくても引ける） =====
app.get('/api/ebay/order-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: false, error: '検索語が必要です' });
    const lq = q.toLowerCase();

    // 1) 注文番号として直接引く
    let order = null;
    if (buyerByOrderId[q]) {
      const lu = buyerByOrderId[q];
      order = orderByBuyer[lu] || null;
      // 個別取得で詳細を得る（納税者番号・キャンセル情報のため）
      const detail = await ebayApi.getOrderDetail(q).catch(() => null);
      if (detail) order = detail;
    }

    // 2) バイヤー名として引く
    if (!order && orderByBuyer[lq]) {
      const o = orderByBuyer[lq];
      const detail = await ebayApi.getOrderDetail(o.orderId).catch(() => null);
      order = detail || o;
    }

    // 3) 直接 getOrder を試す（キャッシュにない注文番号）
    if (!order && /^[0-9-]{8,}$/.test(q)) {
      order = await ebayApi.getOrderDetail(q).catch(() => null);
    }

    if (!order) return res.json({ ok: false, error: '該当する注文が見つかりません' });

    const formatted = ebayApi.formatOrder(order);
    if (formatted && !formatted.taxId) {
      const tid = await ebayApi.getBuyerTaxId(order.legacyOrderId || order.orderId).catch(() => null);
      if (tid) formatted.taxId = tid;
    }
    const buyerName = (order.buyer && order.buyer.username) || '';
    const li = (order.lineItems && order.lineItems[0]) || {};

    res.json({
      ok: true,
      buyer: buyerName,
      order: formatted,
      item: {
        itemId: li.legacyItemId || '',
        title: li.title || '',
        sku: li.sku || '',
        quantity: li.quantity || 1,
      },
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 出品情報を更新（数量・価格） =====
app.post('/api/ebay/update-listing', async (req, res) => {
  try {
    const { itemId, quantity, price, title, sku } = req.body;
    if (!itemId) return res.json({ ok: false, error: 'itemIdが必要です' });
    const r = await ebayApi.reviseItem(itemId, { quantity, price, title, sku });
    if (r && r.ok) {
      ebayApi.clearItemCache(itemId);
      return res.json({ ok: true });
    }
    res.json({ ok: false, error: (r && r.error) || '更新できませんでした' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 商品情報を取得 =====
app.get('/api/ebay/item/:itemId', async (req, res) => {
  try {
    const info = await ebayApi.getItemInfo(req.params.itemId);
    res.json({ ok: !!info, item: info });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 注文の生データ確認（デバッグ用） =====
app.get('/api/ebay/order-raw/:username', async (req, res) => {
  try {
    const lu = String(req.params.username).toLowerCase();
    const o = orderByBuyer[lu];
    if (!o) return res.json({ ok: false, error: 'この購入者の注文がキャッシュにありません', cached: Object.keys(orderByBuyer).length });
    const li = (o.lineItems && o.lineItems[0]) || {};
    res.json({
      ok: true,
      topLevelKeys: Object.keys(o),
      lineItemKeys: Object.keys(li),
      cancelStatus: o.cancelStatus || null,
      pricingSummary: o.pricingSummary || null,
      lineItemTaxes: (o.lineItems||[]).map(function(li){return {taxes: li.taxes, ecart: li.ebayCollectAndRemitTaxes};}),
      orderEcart: o.ebayCollectAndRemitTax,
      marketplaceId: o.marketplaceId || '(なし)',
      listingMarketplaceId: li.listingMarketplaceId || '(なし)',
      purchaseMarketplaceId: li.purchaseMarketplaceId || '(なし)',
      sellerId: o.sellerId || '',
      orderId: o.orderId,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== 公開プロフィールの取得テスト（デバッグ用） =====
app.get('/api/ebay/location/:username', async (req, res) => {
  try {
    const r = await ebayApi.debugBuyerLocation(req.params.username);
    res.json(r);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== GetUser テスト（デバッグ用） =====
app.get('/api/ebay/user/:username', async (req, res) => {
  try {
    const info = await ebayApi.getUserInfo(req.params.username, req.query.fresh === '1');
    res.json({ ok: !!info, user: info });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== SKU単体テスト（デバッグ用） =====
app.get('/api/ebay/sku/:itemId', async (req, res) => {
  try {
    const sku = await ebayApi.getSellerSku(req.params.itemId);
    res.json({ ok: true, itemId: req.params.itemId, sku: sku || '(空)' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== バイヤー情報を取得 =====
app.get('/api/ebay/buyer/:username', async (req, res) => {
  try {
    const debug = req.query.debug === '1';
    const uname = req.params.username;
    // 軽いGetUserを先に取得。注文情報は購入者リストに載っている場合のみ取りに行く
    const user = await ebayApi.getUserInfo(uname).catch(() => null);
    const lu = String(uname).toLowerCase();
    let order = null;
    const cachedOrder = orderByBuyer[lu];
    if (cachedOrder) {
      // 一覧取得ではキャンセル詳細が空なので、個別取得で補完する
      let full = cachedOrder;
      const cs = cachedOrder.cancelStatus || {};
      const hasCancel = cs.cancelState && cs.cancelState !== 'NONE_REQUESTED'
        && !(cs.cancelRequests && cs.cancelRequests.length);
      // 納税者番号（CPF/RFC等）も getOrder でしか返らないので常に個別取得する
      const needDetail = hasCancel || !cachedOrder.buyer || !cachedOrder.buyer.taxIdentifier;
      if (needDetail) {
        const detail = await ebayApi.getOrderDetail(cachedOrder.orderId).catch(e => {
          console.error('[buyer] getOrderDetail failed:', e && e.message);
          return null;
        });
        if (detail) {
          full = detail;
          console.log('[buyer] detail fetched for', cachedOrder.orderId,
            'requests=', (detail.cancelStatus && detail.cancelStatus.cancelRequests || []).length);
        } else {
          console.log('[buyer] detail NOT fetched for', cachedOrder.orderId);
        }
      }
      order = ebayApi.formatOrder(full);

      // 納税者番号（CPF/RFC等）はTrading APIからしか取れない
      if (order && !order.taxId && (full.legacyOrderId || full.orderId)) {
        try {
          const tid = await ebayApi.getBuyerTaxId(full.legacyOrderId || full.orderId);
          if (tid) order.taxId = tid;
        } catch (e) { console.error('[buyer] taxId:', e.message); }
      }

      // Fulfillment APIで日時が取れない場合はPost-Order APIから補完
      if (order && order.cancelState && order.cancelState !== 'NONE_REQUESTED' && !order.cancelRequestedAt) {
        try {
          const cmap = await ebayApi.getCancellations(120);
          const legacyId = cachedOrder.legacyOrderId || cachedOrder.orderId;
          const hit = cmap && (cmap[legacyId] || cmap[cachedOrder.orderId]);
          if (hit) {
            order.cancelRequestedAt = hit.requestedAt || order.cancelRequestedAt;
            order.cancelClosedAt = hit.closedAt || order.cancelClosedAt;
            order.cancelReason = hit.reason || order.cancelReason;
            order.cancelReasonLabel = ebayApi.cancelReasonLabel(hit.reason || order.cancelReason);
            order.cancelRequestedBy = hit.initiator || order.cancelRequestedBy;
            order.cancelId = hit.cancelId || '';
            // Post-Orderの状態の方が正確なので上書きする
            if (hit.state) {
              const ci = ebayApi.cancelInfo(hit.state);
              order.cancelState = hit.state;
              order.cancelLabel = ci.label;
              order.cancelShort = ci.short;
              order.cancelKind = ci.kind;
            }
          }
        } catch (e) { console.error('[buyer] cancellation search:', e.message); }
      }
    } else if (debug) {
      order = await ebayApi.getBuyerOrderInfo(uname, 180, debug).catch(() => null);
    }
    // 注: 未購入バイヤーの居住国はeBay APIでは取得不可（プライバシー保護のため非開示）
    const common = user ? {
      feedbackScore: user.feedbackScore || null,
      positivePercent: user.positivePercent || null,
      photoUrl: user.photoUrl || '',
      registrationDate: user.registrationDate || '',
      userCountry: user.country || '',
      userCountryLabel: user.country ? ebayApi.countryName(user.country) : '',
      ebaySite: user.site || '',
    } : {};
    const buyer = order
      ? Object.assign({}, order, common, { purchased: true })
      : (user ? Object.assign({ purchased: false }, common) : null);
    res.json({ ok: !!buyer, buyer, debug: debug ? ebayApi.getLastOrderDebug() : undefined });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== eBay API: 生レスポンス確認（デバッグ用） =====
app.get('/api/ebay/raw', async (req, res) => {
  try {
    const convs = await ebayApi.getConversations(2, 2);
    const list = (convs && convs.conversations) || [];
    let detail = null;
    if (list.length > 0) {
      detail = await ebayApi.getConversation(list[0].conversationId);
    }
    res.json({
      ok: true,
      conversationsTopLevelKeys: convs ? Object.keys(convs) : [],
      firstConversation: list[0] || null,
      conversationDetailKeys: detail ? Object.keys(detail) : [],
      conversationDetail: detail || null,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== eBay API: メッセージ同期 =====
app.get('/api/ebay/sync', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const force = req.query.force === '1';   // 既存行も上書き更新する
    const ebayMsgs = await ebayApi.getMessagesForApp(days);
    let added = 0, updated = 0;

    // シート上の既存conversationIdを取得（メモリだけだと再起動後に重複する）
    const sheetTs = await getSheetConvTimestamps();
    const syncErrors = [];

    for (const em of ebayMsgs) {
      const cid = String(em.conversationId);
      const savedTs = sheetTs[cid] || 0;
      const newTs = new Date(em.timestamp || 0).getTime() || 0;
      const existsInSheet = savedTs > 0;

      if (existsInSheet) {
        // 既にシートにある会話。新しいメッセージが来ていれば行を更新する
        if (force || newTs > savedTs) {
          try {
            const isNew = newTs > savedTs;
            const r = await refreshRowInSheet(em, isNew);
            updated++;
            if (r === false) console.log('[sync] refreshRow no-op for', cid);
            // メモリ側も更新
            const mm = messages.find(m => m.conversationId === cid);
            if (mm) {
              mm.msg = em.body || mm.msg;
              mm.message = em.body || mm.message;
              mm.msgFrom = em.msgFrom || 'buyer';
              mm.history = em.history || mm.history;
              mm.timestamp = em.timestamp || mm.timestamp;
              if (newTs > savedTs) {
                mm.read = false;
                mm.unreadCount = (mm.unreadCount||0)+1;
                if (stateStore[mm.id]) { stateStore[mm.id].read = false; stateStore[mm.id].readAt = null; }
              }
            }
          } catch (e) { console.error('refreshRow error:', e.message); syncErrors.push(e.message); }
        }
        continue;
      }

      // 商品名・画像を取得（失敗しても続行）
      let itemInfo = null;
      if (em.itemId) {
        try { itemInfo = await ebayApi.getItemInfo(em.itemId); } catch (e) {}
      }
      const msg = {
        id: Date.now() + added,
        conversationId: em.conversationId,
        buyer: em.buyer || 'unknown',
        subject: em.subject || '',
        message: em.body || '',
        msg: em.body || '',
        msgFrom: em.msgFrom || 'buyer',
        history: em.history || [],
        item: itemInfo ? itemInfo.title : extractItemFromSubject(em.subject || ''),
        orderId: '',
        itemId: em.itemId || '',
        imgUrl: itemInfo ? itemInfo.imageUrl : '',
        sold: false,
        timestamp: em.timestamp || new Date().toISOString(),
        read: em.read || false, starred: false, replied: false, memo: '',
        replyHistory: [], reply: '', status: 'pending'
      };
      messages.unshift(msg);
      added++;
      appendToSheet(msg).catch(e => console.error('appendToSheet error:', e.message));
    }
    if (messages.length > 300) messages = messages.slice(0, 300);
    lastSyncAt = Date.now();
    recordSync({ type: 'manual', days, fetched: ebayMsgs.length, added, refreshed: updated });
    res.json({ ok: true, fetched: ebayMsgs.length, added, updated, errors: syncErrors.slice(0,5) });
  } catch (e) {
    console.error('eBay sync error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ===== eBay API: 返信を送信 =====
app.post('/api/ebay/reply', async (req, res) => {
  try {
    const { conversationId, messageText, itemId, buyer } = req.body;
    if (!messageText) return res.json({ ok: false, error: 'messageText が必要です' });
    const result = await ebayApi.sendMessage({
      conversationId, otherPartyUsername: buyer, messageText, itemId
    });

    // 送信した返信をシートのhistoryに追記して永続化（結果を待って返す）
    let saved = null;
    if (conversationId) {
      try {
        saved = await updateHistoryInSheet(conversationId, {
          from: 'me',
          text: messageText,
          time: new Date().toISOString(),
        });
      } catch (e) {
        console.error('updateHistoryInSheet error:', e.message);
        saved = { ok: false, error: e.message };
      }
    } else {
      saved = { ok: false, error: 'conversationIdなし' };
    }

    res.json({ ok: true, result, saved });
  } catch (e) {
    console.error('eBay reply error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// ===== シート上の既存conversationId一覧を取得 =====
// conversationId -> シート上の最新timestamp を返す
async function getSheetConvTimestamps() {
  const map = {};
  try {
    const sheetId = process.env.SHEET_ID;
    if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return map;
    const token = await getGoogleAccessToken();
    const sheetName = encodeURIComponent('シート1');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A1:O10000`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json();
    const rows = d.values || [];
    if (rows.length <= 1) return map;
    const h = rows[0];
    const iConv = h.indexOf('conversationId');
    const iTs = h.indexOf('timestamp');
    if (iConv < 0 || iTs < 0) return map;
    for (let i = 1; i < rows.length; i++) {
      const cid = rows[i][iConv];
      if (!cid) continue;
      const ts = new Date(rows[i][iTs] || 0).getTime() || 0;
      if (!map[cid] || ts > map[cid]) map[cid] = ts;
    }
  } catch (e) {
    console.error('getSheetConvTimestamps error:', e.message);
  }
  return map;
}

async function getSheetConversationIds() {
  const ids = new Set();
  try {
    const sheetId = process.env.SHEET_ID;
    if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return ids;
    const token = await getGoogleAccessToken();
    const sheetName = encodeURIComponent('シート1');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A1:M1`;
    const hr = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const hd = await hr.json();
    const headers = (hd.values && hd.values[0]) || [];
    const convIdx = headers.indexOf('conversationId');
    if (convIdx < 0) return ids;

    const col = String.fromCharCode(65 + convIdx);
    const cUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!${col}2:${col}10000`;
    const cr = await fetch(cUrl, { headers: { 'Authorization': `Bearer ${token}` } });
    const cd = await cr.json();
    (cd.values || []).forEach(row => { if (row[0]) ids.add(String(row[0])); });
  } catch (e) {
    console.error('getSheetConversationIds error:', e.message);
  }
  return ids;
}

// ===== シートの既存行を最新のeBayデータで更新 =====
async function refreshRowInSheet(em, forceUnread) {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return;
  const token = await getGoogleAccessToken();
  const sheetName = encodeURIComponent('シート1');

  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A:O`;
  const r = await fetch(getUrl, { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await r.json();
  const rows = data.values || [];
  if (rows.length <= 1) return;

  const headers = rows[0];
  const convIdx = headers.indexOf('conversationId');
  if (convIdx < 0) return;

  let targetRow = -1;
  for (let i = rows.length - 1; i >= 1; i--) {
    if ((rows[i][convIdx] || '') === String(em.conversationId)) { targetRow = i; break; }
  }
  if (targetRow < 0) return;

  const rowNum = targetRow + 1;
  const existing = rows[targetRow];
  const get = (name) => { const k = headers.indexOf(name); return k >= 0 ? (existing[k] || '') : ''; };

  // A〜M列を再構築（ユーザー操作分 read/starred/replied/memo は維持）
  const values = [[
    em.timestamp,
    em.buyer,
    em.subject || get('subject'),
    em.body || '',
    get('item'),
    get('orderId'),
    em.itemId || get('itemId'),
    forceUnread ? 'false' : (get('read') || 'false'),   // 新着があれば未読に戻す
    get('starred') || 'false',
    get('replied') || 'false',
    get('memo'),
    em.conversationId,
    JSON.stringify(em.history || []),
    em.msgFrom || 'buyer',
    (em.imgUrl || get('imgUrl') || ''),
  ]];

  const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A${rowNum}:O${rowNum}?valueInputOption=RAW`;
  await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
}

// ===== シートのhistory列に返信を追記 =====
async function updateHistoryInSheet(conversationId, entry) {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return;
  const token = await getGoogleAccessToken();
  const sheetName = encodeURIComponent('シート1');

  // 全行取得して該当行を探す
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!A:O`;
  const r = await fetch(getUrl, { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await r.json();
  const rows = data.values || [];
  if (rows.length <= 1) return;

  const headers = rows[0];
  const convIdx = headers.indexOf('conversationId');
  const histIdx = headers.indexOf('history');
  const repIdx = headers.indexOf('replied');
  if (convIdx < 0 || histIdx < 0) {
    return { ok: false, error: 'conversationId/history列が見つかりません', headers };
  }

  // 該当行（最新のもの）を探す
  let targetRow = -1;
  for (let i = rows.length - 1; i >= 1; i--) {
    if ((rows[i][convIdx] || '') === String(conversationId)) { targetRow = i; break; }
  }
  if (targetRow < 0) {
    return { ok: false, error: 'conversationId ' + conversationId + ' の行が見つかりません', totalRows: rows.length };
  }

  let hist = [];
  try { hist = JSON.parse(rows[targetRow][histIdx] || '[]'); } catch (e) { hist = []; }
  hist.push(entry);

  const rowNum = targetRow + 1;
  const histCol = String.fromCharCode(65 + histIdx);
  const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!${histCol}${rowNum}?valueInputOption=RAW`;
  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[JSON.stringify(hist)]] }),
  });
  if (!putRes.ok) {
    const errTxt = await putRes.text();
    return { ok: false, error: 'シート書込失敗 ' + putRes.status + ': ' + errTxt.substring(0, 200) };
  }

  // replied も true に
  if (repIdx >= 0) {
    const repCol = String.fromCharCode(65 + repIdx);
    const repUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}!${repCol}${rowNum}?valueInputOption=RAW`;
    await fetch(repUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['true']] }),
    });
  }
  console.log('history updated in sheet:', conversationId, 'row', rowNum);
  return { ok: true, row: rowNum, historyCount: hist.length };
}

// ===== eBay Notification: リアルタイム通知受信 =====
app.post('/api/ebay/notification', async (req, res) => {
  // eBayのチャレンジコード検証（初回登録時）
  if (req.query.challenge_code) {
    const crypto = require('crypto');
    const token = process.env.EBAY_VERIFICATION_TOKEN || '';
    const endpoint = process.env.EBAY_NOTIFICATION_ENDPOINT || '';
    const hash = crypto.createHash('sha256');
    hash.update(req.query.challenge_code + token + endpoint);
    return res.json({ challengeResponse: hash.digest('hex') });
  }

  // 通知を受信 → メッセージを同期
  console.log('eBay notification received:', JSON.stringify(req.body).substring(0, 200));
  try {
    const ebayMsgs = await ebayApi.getMessagesForApp(1);
    for (const em of ebayMsgs) {
      const exists = messages.find(m => m.conversationId === em.conversationId);
      if (exists) continue;
      const msg = {
        id: Date.now(),
        conversationId: em.conversationId,
        buyer: em.buyer || 'unknown',
        subject: em.subject || '',
        message: em.body || '',
        msg: em.body || '',
        history: em.history || [],
        msgFrom: em.msgFrom || 'buyer',
        item: em.itemId ? '' : extractItemFromSubject(em.subject || ''),
        orderId: '', itemId: em.itemId || '', imgUrl: '',
        sold: false,
        timestamp: em.timestamp || new Date().toISOString(),
        read: false, starred: false, replied: false, memo: '',
        replyHistory: [], reply: '', status: 'pending'
      };
      messages.unshift(msg);
      appendToSheet(msg).catch(e => console.error(e.message));
    }
  } catch (e) {
    console.error('notification sync error:', e.message);
  }
  res.sendStatus(200);
});

// eBay Notification GET（チャレンジ検証用）
app.get('/api/ebay/notification', (req, res) => {
  if (req.query.challenge_code) {
    const crypto = require('crypto');
    const token = process.env.EBAY_VERIFICATION_TOKEN || '';
    const endpoint = process.env.EBAY_NOTIFICATION_ENDPOINT || '';
    const hash = crypto.createHash('sha256');
    hash.update(req.query.challenge_code + token + endpoint);
    return res.json({ challengeResponse: hash.digest('hex') });
  }
  res.sendStatus(200);
});


app.post('/api/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== インメモリ状態ストア（フォールバック用） =====
let stateStore = {};
let messages = [];

// ===== Zapier Webhook受信 =====
app.post('/webhook', async (req, res) => {
  const data = req.body;
  const rawBody = data.message || '';
  const fromName = data.buyer || '';
  const parsed = parseEbayEmail(rawBody, fromName);
  const msg = {
    id: Date.now(),
    buyer: parsed.buyer || 'unknown',
    subject: data.subject || '',
    message: rawBody,
    msg: parsed.newMsg,
    history: parsed.history,
    item: parsed.itemName || extractItemFromSubject(data.subject || '') || ((data.item && data.item.toLowerCase() !== 'item') ? data.item : ''),
    orderId: parsed.orderId || data.orderId || '',
    itemId: parsed.itemId || data.itemId || '',
    imgUrl: data.imgUrl || '',
    sold: parsed.sold || !!data.sold,
    timestamp: new Date().toISOString(),
    read: false, starred: false, replied: false, memo: '',
    replyHistory: [], reply: '', status: 'pending'
  };
  messages.unshift(msg);
  if (messages.length > 200) messages = messages.slice(0, 200);

  // スプレッドシートにも書き込む（Renderスリープ対策）
  appendToSheet(msg).catch(e => console.error('appendToSheet error:', e.message));

  console.log(`Webhook received: buyer=${msg.buyer}, subject=${(data.subject||'').substring(0,50)}`);
  res.json({ ok: true });
});

// ===== Sheetsに新規行を追加 =====
async function appendToSheet(msg) {
  try {
    const sheetId = process.env.SHEET_ID;
    if (!sheetId || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return;
    const token = await getGoogleAccessToken();
    const sheetName = encodeURIComponent('シート1');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: [[
          msg.timestamp,
          msg.buyer,
          msg.subject,
          msg.message,
          msg.item || '',
          msg.orderId || '',
          msg.itemId || '',
          msg.read ? 'true' : 'false',   // read
          'false',                        // starred
          'false',                        // replied
          '',                             // memo
          msg.conversationId || '',       // L列: conversationId
          JSON.stringify(msg.history || []), // M列: history(JSON)
          msg.msgFrom || 'buyer',         // N列: msgFrom
          msg.imgUrl || ''                // O列: imgUrl
        ]]
      }),
    });
    console.log(`Sheet append ok: ${msg.buyer}`);
  } catch (e) {
    console.error('appendToSheet error:', e.message);
  }
}

// ===== 状態更新API（スプレッドシートに永続保存） =====
app.post('/api/state', async (req, res) => {
  const { id, read, starred, replied, memo } = req.body;
  if (!id) return res.json({ ok: false });

  // メモリに保存（既読にした時刻も記録＝その後の新着で未読に戻せる）
  const prev = stateStore[id] || {};
  stateStore[id] = {
    read, starred, replied, memo,
    readAt: read ? new Date().toISOString() : (prev.readAt || null),
  };

  // messagesにも反映
  const msg = messages.find(m => m.id == id);
  if (msg) {
    if (read !== undefined) msg.read = read;
    if (starred !== undefined) msg.starred = starred;
    if (replied !== undefined) msg.replied = replied;
    if (memo !== undefined) msg.memo = memo;
  }

  // スプレッドシートに書き込み（非同期・エラーがあっても続行）
  writeStateToSheet(Number(id), read, starred, replied, memo).catch(e => console.error(e));

  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  res.json(stateStore);
});

// ===== Googleスプレッドシートからメッセージ取得 =====
app.get('/api/messages', async (req, res) => {
  try {
    // 自動同期がシート書き込み中なら少し待つ（並び順の乱れ防止）
    let waited = 0;
    while (autoSyncRunning && waited < 5000) {
      await new Promise(r => setTimeout(r, 250));
      waited += 250;
    }
    // 購入者リストはバックグラウンドで更新（待たない）
    refreshBuyerSet().catch(() => {});
    const sheetId = process.env.SHEET_ID;
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!sheetId || !apiKey) return res.json({ messages });

    const sheetName = encodeURIComponent('シート1');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}?key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error('Sheet error:', data.error);
      return res.json({ messages, error: data.error });
    }

    const rows = data.values || [];
    if (rows.length <= 1) return res.json({ messages });

    const headers = rows[0];
    const rawMessages = rows.slice(1).map((row, i) => {
      const obj = {};
      headers.forEach((h, j) => { obj[h] = row[j] || ''; });
      const rawBody = obj.message || '';
      const fromName = obj.buyer || '';
      const convId = obj.conversationId || '';
      // eBay API由来（conversationIdあり）はメール解析をスキップ
      const isFromApi = !!convId;
      let parsed;
      if (isFromApi) {
        let hist = [];
        try { hist = obj.history ? JSON.parse(obj.history) : []; } catch (e) { hist = []; }
        parsed = {
          buyer: fromName,
          newMsg: rawBody,
          history: hist,
          itemName: '',
          orderId: '',
          itemId: obj.itemId || '',
          sold: false,
        };
      } else {
        parsed = parseEbayEmail(rawBody, fromName);
      }
      const id = i + 1;
      const savedState = stateStore[id] || {};

      // シートの値を優先、なければメモリのstateStore
      const readVal = savedState.read !== undefined ? savedState.read : (obj.read === 'true');
      const starredVal = savedState.starred !== undefined ? savedState.starred : (obj.starred === 'true');
      const repliedVal = savedState.replied !== undefined ? savedState.replied : (obj.replied === 'true');
      const memoVal = savedState.memo !== undefined ? savedState.memo : (obj.memo || '');

      return {
        id,
        conversationId: convId,
        msgFrom: obj.msgFrom || 'buyer',
        buyer: parsed.buyer || 'unknown',
        subject: obj.subject || '',
        message: rawBody,
        msg: parsed.newMsg,
        history: parsed.history,
        item: (obj.item && obj.item.toLowerCase() !== 'item') ? obj.item : (parsed.itemName || extractItemFromSubject(obj.subject || '')),
        orderId: parsed.orderId || obj.orderId || '',
        itemId: parsed.itemId || obj.itemId || '',
        imgUrl: obj.imgUrl || '',
        sold: parsed.sold || obj.sold === 'true' || obj.sold === true,
        timestamp: obj.timestamp || '',
        read: readVal,
        starred: starredVal,
        replied: repliedVal,
        memo: memoVal,
      };
    });

    // ===== 同じconversationIdの重複行を除去（最新1件のみ残す） =====
    const convSeen = {};
    const deduped = [];
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const r = rawMessages[i];
      const cid = r.conversationId;
      if (cid) {
        if (convSeen[cid]) continue;
        convSeen[cid] = true;
      }
      deduped.unshift(r);
    }
    rawMessages.length = 0;
    Array.prototype.push.apply(rawMessages, deduped);

    // ===== 同一バイヤーをスレッドにまとめる =====
    const threadMap = {};
    rawMessages.forEach(m => {
      // バイヤー名を正規化（前後空白・不可視文字・引用符を除去）
      const key = String(m.buyer || '').toLowerCase().replace(/[\s\u200b-\u200f"'`]/g, '').trim();
      if (!key) return;
      if (!threadMap[key]) {
        threadMap[key] = { ...m, threadMessages: [m], sold: m.sold };
      } else {
        const thread = threadMap[key];
        thread.threadMessages.push(m);
        if (new Date(m.timestamp) > new Date(thread.timestamp)) {
          thread.timestamp = m.timestamp;
          thread.id = m.id;
          // 最新メールの既読状態を使う（古いメールの未読で上書きしない）
          thread.read = m.read;
        }
        if (m.orderId) thread.orderId = m.orderId;
        if (m.itemId) thread.itemId = m.itemId;
        if (m.conversationId) thread.conversationId = m.conversationId;
        if (m.msgFrom) thread.msgFrom = m.msgFrom;
        if (m.item) thread.item = m.item;
        if (m.starred) thread.starred = true;
        if (m.replied) thread.replied = true;
        if (m.memo) thread.memo = m.memo;
        if (m.sold) thread.sold = true;
      }
    });

    const threads = Object.values(threadMap).map(thread => {
      const sorted = thread.threadMessages.slice().sort((a, b) => {
        const ta = new Date(a.timestamp || 0).getTime() || 0;
        const tb = new Date(b.timestamp || 0).getTime() || 0;
        return ta - tb;
      });
      const latest = sorted[sorted.length - 1];
      // 同じconversationIdの行は1回だけ使う（同一データの二重読み込みを防ぐ）
      const usedConv = new Set();
      const uniqueRows = sorted.filter(m => {
        const cid = m.conversationId || '';
        if (!cid) return true;             // 旧Gmailデータ等はそのまま
        if (usedConv.has(cid)) return false;
        usedConv.add(cid);
        return true;
      });

      const allHistory = [];
      uniqueRows.forEach((m, idx) => {
        if (m.history && m.history.length > 0) {
          m.history.forEach(h => allHistory.push({ from: h.from, text: h.text, time: h.time || m.timestamp }));
        }
        // 最後の行のmsgは latest として別途表示されるので、それ以外だけ履歴に入れる
        if (idx < uniqueRows.length - 1 && m.msg) {
          allHistory.push({ from: m.msgFrom === 'me' ? 'me' : 'buyer', text: m.msg, time: m.timestamp });
        }
      });
      // 【重要】メッセージは一切間引かない。eBayにあるものは全てそのまま表示する。
      // （同じ文面を2回送ることは実際にあり、勝手に消すと事実と食い違う）
      // 空テキストだけ除外し、時系列に並べる。
      const dedupedHistory = allHistory
        .filter(h => h.text)
        .sort((a, b) => {
          const ta = new Date(a.time || 0).getTime() || 0;
          const tb = new Date(b.time || 0).getTime() || 0;
          return ta - tb;
        });
      return {
        id: latest.id,
        conversationId: thread.conversationId || latest.conversationId || '',
        buyer: thread.buyer,
        subject: latest.subject,
        msg: latest.msg,
        msgFrom: latest.msgFrom || 'buyer',
        history: dedupedHistory,
        item: (function(){
          const iid = thread.itemId || latest.itemId;
          const cached = iid ? ebayApi.getCachedItem(iid) : null;
          if (cached && cached.title) return cached.title;
          return thread.item || latest.item;
        })(),
        orderId: thread.orderId || latest.orderId,
        itemId: thread.itemId || latest.itemId,
        imgUrl: (function(){
          // APIキャッシュに新しい画像があればそれを優先（シートの古い値を上書き）
          const iid = thread.itemId || latest.itemId;
          const cached = iid ? ebayApi.getCachedItem(iid) : null;
          if (cached && cached.imageUrl) return cached.imageUrl;
          return thread.imgUrl || latest.imgUrl;
        })(),
        sold: thread.sold || latest.sold || buyerOrderSet.has(String(thread.buyer||'').toLowerCase()),
        cancel: cancelByBuyer[String(thread.buyer||'').toLowerCase()] || null,
        timestamp: latest.timestamp,
        read: thread.read,
        starred: thread.starred,
        replied: thread.replied,
        memo: thread.memo,
      };
    });

    // バイヤーからの最終受信日時を求める（自分の送信は並び順に影響させない）
    threads.forEach(t => {
      let last = 0;
      if (t.msgFrom !== 'me' && t.timestamp) {
        const v = new Date(t.timestamp).getTime();
        if (!isNaN(v)) last = v;
      }
      (t.history || []).forEach(h => {
        if (h.from === 'me') return;
        const v = new Date(h.time || 0).getTime();
        if (!isNaN(v) && v > last) last = v;
      });
      t.lastBuyerAt = last;               // 0 = バイヤーからの受信なし
      t.hasBuyerMsg = last > 0;

      // 未読件数の算出
      // 既読でも、状態を保存した時刻より後にバイヤーから届いていれば未読に戻す
      const savedAt = stateStore[t.id] && stateStore[t.id].readAt
        ? new Date(stateStore[t.id].readAt).getTime() : 0;
      if (t.read && savedAt > 0 && last > savedAt) {
        // 既読にした後に新着が来ている → 未読へ
        t.read = false;
      }
      if (t.read) {
        t.unreadCount = 0;
      } else {
        // 自分が最後に送信した時刻
        let lastMineAt = 0;
        (t.history || []).forEach(h => {
          if (h.from !== 'me') return;
          const v = new Date(h.time || 0).getTime();
          if (!isNaN(v) && v > lastMineAt) lastMineAt = v;
        });
        // その後に届いたバイヤーメッセージを数える
        let cnt = 0;
        (t.history || []).forEach(h => {
          if (h.from === 'me') return;
          const v = new Date(h.time || 0).getTime();
          if (!isNaN(v) && v > lastMineAt) cnt++;
        });
        // 最新メッセージ（m.msg）がバイヤーからなら加算
        if (t.msgFrom !== 'me' && t.timestamp) {
          const v = new Date(t.timestamp).getTime();
          if (!isNaN(v) && v > lastMineAt) cnt++;
        }
        t.unreadCount = cnt > 0 ? cnt : (t.hasBuyerMsg ? 1 : 0);
      }
    });

    threads.sort((a, b) => {
      // バイヤーからの受信がない会話は下にまとめる
      if (a.hasBuyerMsg !== b.hasBuyerMsg) return a.hasBuyerMsg ? -1 : 1;
      if (a.hasBuyerMsg) return b.lastBuyerAt - a.lastBuyerAt;
      // 受信なし同士は自分の送信日時で
      const ta = new Date(a.timestamp || 0).getTime() || 0;
      const tb = new Date(b.timestamp || 0).getTime() || 0;
      return tb - ta;
    });

    // 表示上位の商品情報を先読みしてキャッシュに載せる（次回以降が正確になる）
    const topIds = [];
    for (const t of threads.slice(0, 40)) {
      if (t.itemId && !ebayApi.getCachedItem(t.itemId)) topIds.push(t.itemId);
    }
    if (topIds.length > 0) {
      // 同時実行数を絞って順次取得（APIレート制限とレスポンス遅延を防ぐ）
      (async () => {
        for (const id of topIds.slice(0, 15)) {
          await ebayApi.getItemInfo(id).catch(() => null);
        }
      })().catch(() => {});
    }
    res.json({ messages: threads });
  } catch (e) {
    console.error('Error:', e.message);
    res.json({ messages });
  }
});

// ===== 最新メッセージ取得（ポーリング用） =====
app.get('/latest', (req, res) => {
  if (messages.length > 0) res.json({ message: messages[0] });
  else res.json({ message: null });
});

const PORT = process.env.PORT || 3000;
// ===== eBayから定期自動同期（3分ごと） =====
async function autoSyncFromEbay() {
  if (autoSyncRunning) return;
  autoSyncRunning = true;
  try {
    // 差分同期：前回同期からの経過時間だけを取りに行く（最低1日・最大7日）
    const elapsedDays = lastSyncAt
      ? (Date.now() - lastSyncAt) / 86400000
      : 3;
    const days = Math.min(Math.max(Math.ceil(elapsedDays) + 1, 1), 7);

    const ebayMsgs = await ebayApi.getMessagesForApp(days);
    const sheetTs = await getSheetConvTimestamps();
    let added = 0, refreshed = 0;
    for (const em of ebayMsgs) {
      const cid = String(em.conversationId);
      const savedTs = sheetTs[cid] || 0;
      const newTs = new Date(em.timestamp || 0).getTime() || 0;

      if (savedTs > 0) {
        // 既存会話に新着があれば更新して未読に
        if (newTs > savedTs) {
          try {
            await refreshRowInSheet(em, true);
            refreshed++;
            const mm = messages.find(m => m.conversationId === cid);
            if (mm) {
              mm.msg = em.body || mm.msg;
              mm.message = em.body || mm.message;
              mm.msgFrom = em.msgFrom || 'buyer';
              mm.history = em.history || mm.history;
              mm.timestamp = em.timestamp || mm.timestamp;
              mm.read = false;
              mm.unreadCount = (mm.unreadCount || 0) + 1;
              if (stateStore[mm.id]) { stateStore[mm.id].read = false; stateStore[mm.id].readAt = null; }
            }
          } catch (e) { console.error('[autoSync] refresh:', e.message); }
        }
        continue;
      }
      // 商品名・画像を取得（失敗しても続行）
      let itemInfo = null;
      if (em.itemId) {
        try { itemInfo = await ebayApi.getItemInfo(em.itemId); } catch (e) {}
      }
      let aInfo = null;
      if (em.itemId) { try { aInfo = await ebayApi.getItemInfo(em.itemId); } catch (e) {} }
      const msg = {
        id: Date.now() + added,
        conversationId: em.conversationId,
        buyer: em.buyer || 'unknown',
        subject: em.subject || '',
        message: em.body || '',
        msg: em.body || '',
        msgFrom: em.msgFrom || 'buyer',
        history: em.history || [],
        item: aInfo ? aInfo.title : extractItemFromSubject(em.subject || ''),
        orderId: '', itemId: em.itemId || '', imgUrl: aInfo ? aInfo.imageUrl : '',
        sold: false,
        timestamp: em.timestamp || new Date().toISOString(),
        read: em.read || false, starred: false, replied: false, memo: '',
        replyHistory: [], reply: '', status: 'pending'
      };
      messages.unshift(msg);
      added++;
      await appendToSheet(msg).catch(e => console.error('appendToSheet:', e.message));
    }
    if (messages.length > 300) messages = messages.slice(0, 300);
    lastSyncAt = Date.now();
    recordSync({ type: 'auto', days, fetched: ebayMsgs.length, added, refreshed });
    if (added > 0 || refreshed > 0) console.log(`[autoSync] ${days}日分 / 新規${added}件 / 更新${refreshed}件`);
  } catch (e) {
    console.error('[autoSync] error:', e.message);
  } finally {
    autoSyncRunning = false;
  }
}

// 起動時：シート上の最新メッセージ時刻を「最終同期時刻」として復元
// （再起動しても取りこぼしが起きないように）
setTimeout(async () => {
  try {
    const map = await getSheetConvTimestamps();
    let latest = 0;
    Object.values(map).forEach(t => { if (t > latest) latest = t; });
    if (latest > 0) {
      lastSyncAt = latest;
      console.log('[startup] 最終同期時刻を復元:', new Date(latest).toISOString());
    }
  } catch (e) { console.error('[startup] restore lastSyncAt:', e.message); }
}, 2000);

// 起動直後に購入者リストを先読み（SOLD表示のタイムラグ解消）
setTimeout(() => { refreshBuyerSet().catch(() => {}); }, 1000);
// 10分ごとに購入者リストを更新
setInterval(() => { refreshBuyerSet().catch(() => {}); }, 10 * 60 * 1000);

// 3分ごとに実行
setInterval(autoSyncFromEbay, 2 * 60 * 1000);
// 起動30秒後に初回実行
setTimeout(autoSyncFromEbay, 30 * 1000);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
