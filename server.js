const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== eBayメール解析関数 =====
function parseEbayEmail(rawBody, fromName) {
  if (!rawBody) return { buyer: fromName || 'unknown', newMsg: '', history: [], itemId: '', orderId: '' };

  // 1. バイヤー名：「eBay - username」→「username」
  let buyer = fromName || '';
  const buyerFromName = buyer.match(/eBay\s*-\s*(.+)/);
  if (buyerFromName) {
    buyer = buyerFromName[1].trim();
  } else {
    // メール本文からも試みる
    const buyerFromBody = rawBody.match(/New message from:\s*\n+\s*(\S+)/);
    if (buyerFromBody) buyer = buyerFromBody[1].trim();
  }

  // 2. 最新メッセージ抽出（"New message from: ... (N)\n\nメッセージ\n\n-->" の間）
  let newMsg = '';
  const newMsgMatch = rawBody.match(/New message from:[\s\S]*?\([^)]*\)\s*\n+([\s\S]*?)\n+-->/);
  if (newMsgMatch) {
    newMsg = newMsgMatch[1].trim();
  }
  // フォールバック：「New message: TEXT」形式
  if (!newMsg) {
    const fallback = rawBody.match(/New message:\s*(.+)/);
    if (fallback) newMsg = fallback[1].trim();
  }

  // 3. 会話履歴抽出（重複除去・古い順）
  const history = [];
  const seen = new Set();
  // "Dear X,\n\nTEXT\n\n- sender" ブロックを全部取得
  const blockRe = /Dear [^,\n]+,\s*\n+([\s\S]*?)\n+- (\S+)(?:\n|$)/g;
  let match;
  while ((match = blockRe.exec(rawBody)) !== null) {
    const text = match[1].trim();
    const sender = match[2].trim();
    const key = text.substring(0, 60);
    if (seen.has(key)) continue;
    if (text === newMsg) continue;
    seen.add(key);
    const from = sender.toLowerCase() === buyer.toLowerCase() ? 'buyer' : 'me';
    history.push({ from, text });
  }
  history.reverse(); // 古い順に並べる

  // 4. Item ID / Order番号 をメール本文から自動抽出
  const itemIdMatch = rawBody.match(/Item ID:\s*(\d+)/);
  const orderMatch = rawBody.match(/Order number:\s*([\d-]+)/);

  return {
    buyer,
    newMsg,
    history,
    itemId: itemIdMatch ? itemIdMatch[1] : '',
    orderId: orderMatch ? orderMatch[1] : '',
  };
}

// ===== Claude API プロキシ =====
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

// ===== Zapier Webhook受信 =====
let messages = [];
app.post('/webhook', (req, res) => {
  const data = req.body;
  const rawBody = data.message || '';
  const fromName = data.buyer || '';

  // メールをパース
  const parsed = parseEbayEmail(rawBody, fromName);

  const msg = {
    id: Date.now(),
    buyer: parsed.buyer || 'unknown',
    subject: data.subject || '',
    message: rawBody,          // 生のメール本文（保存用）
    msg: parsed.newMsg,        // 抽出済み最新メッセージ
    history: parsed.history,   // 会話履歴
    item: data.item || '',
    orderId: parsed.orderId || data.orderId || '',
    itemId: parsed.itemId || data.itemId || '',
    imgUrl: data.imgUrl || '',
    sold: !!data.sold,
    timestamp: new Date().toISOString(),
    read: false,
    starred: false,
    replied: false,
    memo: '',
    replyHistory: [],
    reply: '',
    status: 'pending'
  };
  messages.unshift(msg);
  if (messages.length > 200) messages = messages.slice(0, 200);
  res.json({ ok: true });
});

// ===== Googleスプレッドシートからメッセージ取得 =====
app.get('/api/messages', async (req, res) => {
  try {
    const sheetId = process.env.SHEET_ID;
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!sheetId || !apiKey) {
      return res.json({ messages });
    }
    const sheetName = encodeURIComponent('シート1');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}?key=${apiKey}`;
    console.log('Fetching:', url);
    const response = await fetch(url);
    const data = await response.json();
    console.log('Sheet response:', JSON.stringify(data).substring(0, 200));

    if (data.error) {
      console.error('Sheet error:', data.error);
      return res.json({ messages, error: data.error });
    }

    const rows = data.values || [];
    if (rows.length <= 1) return res.json({ messages });

    const headers = rows[0];
    const sheetMessages = rows.slice(1).reverse().map((row, i) => {
      const obj = {};
      headers.forEach((h, j) => { obj[h] = row[j] || ''; });

      const rawBody = obj.message || '';
      const fromName = obj.buyer || '';

      // メールをパース
      const parsed = parseEbayEmail(rawBody, fromName);

      return {
        id: rows.length - i,
        buyer: parsed.buyer || 'unknown',
        subject: obj.subject || '',
        message: rawBody,
        msg: parsed.newMsg,
        history: parsed.history,
        item: obj.item || '',
        orderId: parsed.orderId || obj.orderId || '',
        itemId: parsed.itemId || obj.itemId || '',
        imgUrl: obj.imgUrl || '',
        sold: obj.sold === 'true' || obj.sold === true,
        timestamp: obj.timestamp || '',
        read: false,
        starred: false,
        replied: false,
        memo: '',
        replyHistory: [],
        reply: '',
        status: 'pending'
      };
    });
    res.json({ messages: sheetMessages });
  } catch (e) {
    console.error('Error:', e.message);
    res.json({ messages });
  }
});

// ===== 最新メッセージ取得（ポーリング用） =====
app.get('/latest', (req, res) => {
  if (messages.length > 0) {
    res.json({ message: messages[0] });
  } else {
    res.json({ message: null });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
