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
  const SELF = String(process.env.EBAY_SELLER_USERNAME || 'samuraisoul142142').toLowerCase();
  const isSelf = (u) => String(u || '').toLowerCase() === SELF;

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const cid = c.conversationId;
    const lm = c.latestMessage || {};

    // 相手のユーザー名を判定
    let buyer = lm.senderUsername;
    if (!buyer || isSelf(buyer)) buyer = lm.recipientUsername;
    if (!buyer || isSelf(buyer)) buyer = 'unknown';
    const isBuyer = (u) => {
      const s = String(u || '').toLowerCase();
      if (!s) return false;
      if (s === SELF) return false;
      // 会話相手と一致すればバイヤー
      return s === String(buyer || '').toLowerCase() || !isSelf(u);
    };

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
          if (!isSelf(sorted[k].senderUsername)) { lastBuyerIdx = k; break; }
        }
        if (lastBuyerIdx >= 0) {
          body = sorted[lastBuyerIdx].messageBody || body;
          ts = sorted[lastBuyerIdx].createdDate || ts;
          // それ以外すべて（自分の返信を含む）を history に。自分の返信が後にあってもここに残る
          history = sorted.filter(function(_, k) { return k !== lastBuyerIdx; }).map(function(mm) {
            return {
              from: isSelf(mm.senderUsername) ? 'me' : 'buyer',
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
              from: isSelf(mm.senderUsername) ? 'me' : 'buyer',
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
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.inventory',
    'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
    'https://api.ebay.com/oauth/api_scope/sell.account',
    'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
    'https://api.ebay.com/oauth/api_scope/commerce.feedback',
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


// ===== 国コード→日本語国名 =====
const COUNTRY_NAMES = {
  US:'アメリカ', CA:'カナダ', GB:'イギリス', AU:'オーストラリア', DE:'ドイツ', FR:'フランス',
  IT:'イタリア', ES:'スペイン', NL:'オランダ', BE:'ベルギー', CH:'スイス', AT:'オーストリア',
  SE:'スウェーデン', NO:'ノルウェー', DK:'デンマーク', FI:'フィンランド', PL:'ポーランド',
  PT:'ポルトガル', IE:'アイルランド', CZ:'チェコ', GR:'ギリシャ', HU:'ハンガリー',
  RO:'ルーマニア', BG:'ブルガリア', HR:'クロアチア', SK:'スロバキア', SI:'スロベニア',
  EE:'エストニア', LV:'ラトビア', LT:'リトアニア', LU:'ルクセンブルク', MT:'マルタ',
  CY:'キプロス', IS:'アイスランド',
  JP:'日本', CN:'中国', KR:'韓国', TW:'台湾', HK:'香港', SG:'シンガポール',
  MY:'マレーシア', TH:'タイ', ID:'インドネシア', PH:'フィリピン', VN:'ベトナム', IN:'インド',
  NZ:'ニュージーランド',
  BR:'ブラジル', MX:'メキシコ', AR:'アルゼンチン', CL:'チリ', CO:'コロンビア', PE:'ペルー',
  VE:'ベネズエラ', EC:'エクアドル', UY:'ウルグアイ', PY:'パラグアイ', BO:'ボリビア',
  CR:'コスタリカ', PA:'パナマ', GT:'グアテマラ', DO:'ドミニカ共和国', PR:'プエルトリコ',
  RU:'ロシア', UA:'ウクライナ', TR:'トルコ', IL:'イスラエル', SA:'サウジアラビア',
  AE:'アラブ首長国連邦', QA:'カタール', KW:'クウェート', ZA:'南アフリカ', EG:'エジプト',
  NG:'ナイジェリア', KE:'ケニア', MA:'モロッコ',
};
function countryName(code) {
  if (!code) return '';
  const c = String(code).toUpperCase();
  return COUNTRY_NAMES[c] ? COUNTRY_NAMES[c] + '（' + c + '）' : c;
}

// ===== バイヤーの公開情報（フィードバック数・国）を取得 =====
const buyerPublicCache = {};
async function getBuyerPublicInfo(username) {
  if (!username) return null;
  const key = String(username).toLowerCase();
  if (buyerPublicCache[key] !== undefined) return buyerPublicCache[key];
  try {
    const token = await getAccessToken();
    // Feedback API でバイヤーの評価サマリを取得
    const url = 'https://api.ebay.com/commerce/feedback/v1/feedback_summary?user_id=' + encodeURIComponent(username);
    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('getBuyerPublicInfo ' + res.status + ':', t.substring(0, 150));
      buyerPublicCache[key] = null;
      return null;
    }
    const d = await res.json();
    const info = {
      feedbackScore: d.feedbackScore !== undefined ? d.feedbackScore : null,
      positivePercent: d.positiveFeedbackPercentage || null,
    };
    buyerPublicCache[key] = info;
    return info;
  } catch (e) {
    console.error('getBuyerPublicInfo error:', e.message);
    buyerPublicCache[key] = null;
    return null;
  }
}

// ===== Browse API: Item IDから商品情報を取得 =====
const itemCache = {};
function getCachedItem(itemId) {
  if (!itemId) return null;
  return itemCache[String(itemId)] || null;
}
async function getItemInfo(legacyItemId) {
  if (!legacyItemId) return null;
  const key = String(legacyItemId);
  if (itemCache[key] !== undefined) return itemCache[key];

  try {
    const token = await getAccessToken();
    const url = 'https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=' + encodeURIComponent(key);
    const res = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('getItemInfo ' + res.status + ':', t.substring(0, 150));
      itemCache[key] = null;
      return null;
    }
    const d = await res.json();
    const info = {
      title: d.title || '',
      imageUrl: (d.image && d.image.imageUrl) || '',
      price: d.price ? (d.price.value + ' ' + d.price.currency) : '',
      sku: d.sku || '',
      condition: d.condition || '',
      itemWebUrl: d.itemWebUrl || '',
    };
    // Browse APIはSKUを返さないので、セラー向けAPIから補完
    if (!info.sku) {
      try {
        const sku = await getSellerSku(key);
        if (sku) info.sku = sku;
      } catch (e) { /* ignore */ }
    }
    itemCache[key] = info;
    return info;
  } catch (e) {
    console.error('getItemInfo error:', e.message);
    itemCache[key] = null;
    return null;
  }
}

// ===== Trading API GetItem でセラー自身のSKUを取得 =====
const skuCache = {};
async function getSellerSku(itemId) {
  if (!itemId) return '';
  const key = String(itemId);
  if (skuCache[key] !== undefined) return skuCache[key];
  try {
    const token = await getAccessToken();
    const xml = '<?xml version="1.0" encoding="utf-8"?>'
      + '<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
      + '<ItemID>' + key + '</ItemID>'
      + '<DetailLevel>ReturnAll</DetailLevel>'
      + '</GetItemRequest>';
    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
        'X-EBAY-API-CALL-NAME': 'GetItem',
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
      body: xml,
    });
    const t = await res.text();
    const m = t.match(/<SKU>([\s\S]*?)<\/SKU>/);
    const sku = m ? m[1].trim() : '';
    skuCache[key] = sku;
    if (!sku) console.log('[getSellerSku] SKUなし item=' + key + ' resp=' + t.substring(0, 200));
    return sku;
  } catch (e) {
    console.error('getSellerSku error:', e.message);
    skuCache[key] = '';
    return '';
  }
}

// ===== Trading API GetUser でバイヤー公開情報を取得 =====
const userInfoCache = {};
async function getUserInfo(username, skipCache) {
  if (!username) return null;
  const key = String(username).toLowerCase();
  if (!skipCache && userInfoCache[key] !== undefined) return userInfoCache[key];
  try {
    const token = await getAccessToken();
    // DetailLevel を指定すると ItemID が必須になるため付けない（基本情報のみ取得）
    const xml = '<?xml version="1.0" encoding="utf-8"?>'
      + '<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
      + '<UserID>' + username + '</UserID>'
      + '</GetUserRequest>';
    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
        'X-EBAY-API-CALL-NAME': 'GetUser',
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
      body: xml,
    });
    const t = await res.text();
    const pick = (tag) => {
      const m = t.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
      return m ? m[1].trim() : '';
    };
    const info = {
      feedbackScore: pick('FeedbackScore') || '',
      positivePercent: pick('PositiveFeedbackPercent') || '',
      country: pick('Country') || '',
      registrationDate: pick('RegistrationDate') || '',
      photoUrl: pick('PhotoDisplayURL') || '',
      status: pick('Status') || '',
      _ack: pick('Ack') || '',
      _err: pick('LongMessage') || pick('ShortMessage') || '',
      _httpStatus: res.status,
      _raw: (!pick('FeedbackScore') && !pick('Country')) ? t.substring(0, 600) : undefined,
    };
    userInfoCache[key] = info;
    return info;
  } catch (e) {
    console.error('getUserInfo error:', e.message);
    userInfoCache[key] = null;
    return null;
  }
}

// ===== Fulfillment API: バイヤーの注文情報（住所など）を取得 =====
const orderCache = {};
let lastOrderDebug = null;
function getLastOrderDebug() { return lastOrderDebug; }

async function getBuyerOrderInfo(buyerUsername, daysBack, debug) {
  if (!buyerUsername) return null;
  const key = String(buyerUsername).toLowerCase();
  if (!debug && orderCache[key] !== undefined) return orderCache[key];

  try {
    const token = await getAccessToken();
    const days = daysBack || 120;
    const from = new Date(Date.now() - days * 86400000).toISOString();
    const filter = encodeURIComponent('creationdate:[' + from + '..]');

    // ページングで全件取得（1回200件・最大2000件まで）
    const orders = [];
    let offset = 0;
    let pages = 0;
    let lastStatus = 0;
    while (pages < 10) {
      const url = 'https://api.ebay.com/sell/fulfillment/v1/order?filter=' + filter
        + '&limit=200&offset=' + offset;
      const res = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
      });
      lastStatus = res.status;
      if (!res.ok) {
        const t = await res.text();
        lastOrderDebug = { status: res.status, body: t.substring(0, 400), url: url };
        console.error('getBuyerOrderInfo ' + res.status + ':', t.substring(0, 200));
        if (orders.length === 0) { orderCache[key] = null; return null; }
        break;
      }
      const pd = await res.json();
      const batch = pd.orders || [];
      orders.push(...batch);
      pages++;
      // 目的のバイヤーが見つかったら打ち切り
      if (batch.some(o => ((o.buyer && o.buyer.username) || '').toLowerCase() === key)) break;
      if (batch.length < 200) break;
      offset += 200;
    }

    lastOrderDebug = {
      status: lastStatus,
      totalOrders: orders.length,
      pages: pages,
      lookingFor: key,
      found: orders.some(o => ((o.buyer && o.buyer.username) || '').toLowerCase() === key),
    };
    const mine = orders.filter(o => (o.buyer && o.buyer.username || '').toLowerCase() === key);
    if (mine.length === 0) { orderCache[key] = null; return null; }

    mine.sort((a, b) => new Date(b.creationDate || 0) - new Date(a.creationDate || 0));
    const o = mine[0];
    const ship = (o.fulfillmentStartInstructions && o.fulfillmentStartInstructions[0]
      && o.fulfillmentStartInstructions[0].shippingStep
      && o.fulfillmentStartInstructions[0].shippingStep.shipTo) || {};
    const addr = ship.contactAddress || {};
    const li = (o.lineItems && o.lineItems[0]) || {};

    const info = {
      orderId: o.orderId || '',
      orderDate: o.creationDate || '',
      salesRecordNo: (li.legacyReference && li.legacyReference.legacyItemId) || '',
      name: ship.fullName || '',
      email: ship.email || '',
      phone: ship.primaryPhone && ship.primaryPhone.phoneNumber || '',
      addressLine1: addr.addressLine1 || '',
      addressLine2: addr.addressLine2 || '',
      city: addr.city || '',
      stateOrProvince: addr.stateOrProvince || '',
      postalCode: addr.postalCode || '',
      country: addr.countryCode || '',
      countryLabel: countryName(addr.countryCode || ''),
      shipByDate: li.lineItemFulfillmentInstructions && li.lineItemFulfillmentInstructions.shipByDate || '',
      orderCount: mine.length,
      total: o.pricingSummary && o.pricingSummary.total
        ? (o.pricingSummary.total.value + ' ' + o.pricingSummary.total.currency) : '',
    };
    orderCache[key] = info;
    return info;
  } catch (e) {
    console.error('getBuyerOrderInfo error:', e.message);
    orderCache[key] = null;
    return null;
  }
}

module.exports = {
  getItemInfo: getItemInfo,
  getCachedItem: getCachedItem,
  getSellerSku: getSellerSku,
  getBuyerOrderInfo: getBuyerOrderInfo,
  getBuyerPublicInfo: getBuyerPublicInfo,
  getUserInfo: getUserInfo,
  countryName: countryName,
  getLastOrderDebug: getLastOrderDebug,
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
