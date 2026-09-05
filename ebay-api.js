// ===== eBay Trading API 連携 =====
const fetch = require('node-fetch');

const EBAY_API_URL = 'https://api.ebay.com/ws/api.dll';

// 環境変数から取得
function getCreds() {
  return {
    appId: process.env.EBAY_APP_ID,
    devId: process.env.EBAY_DEV_ID,
    certId: process.env.EBAY_CERT_ID,
    userToken: process.env.EBAY_USER_TOKEN,
  };
}

// XMLエスケープ
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Trading API 共通呼び出し
async function callTradingAPI(callName, xmlBody) {
  const c = getCreds();
  if (!c.userToken) throw new Error('EBAY_USER_TOKEN が未設定です');

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${c.userToken}</eBayAuthToken>
  </RequesterCredentials>
  ${xmlBody}
</${callName}Request>`;

  const res = await fetch(EBAY_API_URL, {
    method: 'POST',
    headers: {
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-APP-NAME': c.appId,
      'X-EBAY-API-DEV-NAME': c.devId,
      'X-EBAY-API-CERT-NAME': c.certId,
      'Content-Type': 'text/xml',
    },
    body: xml,
  });
  return await res.text();
}

// XMLから値を抜き出す簡易パーサ
function xmlVal(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}
function xmlAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// ===== メッセージ一覧を取得 =====
async function getMemberMessages(daysBack = 7) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const body = `
  <MailMessageType>All</MailMessageType>
  <StartCreationTime>${start.toISOString()}</StartCreationTime>
  <EndCreationTime>${end.toISOString()}</EndCreationTime>
  <DetailLevel>ReturnMessages</DetailLevel>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>`;

  const xml = await callTradingAPI('GetMemberMessages', body);
  const ack = xmlVal(xml, 'Ack');
  if (ack !== 'Success' && ack !== 'Warning') {
    const err = xmlVal(xml, 'LongMessage') || xmlVal(xml, 'ShortMessage');
    throw new Error(`eBay API error: ${err}`);
  }

  const items = xmlAll(xml, 'MemberMessageExchange');
  return items.map((block) => {
    const q = xmlVal(block, 'Question');
    return {
      messageId: xmlVal(q, 'MessageID') || xmlVal(block, 'MessageID'),
      buyer: xmlVal(q, 'SenderID'),
      subject: xmlVal(q, 'Subject'),
      body: xmlVal(q, 'Body'),
      itemId: xmlVal(q, 'ItemID') || xmlVal(block, 'ItemID'),
      timestamp: xmlVal(block, 'CreationDate') || xmlVal(q, 'CreationDate'),
      status: xmlVal(block, 'MessageStatus'),
    };
  }).filter(m => m.buyer && m.body);
}

// ===== My Messages（より広範囲）を取得 =====
async function getMyMessages(daysBack = 7) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const body = `
  <StartTime>${start.toISOString()}</StartTime>
  <EndTime>${end.toISOString()}</EndTime>
  <DetailLevel>ReturnMessages</DetailLevel>`;

  const xml = await callTradingAPI('GetMyMessages', body);
  const ack = xmlVal(xml, 'Ack');
  if (ack !== 'Success' && ack !== 'Warning') {
    const err = xmlVal(xml, 'LongMessage') || xmlVal(xml, 'ShortMessage');
    throw new Error(`eBay API error: ${err}`);
  }

  const items = xmlAll(xml, 'Message');
  return items.map((block) => ({
    messageId: xmlVal(block, 'MessageID'),
    buyer: xmlVal(block, 'Sender'),
    subject: xmlVal(block, 'Subject'),
    body: xmlVal(block, 'Text'),
    itemId: xmlVal(block, 'ItemID'),
    timestamp: xmlVal(block, 'ReceiveDate'),
    read: xmlVal(block, 'Read') === 'true',
  })).filter(m => m.buyer && m.body);
}

// ===== 接続テスト =====
async function testConnection() {
  const c = getCreds();
  const diag = {
    appId: c.appId ? c.appId.substring(0,20)+'...' : 'MISSING',
    devId: c.devId ? c.devId.substring(0,12)+'...' : 'MISSING',
    certId: c.certId ? c.certId.substring(0,12)+'...' : 'MISSING',
    tokenLen: c.userToken ? c.userToken.length : 0,
  };
  try {
    const xml = await callTradingAPI('GeteBayOfficialTime', '');
    const ack = xmlVal(xml, 'Ack');
    const time = xmlVal(xml, 'Timestamp');
    if (ack === 'Success') {
      return { ok: true, time, diag };
    }
    return {
      ok: false,
      ack: ack || '(no Ack)',
      error: xmlVal(xml, 'LongMessage') || xmlVal(xml, 'ShortMessage') || '(no error message)',
      errorCode: xmlVal(xml, 'ErrorCode'),
      raw: xml.substring(0, 800),
      diag
    };
  } catch (e) {
    return { ok: false, error: 'exception: ' + e.message, diag };
  }
}

module.exports = { getMemberMessages, getMyMessages, testConnection, callTradingAPI };
