/**
 * utils.js
 * ------------------------------------------------------------------
 * 日付・文字列まわりの共通ユーティリティ。
 * 日付は常に日本時間（JST）基準の "YYYY-MM-DD" 文字列で扱う。
 * ------------------------------------------------------------------
 */

const BKUtil = {};

// ---- UUID ----
BKUtil.uuid = function () {
  if (window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID();
  }
  // フォールバック（古いSafari対応）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

// ---- 日付（JST基準） ----

// 現在時刻をJSTの Date として扱うためのオフセット付きISO文字列を返す
BKUtil.nowISO = function () {
  return new Date().toISOString();
};

// "YYYY-MM-DD" 形式で、「営業日」としての今日を返す
// 営業時間が20:00〜翌5:00のため、深夜0:00〜午前4:59はまだ前日の営業日として扱う
// （例：土曜日の朝4時に来店した場合は、金曜日の来店として記録する）
// Date#getTime() は常にUTC基準のエポックミリ秒なので、日本時間にするには
// 端末のタイムゾーンに関係なく「+9時間」するだけでよい
// （端末のタイムゾーンオフセットを二重に加算すると、端末がJST設定の場合に
// 日付が1日先にずれてしまうバグになるため使用しない）
BKUtil.todayJST = function () {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60000);
  if (jst.getUTCHours() < 5) {
    jst.setUTCDate(jst.getUTCDate() - 1);
  }
  return jst.toISOString().slice(0, 10);
};

// UTCのISOタイムスタンプ（例：createdAtやdisposedAt）から、営業日としての日付を取り出す。
// 単純に文字列の先頭10文字を切り出すとUTC基準の日付になってしまい、
// 日本時間の深夜0時〜午前9時ごろは「前日」の日付になってしまうバグの原因になるため、
// 必ずこの関数を通す（営業時間20:00〜翌5:00に合わせて、深夜0:00〜4:59は前日の営業日とする）。
BKUtil.jstDateFromISO = function (isoString) {
  if (!isoString) return '';
  const jst = new Date(new Date(isoString).getTime() + 9 * 60 * 60000);
  if (jst.getUTCHours() < 5) {
    jst.setUTCDate(jst.getUTCDate() - 1);
  }
  return jst.toISOString().slice(0, 10);
};

// "YYYY-MM-DD" 文字列 → Date（比較用、時刻は00:00とみなす）
BKUtil.parseDate = function (dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

// Date → "YYYY-MM-DD"
BKUtil.formatDate = function (date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

// "YYYY-MM-DD" の曜日（日〜土）を返す
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
BKUtil.weekdayLabel = function (dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAY_JA[dow];
};

// "YYYY-MM-DD" を "YYYY-MM-DD" 文字列の年 と 月日（曜日）で改行した表示用HTMLに変換
// （管理画面など、列幅が狭いテーブルで折り返しがおかしくなるのを防ぐため）
BKUtil.displayDateBroken = function (dateStr) {
  if (!dateStr) return '-';
  const [y, m, d] = dateStr.split('-');
  return `${y}年<br>${Number(m)}月${Number(d)}日（${BKUtil.weekdayLabel(dateStr)}）`;
};

// "YYYY-MM-DD" を "YYYY/MM/DD（曜日）" の表示用に変換
BKUtil.displayDate = function (dateStr) {
  if (!dateStr) return '-';
  return `${dateStr.replaceAll('-', '/')}（${BKUtil.weekdayLabel(dateStr)}）`;
};

// "YYYY-MM-DD" → "YYYYMMDD"（破棄履歴の表示IDなどに使用）
BKUtil.compactDate = function (dateStr) {
  return dateStr.replaceAll('-', '');
};

// 基準日から nMonths ヶ月前の日付（"YYYY-MM-DD"）を返す
BKUtil.monthsBefore = function (dateStr, nMonths) {
  const d = BKUtil.parseDate(dateStr);
  d.setUTCMonth(d.getUTCMonth() - nMonths);
  return BKUtil.formatDate(d);
};

// 2つの日付文字列の差（日数）。date2 - date1
BKUtil.diffDays = function (dateStr1, dateStr2) {
  const d1 = BKUtil.parseDate(dateStr1).getTime();
  const d2 = BKUtil.parseDate(dateStr2).getTime();
  return Math.round((d2 - d1) / 86400000);
};

// 今日が未来日かどうか（来店日入力バリデーション用）
BKUtil.isFutureDate = function (dateStr) {
  return dateStr > BKUtil.todayJST();
};

// "YYYY-MM" 形式（最終来店月フィルタ用）
BKUtil.toYearMonth = function (dateStr) {
  if (!dateStr) return '';
  return dateStr.slice(0, 7);
};

// ---- 破棄対象判定 ----
// disposalThresholdMonths ヶ月以上経過（基準日を含む）を対象とする
BKUtil.isDisposalTarget = function (lastVisitDate, thresholdMonths, todayStr) {
  const today = todayStr || BKUtil.todayJST();
  const boundary = BKUtil.monthsBefore(today, thresholdMonths); // 例: 2026-04-27
  return lastVisitDate <= boundary;
};

// 「まもなく破棄対象」判定：破棄対象になるまで warningDays 日以内
BKUtil.isNearDisposal = function (lastVisitDate, thresholdMonths, warningDays, todayStr) {
  const today = todayStr || BKUtil.todayJST();
  if (BKUtil.isDisposalTarget(lastVisitDate, thresholdMonths, today)) return false;
  // 破棄対象になる日 = 最終来店日 + thresholdMonths ヶ月 + 1日
  const exactDisposalDate = BKUtil.addDays(BKUtil.addMonths(lastVisitDate, thresholdMonths), 1);
  const daysUntil = BKUtil.diffDays(today, exactDisposalDate);
  return daysUntil >= 0 && daysUntil <= warningDays;
};

BKUtil.addMonths = function (dateStr, nMonths) {
  const d = BKUtil.parseDate(dateStr);
  d.setUTCMonth(d.getUTCMonth() + nMonths);
  return BKUtil.formatDate(d);
};

BKUtil.addDays = function (dateStr, nDays) {
  const d = BKUtil.parseDate(dateStr);
  d.setUTCDate(d.getUTCDate() + nDays);
  return BKUtil.formatDate(d);
};

// ---- フリガナ正規化（ひらがな/カタカナ吸収 + 簡易ゆらぎ吸収） ----
BKUtil.normalizeKana = function (str) {
  if (!str) return '';
  // カタカナ → ひらがな に統一
  let s = str.replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  // 長音符・中黒・スペースなどを除去
  s = s.replace(/[ー\u30fc・\s　]/g, '');
  return s;
};

BKUtil.normalizeName = function (str) {
  if (!str) return '';
  return str.replace(/[\s　]/g, '');
};

// 部分一致検索（大文字小文字・全角半角は簡易対応）
BKUtil.includesPartial = function (haystack, needle) {
  if (!needle) return true;
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
};

window.BKUtil = BKUtil;
