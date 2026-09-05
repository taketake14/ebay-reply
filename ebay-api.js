// ===== eBay Message API (REST) 連携 =====
const fetch = require('node-fetch');

const EBAY_OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_MSG_BASE = 'https://api.ebay.com/sell/message/v1';

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

  if (c.accessToken && !c.refreshToken) {
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
  const scopes = 'https://api.ebay.com/oauth/api_scope/commerce.message';

  const res = await fetch(EBAY_OAUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + basic,
    },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(c.refreshToken) + '&scope=' + encodeURIComponent(scopes),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('トークン取得失敗 (' + res.status + '): ' + JSON.stringify(data).substring(0, 300));
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

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const cid = c.conversationId;
    let detail = null;
    try {
      detail = await getConversation(cid);
    } catch (e) {
      console.error('getConversation error:', cid, e.message);
      continue;
    }
    const msgs = (detail && detail.messages) || [];
    if (msgs.length === 0) continue;

    const sorted = msgs.slice().sort(function(a, b) {
      return new Date(a.creationDate || 0) - new Date(b.creationDate || 0);
    });
    const latest = sorted[sorted.length - 1];

    const history = sorted.slice(0, -1).map(function(m) {
      return {
        from: (m.sender === c.otherPartyUsername) ? 'buyer' : 'me',
        text: m.messageText || '',
        time: m.creationDate || '',
      };
    });

    out.push({
      conversationId: cid,
      buyer: c.otherPartyUsername || c.otherPartyUserId || 'unknown',
      subject: c.subject || '',
      body: latest.messageText || '',
      history: history,
      itemId: (c.reference && c.reference.referenceId) || '',
      timestamp: latest.creationDate || c.lastMessageDate || new Date().toISOString(),
      read: c.read === true,
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

module.exports = {
  getConversations: getConversations,
  getConversation: getConversation,
  getMessagesForApp: getMessagesForApp,
  sendMessage: sendMessage,
  updateConversationRead: updateConversationRead,
  testConnection: testConnection,
  getAccessToken: getAccessToken,
  getLastHttp: getLastHttp,
};
