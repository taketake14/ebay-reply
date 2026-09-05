// ===== eBay Message API (REST) 連携 =====
const fetch = require('node-fetch');

const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_MSG_BASE = 'https://api.ebay.com/commerce/message/v1';

let lastHttp = null;
function getLastHttp() { return lastHttp; }

function getCreds() {
  return {
    appId: process.env.EBAY_APP_ID,
    certId: process.env.EBAY_CERT_ID,
    refreshToken: process.env.EBAY_REFRESH_TOKEN,
    accessToken: process.env.EBAY_ACCESS_TOKEN,
  };
}

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  const c = getCreds();

  // ACCESS_TOKEN が設定されていれば優先して使う（切り分け用）
  if (c.accessToken) {
    return c.accessToken;
  }

  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  if (!c.refreshToken) {
    throw new Error('EBAY_REFRESH_TOKEN も EBAY_ACCESS_TOKEN も未設定です');
  }
  if (!c.appId || !c.certId) {
    throw new Error('EBAY_APP_ID または EBAY_CERT_ID が未設定です');
  }

  const basic = Buffer.from(c.appId + ':' + c.certId).toString('base64');

  // scope を指定せずにリフレッシュ（トークン発行時のスコープをそのまま継承）
  const res = await fetch(EBAY_OAUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + basic,
    },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(c.refreshToken),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('トークン取得失敗 (' + res.status + '): appIdLen=' + (c.appId||'').length + ' certIdLen=' + (c.certId||'').length + ' resp=' + JSON.stringify(data).substring(0, 300));
  }

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 7200) * 1000;
  return cachedToken;
}

async function callMessageAPI(pathAndQuery, options) {
  options = options || {};
  const token = await getAccessToken();
  const url = EBAY_MSG_BASE + pathAndQuery;

  const headers = {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (options.headers) Object.assign(headers, options.headers);

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  lastHttp = { status: res.status, statusText: res.statusText, url: url, bodyLen: text.length };

  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) {}

  if (!res.ok) {
    const errMsg = (json && json.errors && json.errors[0])
      ? (json.errors[0].errorId + ': ' + json.errors[0].message)
      : text.substring(0, 300);
    throw new Error('eBay API ' + res.status + ': ' + errMsg);
  }
  return json;
}

async function getConversations(daysBack, limit) {
  daysBack = daysBack || 7;
  limit = limit || 50;
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const q = new URLSearchParams({
    conversation_type: 'FROM_MEMBERS',
    limit: String(limit),
    offset: '0',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
  });
  return await callMessageAPI('/conversation?' + q.toString());
}

async function getConversation(conversationId) {
  const q = new URLSearchParams({
    conversation_type: 'FROM_MEMBERS',
    limit: '50',
  });
  return await callMessageAPI('/conversation/' + encodeURIComponent(conversationId) + '?' + q.toString());
}

async function sendMessage(opts) {
  const body = { messageText: opts.messageText };
  if (opts.conversationId) body.conversationId = opts.conversationId;
  else if (opts.otherPartyUsername) body.otherPartyUsername = opts.otherPartyUsername;
  if (opts.itemId) body.reference = { referenceType: 'LISTING', referenceId: String(opts.itemId) };
  return await callMessageAPI('/send_message', { method: 'POST', body: body });
}

async function updateConversationRead(conversationId, isRead) {
  return await callMessageAPI('/update_conversation', {
    method: 'POST',
    body: {
      conversationId: conversationId,
      conversationType: 'FROM_MEMBERS',
      read: !!isRead,
    },
  });
}

async function getMessagesForApp(daysBack) {
  daysBack = daysBack || 7;
  const convs = await getConversations(daysBack, 50);
  const list = (convs && convs.conversations) || [];
  const out = [];
  const SELF = process.env.EBAY_SELLER_USERNAME || 'samuraisoul142142';

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const cid = c.conversationId;
    const lm = c.latestMessage || {};

    // 相手のユーザー名を判定
    let buyer = lm.senderUsername;
    if (!buyer || buyer === SELF) buyer = lm.recipientUsername;
    if (!buyer || buyer === SELF) buyer = 'unknown';

    let detail = null;
    try {
      detail = await getConversation(cid);
    } catch (e) {
      console.error('getConversation error:', cid, e.message);
    }

    let history = [];
    let body = lm.messageBody || '';
    let ts = lm.createdDate || c.createdDate || new Date().toISOString();
    let subject = '';
    let msgFrom = 'buyer';

    if (detail) {
      subject = detail.conversationTitle || '';
      const msgs = detail.messages || [];
      if (msgs.length > 0) {
        const sorted = msgs.slice().sort(function(a, b) {
          return new Date(a.createdDate || 0) - new Date(b.createdDate || 0);
        });
        // 「新着メッセージ」= 相手(buyer)からの最後のメッセージ
        let lastBuyerIdx = -1;
        for (let k = sorted.length - 1; k >= 0; k--) {
          if (sorted[k].senderUsername !== SELF) { lastBuyerIdx = k; break; }
        }
        if (lastBuyerIdx >= 0) {
          body = sorted[lastBuyerIdx].messageBody || body;
          ts = sorted[lastBuyerIdx].createdDate || ts;
          // それ以外すべて（自分の返信を含む）を history に。自分の返信が後にあってもここに残る
          history = sorted.filter(function(_, k) { return k !== lastBuyerIdx; }).map(function(mm) {
            return {
              from: (mm.senderUsername === SELF) ? 'me' : 'buyer',
              text: mm.messageBody || '',
              time: mm.createdDate || '',
            };
          });
        } else {
          // 相手からのメッセージが無い（自分だけ）ケース
          const latest = sorted[sorted.length - 1];
          body = latest.messageBody || body;
          ts = latest.createdDate || ts;
          msgFrom = 'me';
          history = sorted.slice(0, -1).map(function(mm) {
            return {
              from: (mm.senderUsername === SELF) ? 'me' : 'buyer',
              text: mm.messageBody || '',
              time: mm.createdDate || '',
            };
          });
        }
      }
    }

    out.push({
      conversationId: cid,
      buyer: buyer,
      subject: subject,
      body: body,
      msgFrom: msgFrom,
      history: history,
      itemId: c.referenceId || '',
      timestamp: ts,
      read: (c.unreadCount || 0) === 0,
    });
  }
  return out;
}

async function testConnection() {
  const c = getCreds();
  const diag = {
    appId: c.appId ? c.appId.substring(0, 22) + '...' : 'MISSING',
    certId: c.certId ? 'SET(' + c.certId.length + ')' : 'MISSING',
    refreshToken: c.refreshToken ? 'SET(' + c.refreshToken.length + ')' : 'MISSING',
    accessToken: c.accessToken ? 'SET(' + c.accessToken.length + ')' : 'MISSING',
  };
  try {
    const convs = await getConversations(7, 5);
    return {
      ok: true,
      conversationCount: (convs && convs.conversations) ? convs.conversations.length : 0,
      total: convs ? convs.total : null,
      http: getLastHttp(),
      diag: diag,
    };
  } catch (e) {
    return { ok: false, error: e.message, http: getLastHttp(), diag: diag };
  }
}

// ===== OAuth: 認証URLを生成 =====
function getAuthUrl() {
  const c = getCreds();
  const ruName = process.env.EBAY_RUNAME;
  if (!c.appId) throw new Error('EBAY_APP_ID が未設定です');
  if (!ruName) throw new Error('EBAY_RUNAME が未設定です');
  const scopes = [
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/commerce.message',
  ].join(' ');
  const q = new URLSearchParams({
    client_id: c.appId,
    redirect_uri: ruName,
    response_type: 'code',
    scope: scopes,
  });
  return 'https://auth.ebay.com/oauth2/authorize?' + q.toString();
}

// ===== OAuth: 認証コードをトークンに交換 =====
async function exchangeCodeForTokens(code) {
  const c = getCreds();
  const ruName = process.env.EBAY_RUNAME;
  if (!c.appId || !c.certId) throw new Error('EBAY_APP_ID / EBAY_CERT_ID が未設定です');
  if (!ruName) throw new Error('EBAY_RUNAME が未設定です');

  const basic = Buffer.from(c.appId + ':' + c.certId).toString('base64');
  const res = await fetch(EBAY_OAUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + basic,
    },
    body: 'grant_type=authorization_code&code=' + encodeURIComponent(code) + '&redirect_uri=' + encodeURIComponent(ruName),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    throw new Error('コード交換失敗 (' + res.status + '): ' + JSON.stringify(data).substring(0, 400));
  }
  // メモリにも保持（再デプロイまで有効）
  if (data.access_token) {
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in || 7200) * 1000;
  }
  return data;
}

module.exports = {
  getAuthUrl: getAuthUrl,
  exchangeCodeForTokens: exchangeCodeForTokens,
  getConversations: getConversations,
  getConversation: getConversation,
  getMessagesForApp: getMessagesForApp,
  sendMessage: sendMessage,
  updateConversationRead: updateConversationRead,
  testConnection: testConnection,
  getAccessToken: getAccessToken,
  getLastHttp: getLastHttp,
};
