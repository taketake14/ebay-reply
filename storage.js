// ===== 添付ファイルの保存層 =====
//
// 添付ファイルの「置き場所」をこのファイル1つに閉じ込めている。
// 現在はRenderの永続ディスクに保存している。将来Googleドライブや
// オブジェクトストレージへ移す場合も、書き換えるのはこのファイルだけで済む。
//
// 重要な設計：
//   保存先のURLをそのままeBayに渡さない。
//   eBayには必ず自前のURL（https://<このアプリ>/media/<id>）を渡し、
//   アプリが保存先から読み出して中継する。こうしておくと保存先を
//   差し替えても、eBayに渡すURLの形が変わらない。
//
// 必要な設定：
//   Renderの管理画面でディスクを追加し、Mount Path を /var/data にする。
//   別の場所にした場合は環境変数 DISK_PATH でその場所を指定する。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// 保存先。Renderのディスクのマウント先を指す
const baseDir = process.env.DISK_PATH || '/var/data';
const mediaDir = path.join(baseDir, 'media');

function init() {
  // 保存先が使えるかを起動時に確かめておく。
  // ディスクが未設定のまま動かすと、再起動のたびに添付が消えて原因が分かりにくい
  try {
    fs.mkdirSync(mediaDir, { recursive: true });
  } catch (e) {
    console.error('[storage] 保存先を作成できません:', mediaDir, e.message);
  }
}

function backendName() {
  return 'render-disk (' + mediaDir + ')';
}

// 保存先が実際に読み書きできるかを確認する
function checkReady() {
  try {
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    const probe = path.join(mediaDir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true, dir: mediaDir };
  } catch (e) {
    return { ok: false, dir: mediaDir, error: e.message };
  }
}

// idから保存パスを作る。idは英数字だけに限定して、外から別の場所を指されないようにする
function pathsFor(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!safe || safe.length < 8) return null;
  return {
    bin: path.join(mediaDir, safe + '.bin'),
    meta: path.join(mediaDir, safe + '.json'),
    id: safe,
  };
}

// ファイルを保存する。戻り値の id を /media/<id> で参照する
async function put(opts) {
  const { buffer, filename, mimeType } = opts;
  if (!buffer || !buffer.length) throw new Error('ファイルが空です');

  const ready = checkReady();
  if (!ready.ok) {
    throw new Error('保存先に書き込めません（' + ready.dir + '）。'
      + 'Renderの管理画面でディスクを追加し、Mount Pathを ' + baseDir + ' にしてください。詳細: ' + ready.error);
  }

  const id = crypto.randomBytes(16).toString('hex');
  const p = pathsFor(id);
  const meta = {
    name: filename || ('attachment-' + Date.now()),
    mimeType: mimeType || 'application/octet-stream',
    size: buffer.length,
    uploadedAt: new Date().toISOString(),
  };
  fs.writeFileSync(p.bin, buffer);
  fs.writeFileSync(p.meta, JSON.stringify(meta));
  return { id, name: meta.name, size: meta.size, mimeType: meta.mimeType };
}

// ファイルを読み出す（/media/<id> から呼ばれる）
async function get(id) {
  const p = pathsFor(id);
  if (!p) return null;
  if (!fs.existsSync(p.bin)) return null;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')); } catch (e) { meta = {}; }
  const buffer = fs.readFileSync(p.bin);
  return {
    buffer,
    name: meta.name || (p.id + '.bin'),
    mimeType: meta.mimeType || 'application/octet-stream',
    size: buffer.length,
  };
}

async function remove(id) {
  const p = pathsFor(id);
  if (!p) return false;
  let done = false;
  try { if (fs.existsSync(p.bin)) { fs.unlinkSync(p.bin); done = true; } } catch (e) {}
  try { if (fs.existsSync(p.meta)) fs.unlinkSync(p.meta); } catch (e) {}
  return done;
}

// 指定日数より古い添付を削除する（容量を無限に増やさないため）
async function cleanupOlderThan(days) {
  const ready = checkReady();
  if (!ready.ok) return { ok: false, error: ready.error };
  const cutoff = Date.now() - days * 86400000;
  let checked = 0, deleted = 0, freed = 0;
  let files = [];
  try { files = fs.readdirSync(mediaDir); } catch (e) { return { ok: false, error: e.message }; }
  for (const f of files) {
    if (!f.endsWith('.bin')) continue;
    checked++;
    const full = path.join(mediaDir, f);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        freed += st.size;
        await remove(f.replace(/\.bin$/, ''));
        deleted++;
      }
    } catch (e) {}
  }
  return { ok: true, checked, deleted, freedMB: Math.round(freed / 1048576 * 10) / 10 };
}

// 現在の使用量を返す（容量が増えすぎていないか確認する用）
function usage() {
  const ready = checkReady();
  if (!ready.ok) return { ok: false, error: ready.error, dir: mediaDir };
  let count = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(mediaDir)) {
      if (!f.endsWith('.bin')) continue;
      count++;
      try { bytes += fs.statSync(path.join(mediaDir, f)).size; } catch (e) {}
    }
  } catch (e) {
    return { ok: false, error: e.message, dir: mediaDir };
  }
  return { ok: true, dir: mediaDir, files: count, totalMB: Math.round(bytes / 1048576 * 10) / 10 };
}

init();

module.exports = {
  init,
  backendName,
  checkReady,
  usage,
  put,
  get,
  remove,
  cleanupOlderThan,
  toEbayMediaType,
  EBAY_MEDIA_TYPES,
};
