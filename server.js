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
  if (!rawBody) return { buyer: fromName || 'unknown', newMsg: '', history: [], itemId: '', orderId: '', itemName: '' };

  // 1. バイヤー名：「eBay - username」→「username」
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

  // 3. 会話履歴抽出（送受信バグ修正版）
  // eBayメールの構造：
  //   "Dear samuraisoul142142,\n\nTEXT\n\n- buyer名"  → バイヤーが送信したメッセージ
  //   "Dear buyer名,\n\nTEXT\n\n- samuraisoul142142"  → 自分(Ken)が送信したメッセージ
  const SELLER = 'samuraisoul142142';
  const history = [];
  const seen = new Set();
  const blockRe = /Dear ([^,\n]+),\s*\n+([\s\S]*?)\n+- (\S+)(?:\n|$)/g;
  let match;
  while ((match = blockRe.exec(rawBody)) !== null) {
    const recipient = match[1].trim();   // "Dear ○○," の○○
    const text = match[2].trim();
    const sender = match[3].trim();      // "- ○○" の○○
    const key = text.substring(0, 60);
    if (seen.has(key)) continue;
    if (text === newMsg) continue;
    seen.add(key);
    // 送信者がSELLER（samuraisoul142142）ならfrom='me'、それ以外はfrom='buyer'
    const from = sender.toLowerCase() === SELLER.toLowerCase() ? 'me' : 'buyer';
    history.push({ from, text });
  }
  history.reverse(); // 古い順

  // 4. Item ID / Order番号
  const itemIdMatch = rawBody.match(/Item ID:\s*(\d+)/);
  const orderMatch = rawBody.match(/Order number:\s*([\d-]+)/);

  // 5. 商品名（メール本文の末尾付近に商品名が含まれる）
  // 例: "FUJITSU ScanSnap S1500 FI-S1500 Network Ready 599 g New\nOrder status: Paid"
  let itemName = '';
  const itemNameMatch = rawBody.match(/Item ID:\s*\d+\s*\n+Transaction ID:[\s\S]*?\n+([\s\S]*?)\n+Order status:/);
  if (!itemNameMatch) {
    // 別パターン: Item IDの前の行
    const lines = rawBody.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/Item ID:\s*\d+/) && i > 0) {
        // Item IDの直前の行が商品名のことが多い
        const candidate = lines[i - 1].trim();
        if (candidate && candidate.length > 3 && !candidate.match(/^(Dear|Hi|Hello|Thank|Best|Ken|View|Order|Email|We |©)/i)) {
          itemName = candidate;
          break;
        }
      }
    }
  } else {
    itemName = itemNameMatch[1].trim().split('\n')[0].trim();
  }

  // 5. SOLD判定：メール本文に「Order status: Paid」があれば購入済み
  const sold = /Order status:\s*(Paid|Shipped|Complete)/i.test(rawBody)
    || /Order number:/i.test(rawBody);

  return {
    buyer,
    newMsg,
    history,
    itemId: itemIdMatch ? itemIdMatch[1] : '',
    orderId: orderMatch ? orderMatch[1] : '',
    itemName,
    sold,
  };
}

// ===== Item IDからeBayサムネURL生成 =====
function getEbayThumbUrl(itemId) {
  if (!itemId) return '';
  // eBayの公開サムネURL（APIなし）
  return `https://i.ebayimg.com/thumbs/images/g/~~/s-l225.jpg`;
  // ※ 実際はitem固有URLはAPIが必要なため、Item IDリンクで代替
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

// ===== Googleスプレッドシート書き込み（状態保存） =====
async function saveStateToSheet(sheetId, apiKey, rowIndex, readVal, starredVal, repliedVal, memoVal) {
  // Google Sheets API v4 でセルを更新（OAuth不要のAPIキーでは書き込み不可のため、
  // 書き込みはRenderのメモリに保持し、読み込み時にシートから取得する方式）
  // ※ 書き込みにはサービスアカウントが必要。現状はメモリ保持のみ。
}

// ===== インメモリ状態ストア（F5対策：シートのIDをキーに状態を保持） =====
// Renderは再起動するとリセットされるが、シートから再読み込みする構造にする
let stateStore = {}; // { [sheetRowId]: { read, starred, replied, memo } }
let messages = [];

// ===== Zapier Webhook受信 =====
app.post('/webhook', (req, res) => {
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
    item: parsed.itemName || data.item || extractItemFromSubject(data.subject || ''),
    orderId: parsed.orderId || data.orderId || '',
    itemId: parsed.itemId || data.itemId || '',
    imgUrl: data.imgUrl || '',
    sold: parsed.sold || !!data.sold,
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

// 件名から商品名を抽出（多言語・多パターン対応）
function extractItemFromSubject(subject) {
  if (!subject) return '';
  // 英語①: "sent a message about ITEM NAME #ITEMID"
  let m = subject.match(/(?:about|regarding)\s+(.+?)(?:\s+#\d+|\s+New$|$)/i);
  if (m) return m[1].trim();
  // 英語②: "ending on DATE PDT - ITEM NAME"（質問系メール）
  m = subject.match(/PDT\s+-\s+(.+)/i);
  if (m) return m[1].trim();
  // イタリア語: "relativo a ITEM n° ID" or "#ID"
  m = subject.match(/relativo\s+a\s+(.+?)(?:\s+n[°o\s]*\d+|\s+#\d+|$)/i);
  if (m) return m[1].trim();
  // スペイン語: "sobre ITEM"
  m = subject.match(/sobre\s+(.+?)(?:\s+#\d+|$)/i);
  if (m) return m[1].trim();
  // 日本語・その他フォールバック: 件名末尾の #数字 を除去して返す
  m = subject.replace(/^Re:\s*/i, '').replace(/\s*#\d+\s*$/, '').trim();
  if (m && m.length > 5 && !m.match(/^(samuraisoul|eBay)/i)) return m;
  return '';
}

// ===== 状態更新API（F5対策） =====
app.post('/api/state', (req, res) => {
  const { id, read, starred, replied, memo } = req.body;
  if (!id) return res.json({ ok: false });
  stateStore[id] = { read, starred, replied, memo };

  // messagesにも反映
  const msg = messages.find(m => m.id == id);
  if (msg) {
    if (read !== undefined) msg.read = read;
    if (starred !== undefined) msg.starred = starred;
    if (replied !== undefined) msg.replied = replied;
    if (memo !== undefined) msg.memo = memo;
  }
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
    if (!sheetId || !apiKey) {
      return res.json({ messages });
    }
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
      const parsed = parseEbayEmail(rawBody, fromName);
      const id = i + 1;
      const savedState = stateStore[id] || {};
      return {
        id,
        buyer: parsed.buyer || 'unknown',
        subject: obj.subject || '',
        message: rawBody,
        msg: parsed.newMsg,
        history: parsed.history,
        item: parsed.itemName || obj.item || extractItemFromSubject(obj.subject || ''),
        orderId: parsed.orderId || obj.orderId || '',
        itemId: parsed.itemId || obj.itemId || '',
        imgUrl: obj.imgUrl || '',
        sold: parsed.sold || obj.sold === 'true' || obj.sold === true,
        timestamp: obj.timestamp || '',
        read: savedState.read !== undefined ? savedState.read : (obj.read === 'true'),
        starred: savedState.starred !== undefined ? savedState.starred : (obj.starred === 'true'),
        replied: savedState.replied !== undefined ? savedState.replied : (obj.replied === 'true'),
        memo: savedState.memo !== undefined ? savedState.memo : (obj.memo || ''),
      };
    });

    // ===== 同一バイヤーをスレッドにまとめる =====
    // 同じバイヤーのメッセージを1つにまとめ、古いものを履歴に、最新を本文に
    const threadMap = {};
    // 古い順（行番号順）に処理
    rawMessages.forEach(m => {
      const key = m.buyer.toLowerCase();
      if (!threadMap[key]) {
        threadMap[key] = { ...m, threadMessages: [m], sold: m.sold };
      } else {
        // 既存スレッドに追加
        const thread = threadMap[key];
        thread.threadMessages.push(m);
        // 最新のtimestampで更新
        if (m.timestamp > thread.timestamp) {
          thread.timestamp = m.timestamp;
          thread.id = m.id; // 最新のIDを使用
        }
        // orderId/itemIdも最新のものを優先
        if (m.orderId) thread.orderId = m.orderId;
        if (m.itemId) thread.itemId = m.itemId;
        if (m.item) thread.item = m.item;
        // 既読・フラグは1つでも未読ならまとめて未読
        if (!m.read) thread.read = false;
        if (m.starred) thread.starred = true;
        if (m.replied) thread.replied = true;
        // soldは1つでもSOLDなら全体をSOLD扱い
        if (m.sold) thread.sold = true;
      }
    });

    // スレッドを組み立て：全メッセージを時系列順に history + 最新msg にする
    const threads = Object.values(threadMap).map(thread => {
      const sorted = thread.threadMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const latest = sorted[sorted.length - 1];

      // 全メッセージの履歴を時系列で収集
      // 各メールには「過去のやり取り(history)」と「そのメールの最新メッセージ(msg)」がある
      // 全部をフラットにして重複除去する
      const allHistory = [];

      sorted.forEach((m, idx) => {
        // そのメールに含まれる過去の会話履歴を追加
        if (m.history && m.history.length > 0) {
          m.history.forEach(h => allHistory.push({
            from: h.from,
            text: h.text,
            time: h.time || m.timestamp
          }));
        }
        // 最新メール以外は、そのメールのmsgも履歴に追加
        // fromは「メールの送信者」= バイヤーからのメールなのでfrom:'buyer'が正しい
        // ただし最新メールのmsgは別途 msg フィールドとして返す
        if (idx < sorted.length - 1 && m.msg) {
          // このメールはZapierがバイヤーのメッセージを受信したもの → from:'buyer'
          allHistory.push({ from: 'buyer', text: m.msg, time: m.timestamp });
        }
      });

      // 重複除去（同じ内容が履歴とmsgに両方含まれることがあるため）
      const seenTexts = new Set();
      const dedupedHistory = allHistory.filter(h => {
        if (!h.text) return false;
        const k = h.text.substring(0, 50);
        if (seenTexts.has(k)) return false;
        seenTexts.add(k);
        return true;
      });

      // 最新メッセージの from を正しく判定
      // Zapierに届くメールは「バイヤーから受信したもの」なので最新msgはfrom:'buyer'
      // ただし latest.history の最後が自分の送信で終わっている場合はそれを表示
      let finalMsg = latest.msg;
      let finalFrom = 'buyer';

      // latest.historyの最後の要素が'me'かつlatest.msgより新しい場合
      // → 最後が自分の送信 = 自分が最後に返信済みの状態
      // この場合でもlatest.msgはバイヤーの直近メッセージとして表示する
      // （バイヤーからの最新問い合わせが常に表示されるべき）

      return {
        id: latest.id,
        buyer: thread.buyer,
        subject: latest.subject,
        msg: finalMsg,
        msgFrom: finalFrom,
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

    // 新着順にソート
    threads.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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
