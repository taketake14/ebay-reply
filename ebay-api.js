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

const PAGE_LIMIT = 50;   // eBay APIの1リクエスト上限

// 指定期間の会話を1回だけ取得
async function fetchConversationRange(startDate, endDate) {
  const q = new URLSearchParams({
    conversation_type: 'FROM_MEMBERS',
    limit: String(PAGE_LIMIT),
    start_time: startDate.toISOString(),
    end_time: endDate.toISOString(),
  });
  return await callMessageAPI('/conversation?' + q.toString());
}

// 期間を分割して取りこぼしなく取得する
// 1回50件の上限に達したら、その期間を半分に割って再取得する
async function getConversations(daysBack, want) {
  daysBack = daysBack || 7;
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const seen = {};        // conversationId -> conversation
  let totalReported = 0;
  let calls = 0;
  const MAX_CALLS = 24;   // 安全弁

  async function walk(s, e, depth) {
    if (calls >= MAX_CALLS) return;
    calls++;
    let res;
    try {
      res = await fetchConversationRange(s, e);
    } catch (err) {
      console.error('fetchConversationRange error:', err.message);
      return;
    }
    const batch = (res && res.conversations) || [];
    if (res && res.total) totalReported = Math.max(totalReported, res.total);
    batch.forEach(cv => { if (cv && cv.conversationId) seen[cv.conversationId] = cv; });

    // 上限まで埋まった＝取りこぼしの可能性がある。期間を半分にして再取得
    const spanMs = e.getTime() - s.getTime();
    if (batch.length >= PAGE_LIMIT && depth < 5 && spanMs > 60 * 60 * 1000) {
      const mid = new Date(s.getTime() + Math.floor(spanMs / 2));
      await walk(mid, e, depth + 1);   // 新しい側を先に
      await walk(s, mid, depth + 1);
    }
  }

  await walk(start, end, 0);

  const list = Object.values(seen).sort((a, b) => {
    const ta = new Date((a.latestMessage && a.latestMessage.createdDate) || a.createdDate || 0).getTime() || 0;
    const tb = new Date((b.latestMessage && b.latestMessage.createdDate) || b.createdDate || 0).getTime() || 0;
    return tb - ta;   // 新しい順
  });

  return { conversations: list, total: totalReported || list.length, _calls: calls };
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

// 英語の正式国名（配送先コピー用）
// eBay公式の CountryCodeType 表記に準拠（オーダー情報と同じ綴り）
const COUNTRY_EN = {
  US:'United States', CA:'Canada', GB:'United Kingdom', AU:'Australia', DE:'Germany',
  FR:'France', IT:'Italy', ES:'Spain', NL:'Netherlands', BE:'Belgium', CH:'Switzerland',
  AT:'Austria', SE:'Sweden', NO:'Norway', DK:'Denmark', FI:'Finland', PL:'Poland',
  PT:'Portugal', IE:'Ireland', CZ:'Czech Republic', GR:'Greece', HU:'Hungary',
  RO:'Romania', BG:'Bulgaria', HR:'Croatia', SK:'Slovakia', SI:'Slovenia',
  EE:'Estonia', LV:'Latvia', LT:'Lithuania', LU:'Luxembourg', MT:'Malta',
  CY:'Cyprus', IS:'Iceland', JP:'Japan', CN:'China', KR:'South Korea', TW:'Taiwan',
  HK:'Hong Kong', SG:'Singapore', MY:'Malaysia', TH:'Thailand', ID:'Indonesia',
  PH:'Philippines', VN:'Viet Nam', IN:'India', NZ:'New Zealand', BR:'Brazil',
  MX:'Mexico', AR:'Argentina', CL:'Chile', CO:'Colombia', PE:'Peru',
  VE:'Venezuela', EC:'Ecuador', UY:'Uruguay', PY:'Paraguay', BO:'Bolivia',
  CR:'Costa Rica', PA:'Panama', GT:'Guatemala', DO:'Dominican Republic',
  PR:'Puerto Rico', RU:'Russian Federation', UA:'Ukraine', TR:'Turkey', IL:'Israel',
  SA:'Saudi Arabia', AE:'United Arab Emirates', QA:'Qatar', KW:'Kuwait',
  ZA:'South Africa', EG:'Egypt', NG:'Nigeria', KE:'Kenya', MA:'Morocco',
  LI:'Liechtenstein', MC:'Monaco', SM:'San Marino', AD:'Andorra', VA:'Vatican City',
  RS:'Serbia', BA:'Bosnia and Herzegovina', MK:'Macedonia', AL:'Albania', ME:'Montenegro',
  BY:'Belarus', MD:'Moldova', GE:'Georgia', AM:'Armenia', AZ:'Azerbaijan',
  KZ:'Kazakhstan', UZ:'Uzbekistan', PK:'Pakistan', BD:'Bangladesh', LK:'Sri Lanka',
  NP:'Nepal', MM:'Myanmar', KH:'Cambodia', LA:'Laos', BN:'Brunei Darussalam',
  MO:'Macau', MN:'Mongolia', JO:'Jordan', LB:'Lebanon', OM:'Oman', BH:'Bahrain',
  IQ:'Iraq', IR:'Iran', SY:'Syria', YE:'Yemen', AF:'Afghanistan',
  TN:'Tunisia', DZ:'Algeria', LY:'Libya', SD:'Sudan', ET:'Ethiopia',
  GH:'Ghana', TZ:'Tanzania', UG:'Uganda', ZW:'Zimbabwe', ZM:'Zambia',
  MU:'Mauritius', SN:'Senegal', CI:'Cote d\'Ivoire', CM:'Cameroon',
  FJ:'Fiji', PG:'Papua New Guinea', NC:'New Caledonia', PF:'French Polynesia',
  GU:'Guam', VI:'Virgin Islands (U.S.)', BM:'Bermuda', BS:'Bahamas',
  JM:'Jamaica', TT:'Trinidad and Tobago', BB:'Barbados', KY:'Cayman Islands',
  HN:'Honduras', NI:'Nicaragua', SV:'El Salvador', BZ:'Belize',
  GP:'Guadeloupe', MQ:'Martinique', RE:'Reunion', GF:'French Guiana',
};
function countryNameEn(code) {
  if (!code) return '';
  const c = String(code).toUpperCase();
  return COUNTRY_EN[c] || c;
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
    // 在庫数（複数の場所に入る可能性があるので順に探す）
    let qty = null;
    const ea = (d.estimatedAvailabilities && d.estimatedAvailabilities[0]) || null;
    if (ea) {
      if (typeof ea.estimatedAvailableQuantity === 'number') qty = ea.estimatedAvailableQuantity;
      else if (typeof ea.availabilityThreshold === 'number') qty = ea.availabilityThreshold;
    }
    if (qty === null && typeof d.quantityAvailable === 'number') qty = d.quantityAvailable;

    const info = {
      title: d.title || '',
      imageUrl: (d.image && d.image.imageUrl) || '',
      price: d.price ? (d.price.value + ' ' + d.price.currency) : '',
      sku: d.sku || '',
      condition: d.condition || '',
      itemWebUrl: d.itemWebUrl || '',
      quantity: qty,
      availabilityStatus: ea ? (ea.estimatedAvailabilityStatus || '') : '',
      soldQuantity: (typeof d.estimatedSoldQuantity === 'number') ? d.estimatedSoldQuantity
        : (ea && typeof ea.estimatedSoldQuantity === 'number' ? ea.estimatedSoldQuantity : null),
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

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ===== Trading API ReviseItem で出品情報を更新 =====
async function reviseItem(itemId, changes) {
  if (!itemId) return { ok: false, error: 'itemIdが必要です' };
  const q = (changes && changes.quantity !== undefined && changes.quantity !== null && changes.quantity !== '')
    ? parseInt(changes.quantity, 10) : null;
  const p = (changes && changes.price !== undefined && changes.price !== null && changes.price !== '')
    ? parseFloat(changes.price) : null;
  const title = (changes && changes.title) ? String(changes.title).trim() : '';
  const sku = (changes && changes.sku !== undefined && changes.sku !== null) ? String(changes.sku).trim() : null;

  if (q === null && p === null && !title && sku === null) return { ok: false, error: '変更内容がありません' };
  if (q !== null && (isNaN(q) || q < 0)) return { ok: false, error: '数量が不正です' };
  if (p !== null && (isNaN(p) || p <= 0)) return { ok: false, error: '価格が不正です' };
  if (title && title.length > 80) return { ok: false, error: 'タイトルは80文字以内にしてください（現在 ' + title.length + '文字）' };

  try {
    const token = await getAccessToken();
    let body = '<?xml version="1.0" encoding="utf-8"?>'
      + '<ReviseItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
      + '<Item><ItemID>' + itemId + '</ItemID>';
    if (q !== null) body += '<Quantity>' + q + '</Quantity>';
    if (p !== null) body += '<StartPrice currencyID="USD">' + p.toFixed(2) + '</StartPrice>';
    if (title) body += '<Title>' + escXml(title) + '</Title>';
    if (sku !== null) body += '<SKU>' + escXml(sku) + '</SKU>';
    body += '</Item></ReviseItemRequest>';

    const res = await fetch('https://api.ebay.com/ws/api.dll', {
      method: 'POST',
      headers: {
        'X-EBAY-API-SITEID': '0',
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
        'X-EBAY-API-CALL-NAME': 'ReviseItem',
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
      body,
    });
    const t = await res.text();
    const ack = (t.match(/<Ack>([^<]+)<\/Ack>/) || [])[1] || '';
    if (ack === 'Success' || ack === 'Warning') return { ok: true, ack };
    const msg = (t.match(/<LongMessage>([^<]+)<\/LongMessage>/) || [])[1]
      || (t.match(/<ShortMessage>([^<]+)<\/ShortMessage>/) || [])[1]
      || 'eBayが更新を拒否しました';
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function clearItemCache(itemId) {
  if (itemId) delete itemCache[String(itemId)];
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

// ===== マーケットプレイスID → 表示名 =====
const MARKETPLACE_NAMES = {
  EBAY_US:'ebay.com（アメリカ）',
  EBAY_GB:'ebay.co.uk（イギリス）',
  EBAY_DE:'ebay.de（ドイツ）',
  EBAY_AU:'ebay.com.au（オーストラリア）',
  EBAY_CA:'ebay.ca（カナダ）',
  EBAY_FR:'ebay.fr（フランス）',
  EBAY_IT:'ebay.it（イタリア）',
  EBAY_ES:'ebay.es（スペイン）',
  EBAY_AT:'ebay.at（オーストリア）',
  EBAY_BE:'ebay.be（ベルギー）',
  EBAY_CH:'ebay.ch（スイス）',
  EBAY_IE:'ebay.ie（アイルランド）',
  EBAY_NL:'ebay.nl（オランダ）',
  EBAY_PL:'ebay.pl（ポーランド）',
  EBAY_SG:'ebay.com.sg（シンガポール）',
  EBAY_HK:'ebay.com.hk（香港）',
  EBAY_MY:'ebay.com.my（マレーシア）',
  EBAY_PH:'ebay.ph（フィリピン）',
  EBAY_IN:'ebay.in（インド）',
  EBAY_JP:'ebay.co.jp（日本）',
  EBAY_MOTORS_US:'ebay Motors（アメリカ）',
  EBAY_CZ:'ebay.cz（チェコ）',
  EBAY_DK:'ebay.dk（デンマーク）',
  EBAY_FI:'ebay.fi（フィンランド）',
  EBAY_GR:'ebay.gr（ギリシャ）',
  EBAY_HU:'ebay.hu（ハンガリー）',
  EBAY_IL:'ebay.co.il（イスラエル）',
  EBAY_NO:'ebay.no（ノルウェー）',
  EBAY_NZ:'ebay.co.nz（ニュージーランド）',
  EBAY_PE:'ebay.com.pe（ペルー）',
  EBAY_PR:'ebay.com（プエルトリコ）',
  EBAY_PT:'ebay.pt（ポルトガル）',
  EBAY_RU:'ebay.ru（ロシア）',
  EBAY_SE:'ebay.se（スウェーデン）',
  EBAY_ZA:'ebay.co.za（南アフリカ）',
  EBAY_TW:'ebay.com.tw（台湾）',
  EBAY_TH:'ebay.co.th（タイ）',
  EBAY_VN:'ebay.vn（ベトナム）',
  EBAY_ID:'ebay.co.id（インドネシア）',
  EBAY_CN:'ebay.cn（中国）',
};
function marketplaceName(id) {
  if (!id) return '';
  return MARKETPLACE_NAMES[id] || id;
}

// 注文オブジェクトからマーケットプレイスIDを探す（フィールド名が複数あり得る）
// バイヤーが「購入した」サイトを取得（出品サイトとは別物）
function pickMarketplaceId(o) {
  if (!o) return '';
  const li = (o.lineItems && o.lineItems[0]) || {};
  // purchaseMarketplaceId = 実際に購入されたサイト（例: EBAY_IT）
  // listingMarketplaceId  = 出品したサイト（例: EBAY_US）
  return li.purchaseMarketplaceId
    || o.marketplaceId
    || li.listingMarketplaceId
    || '';
}

// 出品サイト（参考用）
function pickListingMarketplaceId(o) {
  if (!o) return '';
  const li = (o.lineItems && o.lineItems[0]) || {};
  return li.listingMarketplaceId || '';
}

// ===== 注文の税金を集計（VAT / GST / 州税など全種） =====
// ===== 単一注文の詳細を取得 =====
// eBay仕様：getOrders では cancelRequests が常に空。個別のgetOrderが必要
const singleOrderCache = {};
async function getOrderDetail(orderId) {
  if (!orderId) return null;
  const key = String(orderId);
  if (singleOrderCache[key] !== undefined) return singleOrderCache[key];
  try {
    const token = await getAccessToken();
    const res = await fetch('https://api.ebay.com/sell/fulfillment/v1/order/' + encodeURIComponent(key), {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('getOrderDetail ' + res.status + ':', t.substring(0, 200));
      singleOrderCache[key] = null;
      return null;
    }
    const d = await res.json();
    singleOrderCache[key] = d;
    return d;
  } catch (e) {
    console.error('getOrderDetail error:', e.message);
    singleOrderCache[key] = null;
    return null;
  }
}

// 納税者番号の種類ラベル
const TAX_ID_LABELS = {
  CPF: 'CPF', CPFTaxID: 'CPF', CNPJ: 'CNPJ',
  RFC: 'RFC', CURP: 'CURP',
  CEDULA: 'Cédula', DNI: 'DNI', NIE: 'NIE', NIT: 'NIT',
  RUT: 'RUT', VATIN: 'VAT', CodiceFiscale: 'Codice Fiscale',
  TRN: 'TRN',
};
function taxIdLabel(t) {
  if (!t) return '納税者番号';
  return TAX_ID_LABELS[t] || t;
}

// 注文からバイヤーの納税者番号を取り出す
function extractTaxId(o) {
  if (!o) return null;
  const b = o.buyer || {};
  const ti = b.taxIdentifier || (Array.isArray(b.taxIdentifiers) ? b.taxIdentifiers[0] : null);
  if (ti && ti.taxpayerId) {
    return {
      id: ti.taxpayerId,
      type: ti.taxIdentifierType || '',
      label: taxIdLabel(ti.taxIdentifierType),
      country: ti.issuingCountry || '',
    };
  }
  return null;
}

// キャンセル理由の日本語ラベル
const CANCEL_REASONS = {
  WONT_ARRIVE_IN_TIME: '到着が間に合わない',
  ORDER_MISTAKE: '注文間違い',
  FOUND_CHEAPER_PRICE: '他店で安く見つけた',
  WRONG_PAYMENT_METHOD: '支払い方法の誤り',
  WRONG_SHIPPING_ADDRESS: '配送先の誤り',
  WRONG_SHIPPING_METHOD: '配送方法の誤り',
  ADDRESS_ISSUES: '住所に問題あり（セラー都合）',
  BUYER_ASKED_CANCEL: 'バイヤーの依頼による（セラー操作）',
  ORDER_UNPAID: '未払いのため',
  OUT_OF_STOCK_OR_CANNOT_FULFILL: '在庫切れ・出荷不可',
  OTHER: 'その他',
};
function cancelReasonLabel(r) {
  if (!r) return '';
  return CANCEL_REASONS[r] || r;
}

// ===== Post-Order API: キャンセル情報を取得 =====
// Fulfillment API では cancelRequests が空のため、こちらから取得する
const cancelSearchCache = { data: null, at: 0 };
async function getCancellations(daysBack) {
  const now = Date.now();
  // 5分キャッシュ
  if (cancelSearchCache.data && (now - cancelSearchCache.at) < 5 * 60 * 1000) {
    return cancelSearchCache.data;
  }
  try {
    const token = await getAccessToken();
    const days = daysBack || 90;
    const from = new Date(now - days * 86400000).toISOString().split('.')[0] + '.000Z';
    const to = new Date(now).toISOString().split('.')[0] + '.000Z';
    // ページングで全件取得（1回200件・最大3000件）
    const list = [];
    let offset = 0;
    for (let p = 0; p < 15; p++) {
      const url = 'https://api.ebay.com/post-order/v2/cancellation/search'
        + '?creation_date_range_from=' + encodeURIComponent(from)
        + '&creation_date_range_to=' + encodeURIComponent(to)
        + '&role=SELLER&limit=200&offset=' + offset;
      const res = await fetch(url, {
        headers: {
          'Authorization': 'TOKEN ' + token,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      });
      if (!res.ok) {
        const t = await res.text();
        console.error('getCancellations ' + res.status + ':', t.substring(0, 300));
        if (list.length === 0) return null;
        break;
      }
      const d = await res.json();
      const batch = d.cancellations || [];
      list.push(...batch);
      if (batch.length < 200) break;
      offset += 200;
    }
    console.log('[cancellations] ' + list.length + '件取得');
    // legacyOrderId をキーにしたマップにする
    const map = {};
    list.forEach(cn => {
      const oid = (cn.legacyOrderId || cn.orderId || '').toString();
      if (!oid) return;
      map[oid] = {
        cancelId: cn.cancelId || '',
        state: cn.cancelStatus || cn.cancelState || '',
        requestedAt: cn.cancelRequestDate && cn.cancelRequestDate.value || cn.creationDate && cn.creationDate.value || '',
        closedAt: cn.cancelCloseDate && cn.cancelCloseDate.value || '',
        reason: cn.cancelReason || '',
        initiator: cn.requestorType || cn.cancelInitiator || '',
      };
    });
    cancelSearchCache.data = map;
    cancelSearchCache.at = now;
    return map;
  } catch (e) {
    console.error('getCancellations error:', e.message);
    return null;
  }
}

function sumOrderTaxes(o) {
  const out = { total: 0, currency: '', items: [] };
  if (!o) return out;

  function add(amount, type) {
    if (!amount || !amount.value) return;
    const v = parseFloat(amount.value);
    if (isNaN(v) || v === 0) return;
    out.total += v;
    if (!out.currency) out.currency = amount.currency || '';
    const label = type || 'TAX';
    const found = out.items.find(x => x.type === label);
    if (found) found.value += v;
    else out.items.push({ type: label, value: v, currency: amount.currency || '' });
  }

  // 明細行ごとの税
  (o.lineItems || []).forEach(li => {
    (li.taxes || []).forEach(t => add(t.amount, t.taxType));
    (li.ebayCollectAndRemitTaxes || []).forEach(t => add(t.amount, t.taxType));
  });
  // 注文全体のeBay代理徴収税
  if (Array.isArray(o.ebayCollectAndRemitTax)) {
    o.ebayCollectAndRemitTax.forEach(t => add(t.amount, t.taxType));
  } else if (o.ebayCollectAndRemitTax && o.ebayCollectAndRemitTax.amount) {
    add(o.ebayCollectAndRemitTax.amount, o.ebayCollectAndRemitTax.taxType);
  }
  return out;
}

// 税種別を日本語ラベルに
const TAX_LABELS = {
  VAT: 'VAT（付加価値税）',
  GST: 'GST（物品サービス税）',
  STATE_SALES_TAX: '州税',
  SALES_TAX: '売上税',
  PROVINCE_SALES_TAX: '州税',
  IMPORT_TAX: '輸入税',
  ELECTRONIC_WASTE_RECYCLING_FEE: '電子廃棄物リサイクル料',
};
function taxLabel(type) {
  if (!type) return '税';
  return TAX_LABELS[type] || type;
}

// キャンセル状態のラベル
// キャンセル状態の定義
// label: 表示名 / kind: 'open'=対応待ち, 'closed'=決着済み / event: チャットに出すか
// label=詳細表示 / short=状況欄の短いラベル / kind: open=対応待ち, closed=決着済み
const CANCEL_STATES = {
  NONE_REQUESTED:               { label: '',                                   short: '',                 kind: ''       },
  CANCEL_REQUESTED:             { label: 'キャンセルリクエストが届いています',   short: 'キャンセルリクエスト中', kind: 'open'   },
  IN_PROGRESS:                  { label: 'キャンセルリクエストが届いています',   short: 'キャンセルリクエスト中', kind: 'open'   },
  CANCEL_PENDING:               { label: 'キャンセルリクエストが届いています',   short: 'キャンセルリクエスト中', kind: 'open'   },
  CANCELED:                     { label: 'キャンセルが成立しました（取引終了）', short: 'キャンセル済み',     kind: 'closed' },
  CANCEL_CLOSED_WITH_REFUND:    { label: '返金してキャンセル成立（取引終了）',   short: 'キャンセル済み',     kind: 'closed' },
  CANCEL_CLOSED_NO_REFUND:      { label: 'キャンセル成立（返金なし・取引終了）', short: 'キャンセル済み',     kind: 'closed' },
  CANCEL_CLOSED_UNKNOWN_REFUND: { label: 'キャンセルが成立しました（取引終了）', short: 'キャンセル済み',     kind: 'closed' },
  CANCEL_CLOSED_FOR_COMMITMENT: { label: 'キャンセルを拒否しました（取引継続）', short: '取引継続',           kind: 'keep'   },
  CANCEL_REJECTED:              { label: 'キャンセルを拒否しました（取引継続）', short: '取引継続',           kind: 'keep'   },
  DECLINED:                     { label: 'キャンセルを拒否しました（取引継続）', short: '取引継続',           kind: 'keep'   },
  CANCEL_SUCCESS_NO_REFUND:     { label: 'キャンセル成立（返金なし・取引終了）', short: 'キャンセル済み',     kind: 'closed' },
  CANCEL_SUCCESS:               { label: 'キャンセルが成立しました（取引終了）', short: 'キャンセル済み',     kind: 'closed' },
  CANCEL_COMPLETE:              { label: 'キャンセルが成立しました（取引終了）', short: 'キャンセル済み',     kind: 'closed' },
  CANCEL_FAILED:                { label: 'キャンセルが失敗しました',             short: 'キャンセル失敗',     kind: 'keep'   },
};
function cancelInfo(state) {
  if (!state) return { label: '', short: '', kind: '' };
  const s = CANCEL_STATES[state];
  if (s) return s;
  // 未知の状態は文字列から推測する
  const up = String(state).toUpperCase();
  if (up.indexOf('DECLIN') >= 0 || up.indexOf('REJECT') >= 0 || up.indexOf('COMMITMENT') >= 0) {
    return { label: 'キャンセルを拒否しました（取引継続）', short: '取引継続', kind: 'keep' };
  }
  if (up.indexOf('CANCEL') >= 0 && (up.indexOf('CLOSED') >= 0 || up === 'CANCELED' || up === 'CANCELLED')) {
    return { label: 'キャンセルが成立しました（取引終了）', short: 'キャンセル済み', kind: 'closed' };
  }
  return { label: 'キャンセルリクエストが届いています', short: 'キャンセルリクエスト中', kind: 'open' };
}
function cancelLabel(state) {
  return cancelInfo(state).label;
}

// ===== 注文オブジェクトを表示用に整形 =====
function formatOrder(o) {
  if (!o) return null;
  const ship = (o.fulfillmentStartInstructions && o.fulfillmentStartInstructions[0]
    && o.fulfillmentStartInstructions[0].shippingStep
    && o.fulfillmentStartInstructions[0].shippingStep.shipTo) || {};
  const addr = ship.contactAddress || {};
  const li = (o.lineItems && o.lineItems[0]) || {};
  return {
    orderId: o.orderId || '',
    orderDate: o.creationDate || '',
    marketplace: marketplaceName(pickMarketplaceId(o)),
    marketplaceRaw: pickMarketplaceId(o),
    listingSite: marketplaceName(pickListingMarketplaceId(o)),
    name: ship.fullName || '',
    email: ship.email || '',
    phone: (ship.primaryPhone && ship.primaryPhone.phoneNumber) || '',
    addressLine1: addr.addressLine1 || '',
    addressLine2: addr.addressLine2 || '',
    city: addr.city || '',
    stateOrProvince: addr.stateOrProvince || '',
    postalCode: addr.postalCode || '',
    country: addr.countryCode || '',
    countryLabel: countryName(addr.countryCode || ''),
    countryEn: countryNameEn(addr.countryCode || ''),
    shipByDate: (li.lineItemFulfillmentInstructions && li.lineItemFulfillmentInstructions.shipByDate) || '',
    orderCount: 1,
    salesRecordNo: o.salesRecordReference || '',
    taxId: extractTaxId(o),
    cancelState: (o.cancelStatus && o.cancelStatus.cancelState) || '',
    cancelLabel: cancelLabel((o.cancelStatus && o.cancelStatus.cancelState) || ''),
    cancelKind: cancelInfo((o.cancelStatus && o.cancelStatus.cancelState) || '').kind,
    cancelShort: cancelInfo((o.cancelStatus && o.cancelStatus.cancelState) || '').short,
    cancelRequestedAt: (o.cancelStatus && o.cancelStatus.cancelRequests && o.cancelStatus.cancelRequests[0] && o.cancelStatus.cancelRequests[0].cancelRequestedDate) || '',
    cancelRequestedBy: (o.cancelStatus && o.cancelStatus.cancelRequests && o.cancelStatus.cancelRequests[0] && o.cancelStatus.cancelRequests[0].cancelInitiator) || '',
    cancelClosedAt: (function(){
      const cs = o.cancelStatus || {};
      const r0 = (cs.cancelRequests && cs.cancelRequests[0]) || {};
      return r0.cancelCompletedDate || cs.cancelledDate || cs.cancelCompletedDate || '';
    })(),
    cancelReason: (function(){
      const cs = o.cancelStatus || {};
      const r0 = (cs.cancelRequests && cs.cancelRequests[0]) || {};
      return r0.cancelReason || '';
    })(),
    cancelReasonLabel: (function(){
      const cs = o.cancelStatus || {};
      const r0 = (cs.cancelRequests && cs.cancelRequests[0]) || {};
      return cancelReasonLabel(r0.cancelReason || '');
    })(),
    cancelRequests: (o.cancelStatus && o.cancelStatus.cancelRequests) || [],
    itemSubtotal: (o.pricingSummary && o.pricingSummary.priceSubtotal)
      ? (o.pricingSummary.priceSubtotal.value + ' ' + o.pricingSummary.priceSubtotal.currency) : '',
    shippingCost: (o.pricingSummary && o.pricingSummary.deliveryCost)
      ? (o.pricingSummary.deliveryCost.value + ' ' + o.pricingSummary.deliveryCost.currency) : '',
    taxTotal: (function(){
      const ps = o.pricingSummary || {};
      if (ps.tax && ps.tax.value && parseFloat(ps.tax.value) > 0) {
        return ps.tax.value + ' ' + (ps.tax.currency || '');
      }
      const t = sumOrderTaxes(o);
      return t.total > 0 ? (t.total.toFixed(2) + ' ' + t.currency) : '';
    })(),
    taxBreakdown: (function(){
      const t = sumOrderTaxes(o);
      return t.items.map(function(x){
        return { label: taxLabel(x.type), value: x.value.toFixed(2) + ' ' + x.currency };
      });
    })(),
    total: (function(){
      const ps = o.pricingSummary || {};
      if (!ps.total || !ps.total.value) return '';
      const base = parseFloat(ps.total.value) || 0;
      const cur = ps.total.currency || '';
      // pricingSummary.total は税抜のことがあるため、代理徴収税を加算して総額にする
      const t = sumOrderTaxes(o);
      const psTax = (ps.tax && ps.tax.value) ? parseFloat(ps.tax.value) : 0;
      const taxAmt = psTax > 0 ? 0 : t.total;   // ps.tax があれば total に含まれている想定
      const grand = base + taxAmt;
      return grand.toFixed(2) + ' ' + cur;
    })(),
  };
}

// ===== eBay公開プロフィールから所在国を取得 =====
const profileCache = {};
async function getBuyerLocation(username) {
  if (!username) return '';
  const key = String(username).toLowerCase();
  if (profileCache[key] !== undefined) return profileCache[key];
  try {
    const res = await fetch('https://www.ebay.com/usr/' + encodeURIComponent(username), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) { profileCache[key] = ''; return ''; }
    const html = await res.text();
    // 「Location: Brazil」のような記述を探す
    let loc = '';
    const patterns = [
      /Location:\s*<[^>]*>\s*([^<]{2,40})</i,
      /Location:\s*([A-Za-z][A-Za-z .'-]{1,39})/,
      /"location"\s*:\s*"([^"]{2,40})"/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m && m[1]) { loc = m[1].trim(); break; }
    }
    profileCache[key] = loc;
    return loc;
  } catch (e) {
    console.error('getBuyerLocation error:', e.message);
    profileCache[key] = '';
    return '';
  }
}

// デバッグ：公開ページの取得状況を確認
async function debugBuyerLocation(username) {
  try {
    const url = 'https://www.ebay.com/usr/' + encodeURIComponent(username);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = await res.text();
    const idx = html.indexOf('Location');
    return {
      ok: true,
      status: res.status,
      htmlLength: html.length,
      hasLocationWord: idx >= 0,
      around: idx >= 0 ? html.substring(Math.max(0, idx - 100), idx + 300) : html.substring(0, 400),
      parsed: await getBuyerLocation(username),
    };
  } catch (e) {
    return { ok: false, error: e.message };
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
    // 国はいくつかのタグに入る可能性があるので順に探す
    const siteToCountry = {
      US:'US', UK:'GB', Australia:'AU', Canada:'CA', Germany:'DE', France:'FR',
      Italy:'IT', Spain:'ES', Netherlands:'NL', Austria:'AT', Belgium:'BE',
      Switzerland:'CH', Ireland:'IE', Poland:'PL', Singapore:'SG', HongKong:'HK',
      India:'IN', Malaysia:'MY', Philippines:'PH', Japan:'JP', CanadaFrench:'CA',
    };
    const rawSite = pick('RegistrationSite') || pick('Site') || '';
    // 居住国は RegistrationAddress からのみ取得する。
    // 登録サイト（ebay.com等）から国を推測すると誤情報になるので使わない。
    const regAddr = pick('RegistrationAddress');
    const country = pick('Country')
      || (regAddr ? ((regAddr.match(/<Country>([^<]+)<\/Country>/) || [])[1] || '') : '')
      || '';

    const info = {
      feedbackScore: pick('FeedbackScore') || '',
      positivePercent: pick('PositiveFeedbackPercent') || '',
      country: country || '',
      site: rawSite,
      registrationDate: pick('RegistrationDate') || '',
      photoUrl: pick('PhotoDisplayURL') || '',
      status: pick('Status') || '',
      feedbackPrivate: pick('FeedbackPrivate') === 'true',
      _ack: pick('Ack') || '',
      _err: pick('LongMessage') || pick('ShortMessage') || '',
      _httpStatus: res.status,
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
      marketplace: marketplaceName(pickMarketplaceId(o)),
      marketplaceRaw: pickMarketplaceId(o),
      listingSite: marketplaceName(pickListingMarketplaceId(o)),
      salesRecordNo: o.salesRecordReference || '',
    taxId: extractTaxId(o),
    cancelState: (o.cancelStatus && o.cancelStatus.cancelState) || '',
    cancelLabel: cancelLabel((o.cancelStatus && o.cancelStatus.cancelState) || ''),
    cancelKind: cancelInfo((o.cancelStatus && o.cancelStatus.cancelState) || '').kind,
    cancelShort: cancelInfo((o.cancelStatus && o.cancelStatus.cancelState) || '').short,
    cancelRequestedAt: (o.cancelStatus && o.cancelStatus.cancelRequests && o.cancelStatus.cancelRequests[0] && o.cancelStatus.cancelRequests[0].cancelRequestedDate) || '',
    cancelRequestedBy: (o.cancelStatus && o.cancelStatus.cancelRequests && o.cancelStatus.cancelRequests[0] && o.cancelStatus.cancelRequests[0].cancelInitiator) || '',
    cancelClosedAt: (function(){
      const cs = o.cancelStatus || {};
      const r0 = (cs.cancelRequests && cs.cancelRequests[0]) || {};
      return r0.cancelCompletedDate || cs.cancelledDate || cs.cancelCompletedDate || '';
    })(),
    cancelReason: (function(){
      const cs = o.cancelStatus || {};
      const r0 = (cs.cancelRequests && cs.cancelRequests[0]) || {};
      return r0.cancelReason || '';
    })(),
    cancelReasonLabel: (function(){
      const cs = o.cancelStatus || {};
      const r0 = (cs.cancelRequests && cs.cancelRequests[0]) || {};
      return cancelReasonLabel(r0.cancelReason || '');
    })(),
    cancelRequests: (o.cancelStatus && o.cancelStatus.cancelRequests) || [],
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
      countryEn: countryNameEn(addr.countryCode || ''),
      shipByDate: li.lineItemFulfillmentInstructions && li.lineItemFulfillmentInstructions.shipByDate || '',
      orderCount: mine.length,
      itemSubtotal: (o.pricingSummary && o.pricingSummary.priceSubtotal)
        ? (o.pricingSummary.priceSubtotal.value + ' ' + o.pricingSummary.priceSubtotal.currency) : '',
      shippingCost: (o.pricingSummary && o.pricingSummary.deliveryCost)
        ? (o.pricingSummary.deliveryCost.value + ' ' + o.pricingSummary.deliveryCost.currency) : '',
      taxTotal: (function(){
        const ps = o.pricingSummary || {};
        if (ps.tax && ps.tax.value && parseFloat(ps.tax.value) > 0) {
          return ps.tax.value + ' ' + (ps.tax.currency || '');
        }
        const t = sumOrderTaxes(o);
        return t.total > 0 ? (t.total.toFixed(2) + ' ' + t.currency) : '';
      })(),
      taxBreakdown: (function(){
        const t = sumOrderTaxes(o);
        return t.items.map(function(x){
          return { label: taxLabel(x.type), value: x.value.toFixed(2) + ' ' + x.currency };
        });
      })(),
      total: (function(){
        const ps = o.pricingSummary || {};
        if (!ps.total || !ps.total.value) return '';
        const base = parseFloat(ps.total.value) || 0;
        const cur = ps.total.currency || '';
        const t = sumOrderTaxes(o);
        const psTax = (ps.tax && ps.tax.value) ? parseFloat(ps.tax.value) : 0;
        const taxAmt = psTax > 0 ? 0 : t.total;
        return (base + taxAmt).toFixed(2) + ' ' + cur;
      })(),
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
  reviseItem: reviseItem,
  clearItemCache: clearItemCache,
  getBuyerOrderInfo: getBuyerOrderInfo,
  formatOrder: formatOrder,
  getOrderDetail: getOrderDetail,
  getCancellations: getCancellations,
  cancelReasonLabel: cancelReasonLabel,
  extractTaxId: extractTaxId,
  getOrderDetail: getOrderDetail,
  getCancellations: getCancellations,
  marketplaceName: marketplaceName,
  getBuyerPublicInfo: getBuyerPublicInfo,
  getUserInfo: getUserInfo,
  getBuyerLocation: getBuyerLocation,
  debugBuyerLocation: debugBuyerLocation,
  countryName: countryName,
  countryNameEn: countryNameEn,
  cancelLabel: cancelLabel,
  cancelInfo: cancelInfo,
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
