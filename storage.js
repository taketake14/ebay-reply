// ===== 添付ファイルの保存層 =====
//
// 添付ファイルの「置き場所」をこのファイル1つに閉じ込めている。
// 現在はGoogleドライブに保存しているが、将来Renderの永続ディスクや
// オブジェクトストレージへ移す場合も、書き換えるのはこのファイルだけで済む。
//
// 重要な設計：
//   保存先のURLをそのままeBayに渡さない。
//   eBayには必ず自前のURL（https://<このアプリ>/media/<id>）を渡し、
//   アプリが保存先から読み出して中継する。理由は2つ。
//     1. ドライブの共有リンクは形式が特殊で、eBayに拒否される可能性がある
//     2. 保存先を差し替えても、eBayに渡すURLの形が変わらない

const fetch = require('node-fetch');

const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

// eBayが受け付けるメディア種別（これ以外は送信できない）
const EBAY_MEDIA_TYPES = ['IMAGE', 'PDF', 'DOC', 'TXT'];

// 拡張子・MIMEタイプからeBayのメディア種別を判定する
function toEbayMediaType(mimeType, filename) {
  const m = String(mimeType || '').toLowerCase();
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (m.startsWith('image/')) return 'IMAGE';
  if (m === 'application/pdf') return 'PDF';
  if (m.startsWith('text/')) return 'TXT';
  if (m.indexOf('word') >= 0 || m.indexOf('officedocument.wordprocessing') >= 0) return 'DOC';
  // MIMEタイプが取れない場合は拡張子で判定
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic'].indexOf(ext) >= 0) return 'IMAGE';
  if (ext === 'pdf') return 'PDF';
  if (['doc', 'docx', 'rtf', 'odt'].indexOf(ext) >= 0) return 'DOC';
  if (['txt', 'csv', 'log', 'md'].indexOf(ext) >= 0) return 'TXT';
  return '';   // 判定できないものは送信させない
}

let getToken = null;       // サーバー側から渡されるトークン取得関数
let folderId = '';         // 保存先フォルダ（未指定ならサービスアカウントの直下）

function init(opts) {
  getToken = opts.getAccessToken;
  folderId = opts.folderId || process.env.DRIVE_FOLDER_ID || '';
}

function backendName() {
  return 'google-drive';
}

// multipart/related 形式の本文を組み立てる（Drive APIのアップロード形式）
function buildMultipart(metadata, buffer, mimeType) {
  const boundary = 'replai' + Date.now() + Math.random().toString(36).slice(2);
  const head = Buffer.from(
    '--' + boundary + '\r\n'
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + JSON.stringify(metadata) + '\r\n'
    + '--' + boundary + '\r\n'
    + 'Content-Type: ' + (mimeType || 'application/octet-stream') + '\r\n\r\n'
  );
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
  return { body: Buffer.concat([head, buffer, tail]), boundary };
}

// ファイルを保存する。戻り値の id を /media/<id> で参照する
async function put(opts) {
  if (!getToken) throw new Error('保存層が初期化されていません');
  const { buffer, filename, mimeType } = opts;
  if (!buffer || !buffer.length) throw new Error('ファイルが空です');

  const token = await getToken();
  if (!token) throw new Error('Googleの認証に失敗しました');

  const metadata = {
    name: filename || ('attachment-' + Date.now()),
    mimeType: mimeType || 'application/octet-stream',
    // 保存日を後から判定できるようにしておく（古いファイルの自動削除に使う）
    appProperties: { replai: '1', uploadedAt: new Date().toISOString() },
  };
  if (folderId) metadata.parents = [folderId];

  const { body, boundary } = buildMultipart(metadata, buffer, mimeType);
  const r = await fetch(DRIVE_UPLOAD + '?uploadType=multipart&fields=id,name,size,mimeType', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'multipart/related; boundary=' + boundary,
    },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (data.error && data.error.message) || ('HTTP ' + r.status);
    // 容量不足などはそのまま表に出す。黙って失敗させない
    throw new Error('Googleドライブへの保存に失敗しました: ' + msg);
  }
  return {
    id: data.id,
    name: data.name,
    size: Number(data.size || buffer.length),
    mimeType: data.mimeType || mimeType || '',
  };
}

// ファイルを読み出す（/media/<id> から呼ばれる）
async function get(id) {
  if (!getToken) throw new Error('保存層が初期化されていません');
  const token = await getToken();
  const metaRes = await fetch(DRIVE_FILES + '/' + encodeURIComponent(id) + '?fields=id,name,mimeType,size', {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (!metaRes.ok) return null;
  const meta = await metaRes.json();
  const binRes = await fetch(DRIVE_FILES + '/' + encodeURIComponent(id) + '?alt=media', {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  if (!binRes.ok) return null;
  const buffer = await binRes.buffer();
  return { buffer, name: meta.name, mimeType: meta.mimeType, size: Number(meta.size || buffer.length) };
}

async function remove(id) {
  if (!getToken) throw new Error('保存層が初期化されていません');
  const token = await getToken();
  const r = await fetch(DRIVE_FILES + '/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token },
  });
  return r.ok || r.status === 404;
}

// 指定日数より古い添付を削除する（容量を無限に増やさないため）
async function cleanupOlderThan(days) {
  if (!getToken) return { ok: false, error: '保存層が初期化されていません' };
  const token = await getToken();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  let q = "appProperties has { key='replai' and value='1' } and trashed=false";
  if (folderId) q += " and '" + folderId + "' in parents";
  const url = DRIVE_FILES + '?q=' + encodeURIComponent(q)
    + '&fields=files(id,name,appProperties,createdTime)&pageSize=200';
  const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
  const data = await r.json();
  const files = data.files || [];
  let deleted = 0;
  for (const f of files) {
    const at = (f.appProperties && f.appProperties.uploadedAt) || f.createdTime || '';
    if (at && at < cutoff) {
      const done = await remove(f.id).catch(() => false);
      if (done) deleted++;
    }
  }
  return { ok: true, checked: files.length, deleted };
}

module.exports = {
  init,
  backendName,
  put,
  get,
  remove,
  cleanupOlderThan,
  toEbayMediaType,
  EBAY_MEDIA_TYPES,
};
