const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const ebayApi = require('./ebay-api');
const app = express();
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
    const ebayMsgs = await ebayApi.getMessagesForApp(days);
    let added = 0;
    for (const em of ebayMsgs) {
      const exists = messages.find(m => m.conversationId === em.conversationId);
      if (exists) continue;

      const msg = {
        id: Date.now() + added,
        conversationId: em.conversationId,
        buyer: em.buyer || 'unknown',
        subject: em.subject || '',
        message: em.body || '',
        msg: em.body || '',
        history: em.history || [],
        item: extractItemFromSubject(em.subject || ''),
        orderId: '',
        itemId: em.itemId || '',
        imgUrl: '',
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
    res.json({ ok: true, fetched: ebayMsgs.length, added });
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
    res.json({ ok: true, result });
  } catch (e) {
    console.error('eBay reply error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

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
        item: extractItemFromSubject(em.subject || ''),
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
          JSON.stringify(msg.history || []) // M列: history(JSON)
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

  // メモリに保存
  stateStore[id] = { read, starred, replied, memo };

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

    // ===== 同一バイヤーをスレッドにまとめる =====
    const threadMap = {};
    rawMessages.forEach(m => {
      const key = m.buyer.toLowerCase();
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
        if (m.item) thread.item = m.item;
        if (m.starred) thread.starred = true;
        if (m.replied) thread.replied = true;
        if (m.memo) thread.memo = m.memo;
        if (m.sold) thread.sold = true;
      }
    });

    const threads = Object.values(threadMap).map(thread => {
      const sorted = thread.threadMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const latest = sorted[sorted.length - 1];
      const allHistory = [];
      sorted.forEach((m, idx) => {
        if (m.history && m.history.length > 0) {
          m.history.forEach(h => allHistory.push({ from: h.from, text: h.text, time: h.time || m.timestamp }));
        }
        if (idx < sorted.length - 1 && m.msg) {
          allHistory.push({ from: 'buyer', text: m.msg, time: m.timestamp });
        }
      });
      const seenTexts = new Set();
      const dedupedHistory = allHistory.filter(h => {
        if (!h.text) return false;
        const k = h.text.substring(0, 50);
        if (seenTexts.has(k)) return false;
        seenTexts.add(k);
        return true;
      });
      return {
        id: latest.id,
        buyer: thread.buyer,
        subject: latest.subject,
        msg: latest.msg,
        msgFrom: 'buyer',
        history: dedupedHistory,
        item: thread.item || latest.item,
        orderId: thread.orderId || latest.orderId,
        itemId: thread.itemId || latest.itemId,
        imgUrl: thread.imgUrl || latest.imgUrl,
        sold: thread.sold || latest.sold,
        timestamp: latest.timestamp,
        read: thread.read,
        starred: thread.starred,
        replied: thread.replied,
        memo: thread.memo,
      };
    });

    threads.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
