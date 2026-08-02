/**
 * app.js
 * ------------------------------------------------------------------
 * 画面ロジック（データ永続化は storage.js の StorageAdapter 経由のみで行う）
 * ------------------------------------------------------------------
 */

// ==========================================================================
// 1. 定数
// ==========================================================================

const BOTTLE_TYPES = [
  '金宮', '角', 'ホワイト', '吉四六', '赤霧島',
  '茉莉花', 'ジェムソン', '宝', '白州', 'ミズナラ', 'その他',
];

// 「ボトル毎管理」画面のタブで、種類をまたいで全件検索するための特別な値
const ALL_TYPES_TAB = '__ALL__';

// スプレッドシート連携の既定URL。ここにApps ScriptのURLを設定しておくと、
// 各端末で個別に設定しなくても、URLを開いた全端末が自動でこのURLから最新データを取得する。
// スプレッドシートを作り直した場合は、ここを新しいURLに書き換えて公開し直してください。
const BUILT_IN_SHEET_SYNC_URL = 'https://script.google.com/macros/s/AKfycbzepxMhLoipibJ6pIfJ-FZ2OM7SzlXB3TNa4l8CP2n70V34nm4Sm9gLBbPsiIZo5iDH/exec';
// 読み取り専用。スプレッドシート本体のID（「リンクを知っている人は閲覧可」に設定済みであること）。
// Googleスプレッドシート公式のJSON書き出し機能（gviz）経由で読み取るため、ブラウザ間の相性問題を受けにくい。
const BUILT_IN_SPREADSHEET_ID = '1wMGWhGP_eoVTexLiso93IlE2Ah5DWo-MdFh7y44lMfo';

function getSheetSyncUrl() {
  return (APP.settings.sheetSyncUrl && APP.settings.sheetSyncUrl.trim()) || BUILT_IN_SHEET_SYNC_URL;
}

const DEFAULT_SETTINGS = {
  numberingScheme: 'perType',       // 確定仕様：ボトル種類ごとの連番
  maxBottleNoByType: {},            // 種類ごとの上限（未設定時は下記デフォルトを使用）
  defaultMaxBottleNo: 200,
  disposalThresholdMonths: 3,       // 確定仕様
  nearDisposalWarningDays: 14,      // 確定仕様（2週間前から）
  backupReminderIntervalDays: 7,
  lastBackupAt: null,
  sheetSyncUrl: '',                 // Google Apps Script（Webアプリ）のURL（空の場合はBUILT_IN_SHEET_SYNC_URLを使用）
  sheetAutoSync: true,              // データ変更のたびに自動で同期する（プッシュ）か
  sheetAutoPullOnStart: true,       // 起動時に自動で共有データを取得（プル）するか
  lastSheetPushAt: null,
  lastSheetPullAt: null,
  dismissedMergePairs: [],
  simpleModeBottle: true,
  lastLocalMutationAt: null,
  simpleModeCustomer: true,
};

// ==========================================================================
// 2. アプリ状態
// ==========================================================================

const APP = {
  storage: null,
  settings: null,
  customers: [],
  bottles: [],
  visits: [],
  disposalHistory: [],
  operationLogs: [],
  currentScreen: 'add',
  manageBottleTab: ALL_TYPES_TAB,
  disposalTab: ALL_TYPES_TAB,
  filters: { freeword: '', bottleType: '', bottleNo: '', yearMonth: '', star: '', status: '' },
  sort: {},
  remainingDraft: {},     // bottleId -> 残量(0-100) 破棄対象画面での一時保持
  addForm: { selectedCustomerId: null, prefillCustomerId: null },
};

// ==========================================================================
// 3. 起動
// ==========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  APP.storage = new window.BottleKeepStorage.IndexedDBAdapter();
  await APP.storage.init();

  let settings = await APP.storage.getSettings();
  if (!settings) {
    settings = { ...DEFAULT_SETTINGS };
    await APP.storage.putSettings(settings);
  } else {
    settings = { ...DEFAULT_SETTINGS, ...settings };
  }
  APP.settings = settings;

  await refreshCache();

  if (APP.settings.sheetAutoPullOnStart) {
    if (hasUnsyncedLocalChanges()) {
      showToast('未送信のローカル変更が残っているため、起動時の自動取得をスキップしました。「今すぐ送信する」を先に行ってください。', 'warn');
    } else {
      pullFromSpreadsheet(true); // 起動を待たせないよう、完了を待たずバックグラウンドで実行
    }
  }

  setupNav();

  document.getElementById('btn-home').addEventListener('click', () => renderScreen('add'));
  document.getElementById('btn-title-home').addEventListener('click', () => renderScreen('add'));
  document.getElementById('btn-reload').addEventListener('click', async () => {
    if (hasUnsyncedLocalChanges()) {
      const body = `<div class="warning-box">⚠ この端末にはまだ送信していない変更が残っている可能性があります。先に取得すると、その変更が失われることがあります。</div><p>再読込の前に、最新の共有データを取得しますか？</p>`;
      const actions = `
        <button class="btn btn-ghost" id="m-skip">取得せず再読込する</button>
        <button class="btn btn-primary" id="m-pull">取得してから再読込する</button>
      `;
      const box = openModal('再読込', body, actions);
      box.querySelector('#m-skip').addEventListener('click', () => location.reload());
      box.querySelector('#m-pull').addEventListener('click', async () => {
        closeModal();
        await pullFromSpreadsheet(false);
        location.reload();
      });
    } else {
      await pullFromSpreadsheet(false);
      location.reload();
    }
  });

  let restoredScreen = 'add';
  try {
    const saved = JSON.parse(sessionStorage.getItem('bottlekeep_lastScreen') || 'null');
    if (saved && saved.screen) {
      restoredScreen = saved.screen;
      if (saved.detailBottleId) APP.detailBottleId = saved.detailBottleId;
      if (saved.detailMode) APP.detailMode = saved.detailMode;
      // 詳細画面の場合、対象ボトルが既に無い（削除・破棄等）ことがあるため、その時だけ安全にトップへ戻す
      if (restoredScreen === 'detail' && !APP.bottles.some((b) => b.id === APP.detailBottleId)) {
        restoredScreen = 'add';
      }
    }
  } catch (e) { /* ignore */ }
  renderScreen(restoredScreen);
  updateBackupStatusBadge();
  maybeShowBackupReminder();
});

async function refreshCache(triggerAutoSync = true) {
  const [customers, bottles, visits, disposalHistory, operationLogs] = await Promise.all([
    APP.storage.getAllCustomers(),
    APP.storage.getAllBottles(),
    APP.storage.getAllVisits(),
    APP.storage.getAllDisposalHistory(),
    APP.storage.getAllOperationLogs(),
  ]);
  APP.customers = customers;
  APP.bottles = bottles;
  APP.visits = visits;
  APP.disposalHistory = disposalHistory;
  APP.operationLogs = operationLogs;
  if (triggerAutoSync) scheduleAutoSync();
}

// データが更新されるたびに呼ばれる。自動同期がONの場合、
// 短時間に何度も送信しないよう少し待ってからまとめて同期する（デバウンス）
let autoSyncTimer = null;
let syncInFlight = false;
let syncQueued = false;

async function scheduleAutoSync() {
  if (!APP.settings.sheetAutoSync) return;
  if (autoSyncTimer) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
  if (syncInFlight) {
    // 今まさに送信中の場合は、それが終わってから改めて1回だけ追いかけて送信する。
    // 同時に複数の送信が飛ぶと、Google側でどちらが後に書き込まれるか保証されず、
    // 新しいデータが後から届いた古いデータに上書きされてしまう事故につながるため。
    syncQueued = true;
    return;
  }
  syncInFlight = true;
  try {
    await syncToSpreadsheet(true);
  } finally {
    syncInFlight = false;
    if (syncQueued) {
      syncQueued = false;
      scheduleAutoSync();
    }
  }
}

// 来店登録・統合など、ここで確実に送信しておきたい操作の直後に使う。
// 保留中のデバウンス送信をキャンセルしてから即座に送信する（確認や通知は行わない、静かな送信）。
async function manualSyncNow() {
  if (syncInFlight) {
    showToast('ちょうど自動送信中です。少し待ってからもう一度お試しください', 'warn');
    return;
  }
  syncInFlight = true;
  try {
    await syncToSpreadsheet(false);
  } finally {
    syncInFlight = false;
    if (syncQueued) {
      syncQueued = false;
      scheduleAutoSync();
    }
  }
}

function setupNav() {
  document.getElementById('sidenav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-screen]');
    if (!btn) return;
    renderScreen(btn.dataset.screen);
  });
}

function setActiveNav(screen) {
  document.querySelectorAll('.sidenav__item').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.screen === screen);
  });
}

// ==========================================================================
// 4. 画面切り替え
// ==========================================================================

function renderScreen(screen) {
  APP.currentScreen = screen;
  try {
    sessionStorage.setItem('bottlekeep_lastScreen', JSON.stringify({
      screen,
      detailBottleId: APP.detailBottleId,
      detailMode: APP.detailMode,
    }));
  } catch (e) { /* プライベートブラウズ等で使えない場合は無視 */ }
  setActiveNav(screen);
  const root = document.getElementById('screen-root');
  root.innerHTML = '';
  root.scrollTop = 0;

  switch (screen) {
    case 'add': return renderAddScreen(root);
    case 'manage-bottle': return renderManageBottleScreen(root);
    case 'manage-customer': return renderManageCustomerScreen(root);
    case 'merge': return renderMergeScreen(root);
    case 'disposal-target': return renderDisposalTargetScreen(root);
    case 'disposal-history': return renderDisposalHistoryScreen(root);
    case 'backup': return renderBackupScreen(root);
    case 'detail': return renderDetailScreen(root);
    default: return renderAddScreen(root);
  }
}

// ==========================================================================
// 5. 共通ユーティリティ（表示・状態計算）
// ==========================================================================

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function getCustomer(id) { return APP.customers.find((c) => c.id === id) || null; }
function getActiveBottlesOf(customerId) {
  return APP.bottles.filter((b) => b.customerId === customerId && b.status === 'active');
}

// 統合などでお客様に複数ボトルが集約された際、最終来店日を一番新しい日付に揃える
// （例：金宮5月・角2月を統合した場合、両方とも5月にする）
async function syncCustomerLastVisitToLatest(customerId) {
  const bottles = getActiveBottlesOf(customerId);
  if (bottles.length < 2) return;
  const latest = bottles.reduce((max, b) => (b.lastVisitDate > max ? b.lastVisitDate : max), bottles[0].lastVisitDate);
  const now = BKUtil.nowISO();
  for (const b of bottles) {
    if (b.lastVisitDate !== latest) {
      const before = { ...b };
      b.lastVisitDate = latest;
      b.updatedAt = now;
      await APP.storage.putBottle(b);
      await logOperation('内容修正', 'bottle', b.id, before, b, '統合による最終来店日の統一（最新日付に合わせて更新）');
    }
  }
}
function maxNoFor(type) {
  return APP.settings.maxBottleNoByType[type] || APP.settings.defaultMaxBottleNo;
}

function computeStatus(bottle, customer) {
  const s = APP.settings;
  if (customer && customer.star) {
    return { key: 'star', label: '★のため保管継続', cls: 'status-star' };
  }
  const target = BKUtil.isDisposalTarget(bottle.lastVisitDate, s.disposalThresholdMonths);
  if (target) return { key: 'target', label: '破棄対象', cls: 'status-target' };
  const near = BKUtil.isNearDisposal(bottle.lastVisitDate, s.disposalThresholdMonths, s.nearDisposalWarningDays);
  if (near) return { key: 'near', label: 'まもなく<br>破棄対象', cls: 'status-near' };
  return { key: 'normal', label: '通常', cls: 'status-normal' };
}

const BOTTLE_TYPE_COLOR_CLASS = {
  '金宮': 'bottle-tag--kinmiya',
  '角': 'bottle-tag--kaku',
  'ホワイト': 'bottle-tag--white',
  '吉四六': 'bottle-tag--kicchom',
  '赤霧島': 'bottle-tag--akakirishima',
  '茉莉花': 'bottle-tag--matsurika',
  'ジェムソン': 'bottle-tag--jameson',
  '宝': 'bottle-tag--takara',
  '白州': 'bottle-tag--hakushu',
  'ミズナラ': 'bottle-tag--mizunara',
  'その他': 'bottle-tag--other',
};
function bottleTagHtml(bottle) {
  const cls = BOTTLE_TYPE_COLOR_CLASS[bottle.bottleType] || '';
  return `<span class="bottle-tag ${cls}">${escapeHtml(bottle.bottleType)} No.${bottle.bottleNo}</span>`;
}

function bottleNameCellHtml(name, kana) {
  if (!name && !kana) return '';
  return `${escapeHtml(name)}${kana ? `<br><span class="text-faint" style="font-size:12px;">${escapeHtml(kana)}</span>` : ''}`;
}

function starHtml(customer) {
  return customer && customer.star ? '<span class="star-mark" title="残す（★）">★</span>' : '';
}

function elapsedDaysLabel(lastVisitDate) {
  const days = BKUtil.diffDays(lastVisitDate, BKUtil.todayJST());
  return `${days}日`;
}

// ---- 操作履歴の記録 ----
async function logOperation(actionType, targetType, targetId, before, after, note) {
  const log = {
    id: BKUtil.uuid(),
    timestamp: BKUtil.nowISO(),
    actionType, targetType, targetId,
    before: before ?? null,
    after: after ?? null,
    note: note || '',
  };
  await APP.storage.putOperationLog(log);
  APP.operationLogs.push(log);
  // このメソッドは実際にこの端末で操作が行われた時にしか呼ばれない（プルで取得した内容は
  // 直接ストレージに書き込まれるだけで、ここは通らない）。そのため、この端末に
  // まだ送信していない変更があるかどうかは、operationLogsの中身ではなく、
  // このタイムスタンプ（自端末での最後の変更時刻）で判定する。
  APP.settings.lastLocalMutationAt = log.timestamp;
  await APP.storage.putSettings(APP.settings);
}

// ---- トースト ----
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'toast--error' : type === 'warn' ? 'toast--warn' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

// ---- モーダル ----
function openModal(titleHtml, bodyHtml, actionsHtml) {
  const overlay = document.getElementById('modal-overlay');
  const box = document.getElementById('modal-box');
  box.innerHTML = `
    <h2>${titleHtml}</h2>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-actions">${actionsHtml || ''}</div>
  `;
  overlay.classList.remove('hidden');
  return box;
}
function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
});

// ==========================================================================
// 6. ボトルNo. 採番 / 空き番号チェック
// ==========================================================================

function allocateBottleNo(type) {
  const max = maxNoFor(type);
  const occupied = new Set(
    APP.bottles.filter((b) => b.bottleType === type && b.status === 'active').map((b) => b.bottleNo)
  );
  for (let n = 1; n <= max; n++) {
    if (!occupied.has(n)) return n;
  }
  return null;
}

function isBottleNoFree(type, no, excludeBottleId) {
  return !APP.bottles.some(
    (b) => b.bottleType === type && b.bottleNo === no && b.status === 'active' && b.id !== excludeBottleId
  );
}

// ==========================================================================
// 7. 顧客重複検出
// ==========================================================================

function findDuplicateCandidates(name, kana) {
  const nName = BKUtil.normalizeName(name);
  const nKana = BKUtil.normalizeKana(kana);
  if (!nName && !nKana) return [];
  return APP.customers.filter((c) => {
    const cKana = BKUtil.normalizeKana(c.kana);
    const cName = BKUtil.normalizeName(c.name);
    if (nKana && cKana && nKana.length >= 2 && nKana === cKana) return true;
    if (nName && cName && nName === cName) return true;
    // 短い名前（例：「う」）が他の名前にたまたま含まれてしまう誤検出を防ぐため、
    // 部分一致は3文字以上の名前同士の場合のみ「同一人物の可能性あり」として扱う
    if (nName && cName && nName.length >= 3 && cName.length >= 3 && (cName.includes(nName) || nName.includes(cName))) return true;
    return false;
  });
}

// ==========================================================================
// 8. 画面：追加
// ==========================================================================

function listAvailableBottleNos(type) {
  const max = maxNoFor(type);
  const occupied = new Set(
    APP.bottles.filter((b) => b.bottleType === type && b.status === 'active').map((b) => b.bottleNo)
  );
  const avail = [];
  for (let n = 1; n <= max; n++) if (!occupied.has(n)) avail.push(n);
  return avail;
}

function rowFinalType(rowEl) {
  const typeSel = rowEl.querySelector('.row-bottleType');
  if (typeSel.value !== 'その他') return typeSel.value;
  const other = rowEl.querySelector('.row-bottleTypeOther').value.trim();
  return other || 'その他';
}

// 全ボトル行のボトルNo.プルダウンを再計算する。
// 同じフォーム内の他の行が同じ種類で選んでいる番号は候補から除外し、
// 二重に同じ番号が選ばれないようにする。
// select要素の中身だけを更新するため、他のテキスト欄の入力（IME含む）には影響しない。
function refreshAllRowBottleNoSelects(root) {
  const rowEls = [...root.querySelectorAll('.bottle-row')];

  const selectedByType = {};
  rowEls.forEach((rowEl) => {
    const type = rowFinalType(rowEl);
    const sel = rowEl.querySelector('.row-bottleNo');
    const val = sel.value ? Number(sel.value) : null;
    if (!selectedByType[type]) selectedByType[type] = {};
    if (val) selectedByType[type][rowEl.dataset.rowId] = val;
  });

  rowEls.forEach((rowEl) => {
    const type = rowFinalType(rowEl);
    const rowId = rowEl.dataset.rowId;
    const usedByOtherRows = new Set(
      Object.entries(selectedByType[type] || {}).filter(([rid]) => rid !== rowId).map(([, v]) => v)
    );
    const occupiedInDb = new Set(
      APP.bottles.filter((b) => b.bottleType === type && b.status === 'active').map((b) => b.bottleNo)
    );
    const max = maxNoFor(type);
    const avail = [];
    for (let n = 1; n <= max; n++) if (!occupiedInDb.has(n) && !usedByOtherRows.has(n)) avail.push(n);

    const sel = rowEl.querySelector('.row-bottleNo');
    const prevValue = sel.value ? Number(sel.value) : null;
    // 種類自体が変わった場合は、前の番号を引き継がず必ず一番小さい空き番号を選び直す
    const prevType = rowEl.dataset.prevType || null;
    const typeChanged = prevType !== null && prevType !== type;
    sel.innerHTML = avail.length === 0
      ? `<option value="">空き番号なし</option>`
      : avail.map((n) => `<option value="${n}">${n}</option>`).join('');
    if (avail.length > 0) {
      sel.value = (!typeChanged && prevValue && avail.includes(prevValue)) ? String(prevValue) : String(avail[0]);
    }
    sel.disabled = avail.length === 0;
    rowEl.dataset.prevType = type;
  });
}

function bottleRowHtml(rowId, index) {
  return `
  <div class="bottle-row" data-row-id="${rowId}">
    <div class="bottle-row__grid">
      <div class="form-field">
        <label>ボトル種類</label>
        <select class="row-bottleType">
          ${BOTTLE_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-field row-other-wrap hidden">
        <label>種類名（自由入力）</label>
        <input type="text" class="row-bottleTypeOther" placeholder="例：〇〇焼酎">
      </div>
      <div class="form-field">
        <label>ボトルNo.</label>
        <select class="row-bottleNo"></select>
      </div>
      <div class="form-field">
        <label>ボトル名</label>
        <input type="text" class="row-bottleName" placeholder="例：太郎と仲間たち">
      </div>
      <div class="form-field">
        <label>ボトル名（カナ）</label>
        <input type="text" class="row-bottleNameKana" placeholder="例：タロウトナカマタチ">
      </div>
      <div class="bottle-row__actions">
        <button type="button" class="btn btn-sm btn-ghost row-add">＋ボトル追加</button>
        <button type="button" class="btn btn-sm btn-ghost row-remove hidden">削除</button>
      </div>
    </div>
  </div>`;
}

function attachBottleRowEvents(root, rowEl) {
  const typeSelect = rowEl.querySelector('.row-bottleType');
  const otherInput = rowEl.querySelector('.row-bottleTypeOther');
  typeSelect.addEventListener('change', () => {
    rowEl.querySelector('.row-other-wrap').classList.toggle('hidden', typeSelect.value !== 'その他');
    refreshAllRowBottleNoSelects(root);
  });
  otherInput.addEventListener('input', () => refreshAllRowBottleNoSelects(root));
  rowEl.querySelector('.row-bottleNo').addEventListener('change', () => refreshAllRowBottleNoSelects(root));
  rowEl.querySelector('.row-add').addEventListener('click', () => addBottleRow(root));
  rowEl.querySelector('.row-remove').addEventListener('click', () => {
    rowEl.remove();
    updateRowIndexesAndRemoveButtons(root);
    refreshAllRowBottleNoSelects(root);
  });
}

function updateRowIndexesAndRemoveButtons(root) {
  const rowEls = [...root.querySelectorAll('.bottle-row')];
  rowEls.forEach((rowEl, i) => {
    rowEl.querySelector('.row-remove').classList.toggle('hidden', rowEls.length <= 1);
  });
}

function addBottleRow(root) {
  const container = root.querySelector('#bottle-rows');
  const rowId = BKUtil.uuid();
  const index = container.querySelectorAll('.bottle-row').length + 1;
  container.insertAdjacentHTML('beforeend', bottleRowHtml(rowId, index));
  const rowEl = container.querySelector(`[data-row-id="${rowId}"]`);
  attachBottleRowEvents(root, rowEl);
  refreshAllRowBottleNoSelects(root);
  updateRowIndexesAndRemoveButtons(root);
}

function renderAddScreen(root) {
  const prefillCustomerId = APP.addForm.prefillCustomerId || null;
  APP.addForm.prefillCustomerId = null; // 一度使ったら消費する
  APP.addForm.selectedCustomerId = prefillCustomerId;
  const today = BKUtil.todayJST();

  root.innerHTML = `
    <h2 class="screen-title">ボトル追加</h2>
    <div class="panel">
      <div class="form-grid">
        <div class="form-field">
          <label>来店日</label>
          <input type="date" id="f-visitDate" value="${today}" max="${today}">
          <p class="text-faint" id="f-visitDate-weekday" style="margin:4px 0 0;">（${BKUtil.weekdayLabel(today)}曜日）</p>
          <div class="form-error" id="err-visitDate"></div>
        </div>
      </div>

      <div class="bottle-rows-heading">ボトル</div>
      <div id="bottle-rows"></div>

      <div class="form-grid" style="margin-top:18px;">
        <div class="form-field">
          <label>お客様名</label>
          <input type="text" id="f-name" placeholder="山田太郎">
          <div class="form-error" id="err-name"></div>
        </div>
        <div class="form-field">
          <label>お客様名（カナ）</label>
          <input type="text" id="f-kana" placeholder="ヤマダタロウ">
        </div>
        <div class="form-field form-field--full" id="candidate-area"></div>
      </div>

      <div class="form-grid" style="margin-top:18px;">
        <div class="form-field form-field--full">
          <label>特徴・注意事項</label>
          <textarea id="f-memo" placeholder="カラオケ採点好き／地方から出張で"></textarea>
        </div>
        <div class="form-field">
          <label class="checkbox-field">
            <input type="checkbox" id="f-star">
            残す（★）3ヶ月経過後も破棄対象にしない
          </label>
        </div>
      </div>
      <div class="form-error" id="err-general" style="margin-top:10px;"></div>
      <div class="flex-row" style="margin-top:18px;">
        <button class="btn btn-primary" id="btn-submit">登録</button>
      </div>
    </div>
  `;

  const rowsContainer = root.querySelector('#bottle-rows');
  const firstRowId = BKUtil.uuid();
  rowsContainer.innerHTML = bottleRowHtml(firstRowId, 1);
  attachBottleRowEvents(root, rowsContainer.querySelector(`[data-row-id="${firstRowId}"]`));
  refreshAllRowBottleNoSelects(root);
  updateRowIndexesAndRemoveButtons(root);

  const nameInput = root.querySelector('#f-name');
  const kanaInput = root.querySelector('#f-kana');
  let nameTouched = false;
  let kanaTouched = false;

  if (prefillCustomerId) {
    const c = getCustomer(prefillCustomerId);
    if (c) {
      nameInput.value = c.name;
      kanaInput.value = c.kana;
      root.querySelector('#f-memo').value = c.memo || '';
      root.querySelector('#f-star').checked = !!c.star;
      root.querySelector('#candidate-area').innerHTML =
        `<div class="text-muted">${escapeHtml(c.name)} 様にボトルを追加します。（別のお客様として新規登録したい場合は、お名前を変更してください）</div>`;
      nameTouched = true;
      kanaTouched = true;
    } else {
      APP.addForm.selectedCustomerId = null;
    }
  }

  // お客様名・お客様名（カナ）は、1本目のボトル名・カナと同じ内容を自動入力する
  // （お客様名を一度でも手動で編集したら、以後は自動入力を止める）
  nameInput.addEventListener('input', () => { nameTouched = true; });
  kanaInput.addEventListener('input', () => { kanaTouched = true; });
  const firstRowEl = rowsContainer.querySelector(`[data-row-id="${firstRowId}"]`);
  const firstBottleNameInput = firstRowEl.querySelector('.row-bottleName');
  const firstBottleKanaInput = firstRowEl.querySelector('.row-bottleNameKana');
  firstBottleNameInput.addEventListener('input', () => {
    if (!nameTouched) nameInput.value = firstBottleNameInput.value;
  });
  firstBottleKanaInput.addEventListener('input', () => {
    if (!kanaTouched) kanaInput.value = firstBottleKanaInput.value;
  });

  const renderCandidates = () => {
    const candidates = findDuplicateCandidates(nameInput.value.trim(), kanaInput.value.trim());
    const area = root.querySelector('#candidate-area');
    if (!nameInput.value.trim() && !kanaInput.value.trim()) { area.innerHTML = ''; return; }
    if (candidates.length === 0) {
      APP.addForm.selectedCustomerId = null;
      area.innerHTML = '';
      return;
    }
    area.innerHTML = `
      <label>似た名前のお客様が見つかりました。どちらですか？</label>
      <div class="candidate-list">
        ${candidates.map((c) => `
          <div class="candidate-item">
            <span>${escapeHtml(c.name)}（${escapeHtml(c.kana)}） 所有ボトル${getActiveBottlesOf(c.id).length}本</span>
            <button class="btn btn-sm btn-ghost" data-pick-customer="${c.id}">この人にボトル追加</button>
          </div>
        `).join('')}
        <button class="btn btn-sm btn-ghost" data-pick-customer="__new__">別人として新規登録</button>
      </div>
      <div id="picked-note" class="text-muted" style="margin-top:6px;"></div>
    `;
    area.querySelectorAll('[data-pick-customer]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.dataset.pickCustomer;
        if (val === '__new__') {
          APP.addForm.selectedCustomerId = null;
          root.querySelector('#picked-note').textContent = '別人として新規登録します。';
        } else {
          APP.addForm.selectedCustomerId = val;
          const c = getCustomer(val);
          nameInput.value = c.name;
          kanaInput.value = c.kana;
          root.querySelector('#f-memo').value = c.memo || '';
          root.querySelector('#f-star').checked = !!c.star;
          root.querySelector('#picked-note').textContent = `${c.name} 様の顧客情報にボトルを追加します。`;
        }
      });
    });
  };
  nameInput.addEventListener('input', renderCandidates);
  kanaInput.addEventListener('input', renderCandidates);

  root.querySelector('#f-visitDate').addEventListener('change', (e) => {
    root.querySelector('#f-visitDate-weekday').textContent = e.target.value ? `（${BKUtil.weekdayLabel(e.target.value)}曜日）` : '';
  });
  root.querySelector('#btn-submit').addEventListener('click', () => handleAddSubmit(root));
}

async function handleAddSubmit(root) {
  const visitDate = root.querySelector('#f-visitDate').value;
  let name = root.querySelector('#f-name').value.trim();
  const kana = root.querySelector('#f-kana').value.trim();
  const memo = root.querySelector('#f-memo').value.trim();
  const star = root.querySelector('#f-star').checked;

  root.querySelector('#err-visitDate').textContent = '';
  root.querySelector('#err-name').textContent = '';
  root.querySelector('#err-general').textContent = '';
  let ok = true;

  if (!visitDate) { root.querySelector('#err-visitDate').textContent = '来店日を入力してください。'; ok = false; }
  else if (BKUtil.isFutureDate(visitDate)) { root.querySelector('#err-visitDate').textContent = '未来の日付は登録できません。'; ok = false; }

  // 登録直前の空き番号再チェック
  await refreshCache();
  refreshAllRowBottleNoSelects(root);

  const rowEls = [...root.querySelectorAll('.bottle-row')];
  const rows = rowEls.map((rowEl) => ({
    finalType: rowFinalType(rowEl),
    bottleNo: rowEl.querySelector('.row-bottleNo').value,
    bottleName: rowEl.querySelector('.row-bottleName').value.trim(),
    bottleNameKana: rowEl.querySelector('.row-bottleNameKana').value.trim(),
  }));

  // お客様名が未入力の場合は、1本目のボトル名をそのままお客様名として使う
  if (!name) {
    const fallback = rows.find((r) => r.bottleName);
    if (fallback) name = fallback.bottleName;
  }
  if (!name) { root.querySelector('#err-name').textContent = 'お客様名、またはボトル名のいずれかを入力してください。'; ok = false; }

  for (const row of rows) {
    if (!row.bottleNo) {
      root.querySelector('#err-general').textContent = `「${row.finalType}」に空き番号がありません。設定画面で番号の上限を見直してください。`;
      ok = false;
    }
  }
  // 同一フォーム内で種類・番号の組み合わせが重複していないか最終チェック
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.finalType}__${row.bottleNo}`;
    if (row.bottleNo && seen.has(key)) {
      root.querySelector('#err-general').textContent = `「${row.finalType}」の No.${row.bottleNo} が複数の行で選択されています。番号を選び直してください。`;
      ok = false;
    }
    seen.add(key);
  }
  if (!ok) return;

  for (const row of rows) {
    if (!isBottleNoFree(row.finalType, Number(row.bottleNo))) {
      root.querySelector('#err-general').textContent = `No.${row.bottleNo}（${row.finalType}）は他の操作で使用中になりました。番号を選び直してください。`;
      return;
    }
  }

  const now = BKUtil.nowISO();
  let customer;
  if (APP.addForm.selectedCustomerId) {
    customer = getCustomer(APP.addForm.selectedCustomerId);
    const before = { ...customer };
    customer.name = name;
    customer.kana = kana;
    customer.memo = memo;
    customer.star = star;
    customer.updatedAt = now;
    await APP.storage.putCustomer(customer);
    await logOperation('内容修正', 'customer', customer.id, before, customer, '追加画面からの顧客情報更新');
  } else {
    customer = { id: BKUtil.uuid(), name, kana, memo, star, createdAt: now, updatedAt: now };
    await APP.storage.putCustomer(customer);
    await logOperation('新規登録', 'customer', customer.id, null, customer);
  }

  const createdLabels = [];
  for (const row of rows) {
    const bottle = {
      id: BKUtil.uuid(),
      bottleNo: Number(row.bottleNo),
      bottleType: row.finalType,
      bottleName: row.bottleName,
      bottleNameKana: row.bottleNameKana,
      customerId: customer.id,
      status: 'active',
      lastVisitDate: visitDate,
      createdAt: now,
      updatedAt: now,
    };
    await APP.storage.putBottle(bottle);
    await logOperation('新規登録', 'bottle', bottle.id, null, bottle);
    createdLabels.push(`${row.finalType} No.${row.bottleNo}`);
  }

  // 来店履歴（同日重複防止）
  const existingVisit = APP.visits.find((v) => v.customerId === customer.id && v.visitDate === visitDate);
  if (!existingVisit) {
    const visit = { id: BKUtil.uuid(), customerId: customer.id, visitDate, createdAt: now };
    await APP.storage.putVisit(visit);
  }

  await refreshCache();
  showToast(`${rows.length}本登録しました（${createdLabels.join('、')}）`);
  renderScreen('add');
}

// ==========================================================================
// 9. 来店登録（顧客単位・共通処理）
// ==========================================================================

function openCustomerBottlesModal(customerId) {
  const customer = getCustomer(customerId);
  const bottles = getActiveBottlesOf(customerId);
  const body = `
    <p class="text-muted">${escapeHtml(customer.kana)}</p>
    ${customer.memo ? `<p class="text-muted">特徴・注意事項：${escapeHtml(customer.memo)}</p>` : ''}
    <div class="table-wrap" style="margin-top:12px;">
      <table class="data-table">
        <thead><tr><th>ボトルNo.</th><th>ボトル名</th><th>ボトル名（カナ）</th><th>最終来店日</th></tr></thead>
        <tbody>
          ${bottles.map((b) => `
            <tr>
              <td>${bottleTagHtml(b)}</td>
              <td>${escapeHtml(b.bottleName)}</td>
              <td class="text-muted">${escapeHtml(b.bottleNameKana)}</td>
              <td>${BKUtil.displayDate(b.lastVisitDate)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  const actions = `<button class="btn btn-ghost" id="m-close">閉じる</button>`;
  const box = openModal(`${escapeHtml(customer.name)} 様の所有ボトル（${bottles.length}本）`, body, actions);
  box.querySelector('#m-close').addEventListener('click', closeModal);
}

function openVisitModal(customerId) {
  const customer = getCustomer(customerId);
  const bottles = getActiveBottlesOf(customerId);
  const today = BKUtil.todayJST();

  const body = `
    <p>${escapeHtml(customer.name)}${customer.kana ? ` 様（${escapeHtml(customer.kana)}）` : ' 様'}の以下 <b>${bottles.length}本</b> のボトルの最終来店日を更新します。</p>
    <ul>${bottles.map((b) => `<li>${escapeHtml(b.bottleType)} No.${b.bottleNo}</li>`).join('')}</ul>
    ${customer.memo ? `<p class="text-muted" style="margin-top:8px;"><b>特徴・注意事項：</b>${escapeHtml(customer.memo)}</p>` : ''}
    <div class="form-field">
      <label>来店日</label>
      <input type="date" id="m-visitDate" value="${today}" max="${today}">
    </div>
  `;
  const actions = `
    <button class="btn btn-ghost" id="m-cancel">キャンセル</button>
    <button class="btn btn-visit" id="m-confirm">来店登録する</button>
  `;
  const box = openModal('来店登録の確認', body, actions);
  box.querySelector('#m-cancel').addEventListener('click', closeModal);
  box.querySelector('#m-confirm').addEventListener('click', async () => {
    const date = box.querySelector('#m-visitDate').value;
    if (!date) return;
    if (BKUtil.isFutureDate(date)) { showToast('未来の日付は登録できません。', 'error'); return; }
    await registerVisit(customerId, date);
    closeModal();
  });
}

// 顧客が所有する全ての有効ボトルの最終来店日を更新する（画面遷移やトースト表示は行わない）
async function applyVisitDateToBottles(customerId, visitDate) {
  const bottles = getActiveBottlesOf(customerId);
  const now = BKUtil.nowISO();
  for (const bottle of bottles) {
    const before = { ...bottle };
    bottle.lastVisitDate = visitDate;
    bottle.updatedAt = now;
    await APP.storage.putBottle(bottle);
    await logOperation('来店登録', 'bottle', bottle.id, before, bottle);
  }
  const existingVisit = APP.visits.find((v) => v.customerId === customerId && v.visitDate === visitDate);
  if (!existingVisit) {
    const visit = { id: BKUtil.uuid(), customerId, visitDate, createdAt: now };
    await APP.storage.putVisit(visit);
  }
  return bottles.length;
}

async function registerVisit(customerId, visitDate) {
  const count = await applyVisitDateToBottles(customerId, visitDate);
  await refreshCache();
  showToast(`${count}本のボトルの最終来店日を更新しました`);
  renderScreen(APP.currentScreen);
}

// ==========================================================================
// 10. 共通：検索バー
// ==========================================================================

function searchBarHtml(options = {}) {
  const f = APP.filters;
  const showType = options.showType !== false;
  return `
  <div class="search-bar">
    <div class="search-bar__field search-bar__field--grow">
      <label>フリーワード検索</label>
      <input type="text" id="flt-freeword" placeholder="お客様名、ボトル名など" value="${escapeHtml(f.freeword)}">
    </div>
    <div class="search-bar__field">
      <label>ボトル番号</label>
      <input type="text" id="flt-bottleNo" placeholder="No." value="${escapeHtml(f.bottleNo)}">
    </div>
    ${showType ? `
    <div class="search-bar__field">
      <label>ボトル種類</label>
      <select id="flt-bottleType">
        <option value="">すべて</option>
        ${BOTTLE_TYPES.map((t) => `<option value="${t}" ${f.bottleType === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
    </div>` : ''}
    <div class="search-bar__field">
      <label>最終来店日</label>
      <input type="month" id="flt-yearMonth" value="${f.yearMonth}">
    </div>
    <div class="search-bar__field">
      <label>★残し</label>
      <select id="flt-star">
        <option value="">すべて</option>
        <option value="true" ${f.star === 'true' ? 'selected' : ''}>★のみ</option>
        <option value="false" ${f.star === 'false' ? 'selected' : ''}>★以外</option>
      </select>
    </div>
    <div class="search-bar__field">
      <label>状態</label>
      <select id="flt-status">
        <option value="">すべて</option>
        <option value="normal" ${f.status === 'normal' ? 'selected' : ''}>通常</option>
        <option value="near" ${f.status === 'near' ? 'selected' : ''}>まもなく破棄対象</option>
        <option value="target" ${f.status === 'target' ? 'selected' : ''}>破棄対象</option>
        <option value="star" ${f.status === 'star' ? 'selected' : ''}>★のため保管継続</option>
      </select>
    </div>
    <button class="btn btn-sm btn-ghost" id="flt-clear">クリア</button>
  </div>`;
}

// 注意：ここでの onChange は「検索バー自体」ではなく、結果一覧部分のみを再描画する関数を渡すこと。
// 検索バーごと再描画してしまうと、日本語入力（IME）の変換途中でフォーカスが失われ、
// 1文字目で入力が止まってしまう不具合の原因になるため。
function attachSearchBarEvents(root, onChange) {
  const bind = (id, key) => {
    const el = root.querySelector(id);
    if (!el) return;
    el.addEventListener('input', () => { APP.filters[key] = el.value; onChange(); });
  };
  bind('#flt-freeword', 'freeword');
  bind('#flt-bottleNo', 'bottleNo');
  bind('#flt-bottleType', 'bottleType');
  bind('#flt-yearMonth', 'yearMonth');
  bind('#flt-star', 'star');
  bind('#flt-status', 'status');
  const clearBtn = root.querySelector('#flt-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      APP.filters = { freeword: '', bottleType: '', bottleNo: '', yearMonth: '', star: '', status: '' };
      renderScreen(APP.currentScreen);
    });
  }
}

// フリーワードが、お客様名／フリガナ／ボトル名／ボトル名（カナ）のいずれかに
// 部分一致（前方・後方・中間、すべて含む）するかを判定する
function matchesFreeword(freeword, name, kana, bottleName, bottleNameKana, memo) {
  if (!freeword) return true;
  const q = freeword.trim();
  if (!q) return true;
  const qKana = BKUtil.normalizeKana(q);
  if (BKUtil.includesPartial(name, q)) return true;
  if (BKUtil.includesPartial(bottleName, q)) return true;
  if (BKUtil.includesPartial(memo, q)) return true;
  if (qKana && BKUtil.normalizeKana(kana).includes(qKana)) return true;
  if (qKana && BKUtil.normalizeKana(bottleNameKana).includes(qKana)) return true;
  return false;
}

function bottleMatchesFilters(bottle, customer) {
  const f = APP.filters;
  if (!matchesFreeword(f.freeword, customer.name, customer.kana, bottle.bottleName, bottle.bottleNameKana, customer.memo)) return false;
  if (f.bottleType && bottle.bottleType !== f.bottleType) return false;
  if (f.bottleNo && String(bottle.bottleNo) !== String(f.bottleNo).trim()) return false;
  if (f.yearMonth && BKUtil.toYearMonth(bottle.lastVisitDate) !== f.yearMonth) return false;
  if (f.star === 'true' && !customer.star) return false;
  if (f.star === 'false' && customer.star) return false;
  if (f.status) {
    const st = computeStatus(bottle, customer);
    if (st.key !== f.status) return false;
  }
  return true;
}

// ==========================================================================
// 11. 画面：管理（ボトル毎）
// ==========================================================================

function renderManageBottleScreen(root) {
  root.innerHTML = `
    <h2 class="screen-title">ボトル検索 <span class="count-badge" id="mb-count">0件</span>
      <button class="btn btn-sm btn-ghost" id="btn-toggle-simple-bottle" style="margin-left:auto;">${APP.settings.simpleModeBottle ? '詳細表示にする' : 'シンプル表示にする'}</button>
    </h2>
    ${searchBarHtml({ showType: APP.manageBottleTab === ALL_TYPES_TAB })}
    <div id="mb-body"></div>
  `;
  attachSearchBarEvents(root, () => renderManageBottleBody(root));
  renderManageBottleBody(root);
  root.querySelector('#btn-toggle-simple-bottle').addEventListener('click', async () => {
    APP.settings.simpleModeBottle = !APP.settings.simpleModeBottle;
    await APP.storage.putSettings(APP.settings);
    renderManageBottleScreen(root);
  });
}

function renderManageBottleBody(root) {
  const list = APP.bottles
    .filter((b) => b.status === 'active' && (APP.manageBottleTab === ALL_TYPES_TAB || b.bottleType === APP.manageBottleTab))
    .map((b) => ({ bottle: b, customer: getCustomer(b.customerId) }))
    .filter(({ bottle, customer }) => bottleMatchesFilters(bottle, customer));

  const sortKey = APP.sort.manageBottle?.key || 'bottleNo';
  const sortDir = APP.sort.manageBottle?.dir || 'asc';
  sortRows(list, sortKey, sortDir, (row) => rowSortValue(row, sortKey));

  root.querySelector('#mb-count').textContent = `${list.length}件`;
  const body = root.querySelector('#mb-body');
  body.innerHTML = `
    <div class="tab-bar">
      <div class="tab-bar__item ${APP.manageBottleTab === ALL_TYPES_TAB ? 'is-active' : ''}" data-tab="${ALL_TYPES_TAB}">すべて（${APP.bottles.filter((b) => b.status === 'active').length}）</div>
      ${BOTTLE_TYPES.map((t) => {
        const cnt = APP.bottles.filter((b) => b.status === 'active' && b.bottleType === t).length;
        return `<div class="tab-bar__item ${APP.manageBottleTab === t ? 'is-active' : ''}" data-tab="${t}">${t}（${cnt}）</div>`;
      }).join('')}
    </div>
    <div class="table-wrap is-cardable ${APP.settings.simpleModeBottle ? 'is-simple' : ''}">
      <table class="data-table data-table--fixed">
        <colgroup>
          ${APP.settings.simpleModeBottle ? `
          <col style="width:88px"><col style="width:150px"><col style="width:32%"><col style="width:68%"><col style="width:86px">
          ` : `
          <col style="width:88px"><col style="width:150px"><col style="width:22%"><col style="width:24%"><col style="width:112px"><col style="width:54%"><col style="width:100px"><col style="width:86px">
          `}
        </colgroup>
        <thead><tr>
          ${APP.settings.simpleModeBottle ? `
          <th></th>
          <th data-sort="bottleNo">ボトルNo.</th>
          <th>ボトル名</th>
          <th data-sort="name">お客様名</th>
          <th>操作</th>
          ` : `
          <th></th>
          <th data-sort="bottleNo">ボトルNo.</th>
          <th>ボトル名</th>
          <th data-sort="name">お客様名</th>
          <th data-sort="lastVisitDate">最終来店日</th>
          <th>特徴・注意事項</th>
          <th>状態</th>
          <th>操作</th>
          `}
        </tr></thead>
        <tbody>
          ${list.length === 0 ? '' : list.map(({ bottle, customer }) => {
            const status = computeStatus(bottle, customer);
            if (APP.settings.simpleModeBottle) {
              return `
              <tr>
                <td data-label=""><button class="btn btn-sm btn-visit" data-visit="${customer.id}">来店</button></td>
                <td data-label="ボトルNo.">${bottleTagHtml(bottle)}</td>
                <td class="text-muted" data-label="ボトル名">${bottleNameCellHtml(bottle.bottleName, bottle.bottleNameKana)}</td>
                <td data-label="お客様名"><button class="customer-link" data-customer-bottles="${customer.id}">${escapeHtml(customer.name)}</button></td>
                <td class="flex-row" data-label="操作">
                  <button class="btn btn-sm btn-ghost" data-view="${bottle.id}">閲覧</button>
                </td>
              </tr>`;
            }
            return `
            <tr>
              <td data-label=""><button class="btn btn-sm btn-visit" data-visit="${customer.id}">来店</button></td>
              <td data-label="ボトルNo.">${bottleTagHtml(bottle)}</td>
              <td class="text-muted" data-label="ボトル名">${bottleNameCellHtml(bottle.bottleName, bottle.bottleNameKana)}</td>
              <td data-label="お客様名">
                <button class="customer-link" data-customer-bottles="${customer.id}">${escapeHtml(customer.name)}</button> ${starHtml(customer)}<br>
                <span class="text-faint" style="font-size:12px;">${escapeHtml(customer.kana)}</span>
              </td>
              <td class="date-cell-compact" data-label="最終来店日">${BKUtil.displayDateBroken(bottle.lastVisitDate)}</td>
              <td class="text-muted" data-label="特徴・注意事項">${escapeHtml(customer.memo)}</td>
              <td data-label="状態"><span class="status-pill ${status.cls}">${status.label}</span></td>
              <td class="flex-row" data-label="操作">
                <button class="btn btn-sm btn-ghost" data-view="${bottle.id}">閲覧</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${list.length === 0 ? '<div class="empty-state">該当するボトルがありません</div>' : ''}
    </div>
  `;

  body.querySelectorAll('[data-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      APP.manageBottleTab = el.dataset.tab;
      if (APP.manageBottleTab !== ALL_TYPES_TAB) APP.filters.bottleType = '';
      renderManageBottleScreen(root);
    });
  });
  body.querySelectorAll('[data-visit]').forEach((el) => el.addEventListener('click', () => openVisitModal(el.dataset.visit)));
  body.querySelectorAll('[data-customer-bottles]').forEach((el) => el.addEventListener('click', () => openCustomerBottlesModal(el.dataset.customerBottles)));
  body.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => { APP.detailBottleId = el.dataset.view; APP.detailMode = 'view'; renderScreen('detail'); }));
  body.querySelectorAll('[data-sort]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.sort;
      const cur = APP.sort.manageBottle || {};
      APP.sort.manageBottle = { key, dir: cur.key === key && cur.dir === 'asc' ? 'desc' : 'asc' };
      renderManageBottleBody(root);
    });
  });
}

function rowSortValue(row, key) {
  if (key === 'name') return row.customer.name;
  if (key === 'kana') return row.customer.kana;
  if (key === 'lastVisitDate') return row.bottle.lastVisitDate;
  return row.bottle[key];
}

function sortRows(rows, key, dir, valueFn) {
  rows.sort((a, b) => {
    const va = valueFn(a), vb = valueFn(b);
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

// ==========================================================================
// 12. 画面：管理（名前毎）
// ==========================================================================

function renderManageCustomerScreen(root) {
  root.innerHTML = `
    <h2 class="screen-title">顧客管理 <span class="count-badge" id="mc-count">0名</span>
      <button class="btn btn-sm btn-ghost" id="btn-toggle-simple-customer" style="margin-left:auto;">${APP.settings.simpleModeCustomer ? '詳細表示にする' : 'シンプル表示にする'}</button>
    </h2>
    ${searchBarHtml()}
    <div id="mc-body"></div>
  `;
  attachSearchBarEvents(root, () => renderManageCustomerBody(root));
  renderManageCustomerBody(root);
  root.querySelector('#btn-toggle-simple-customer').addEventListener('click', async () => {
    APP.settings.simpleModeCustomer = !APP.settings.simpleModeCustomer;
    await APP.storage.putSettings(APP.settings);
    renderManageCustomerScreen(root);
  });
}

function renderManageCustomerBody(root) {
  const rows = APP.customers
    .map((c) => ({ customer: c, bottles: getActiveBottlesOf(c.id) }))
    .filter((r) => r.bottles.length > 0)
    .filter((r) => r.bottles.some((b) => bottleMatchesFilters(b, r.customer)));

  rows.forEach((r) => {
    r.lastVisitDate = r.bottles.reduce((max, b) => (b.lastVisitDate > max ? b.lastVisitDate : max), '0000-00-00');
    r.visitCount = APP.visits.filter((v) => v.customerId === r.customer.id).length;
  });

  const sortKey = APP.sort.manageCustomer?.key || 'visitCount';
  const sortDir = APP.sort.manageCustomer?.dir || 'desc';
  rows.sort((a, b) => {
    const va = sortKey === 'name' ? a.customer.name : sortKey === 'kana' ? a.customer.kana : sortKey === 'visitCount' ? a.visitCount : a.lastVisitDate;
    const vb = sortKey === 'name' ? b.customer.name : sortKey === 'kana' ? b.customer.kana : sortKey === 'visitCount' ? b.visitCount : b.lastVisitDate;
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  root.querySelector('#mc-count').textContent = `${rows.length}名`;
  const body = root.querySelector('#mc-body');
  body.innerHTML = `
    <div class="table-wrap is-cardable ${APP.settings.simpleModeCustomer ? 'is-simple' : ''}">
      <table class="data-table data-table--fixed">
        <colgroup>
          ${APP.settings.simpleModeCustomer ? `
          <col style="width:88px"><col style="width:26%"><col style="width:74%"><col style="width:86px">
          ` : `
          <col style="width:88px"><col style="width:26%"><col style="width:112px"><col style="width:70px"><col style="width:36%"><col style="width:86px">
          `}
        </colgroup>
        <thead><tr>
          ${APP.settings.simpleModeCustomer ? `
          <th></th>
          <th data-sort="name">お客様名</th>
          <th>所有ボトル</th>
          <th>操作</th>
          ` : `
          <th></th>
          <th data-sort="name">お客様名</th>
          <th data-sort="lastVisitDate">最終来店日</th>
          <th>本数</th>
          <th>所有ボトル</th>
          <th>操作</th>
          `}
        </tr></thead>
        <tbody>
        ${rows.map(({ customer, bottles, lastVisitDate }) => APP.settings.simpleModeCustomer ? `
          <tr>
            <td data-label=""><button class="btn btn-sm btn-visit" data-visit="${customer.id}">来店</button></td>
            <td data-label="お客様名"><button class="customer-link" data-customer-bottles="${customer.id}">${escapeHtml(customer.name)}</button></td>
            <td data-label="所有ボトル">${bottles.map((b) => bottleTagHtml(b)).join(' ')}</td>
            <td class="flex-row" data-label="操作">
              <button class="btn btn-sm btn-ghost" data-view="${bottles[0].id}">閲覧</button>
            </td>
          </tr>
        ` : `
          <tr>
            <td data-label=""><button class="btn btn-sm btn-visit" data-visit="${customer.id}">来店</button></td>
            <td data-label="お客様名">
              <button class="customer-link" data-customer-bottles="${customer.id}">${escapeHtml(customer.name)}</button> ${starHtml(customer)}<br>
              <span class="text-faint" style="font-size:12px;">${escapeHtml(customer.kana)}</span>
            </td>
            <td class="date-cell-compact" data-label="最終来店日">${BKUtil.displayDateBroken(lastVisitDate)}</td>
            <td data-label="本数">${bottles.length}本</td>
            <td data-label="所有ボトル">${bottles.map((b) => `${bottleTagHtml(b)}${b.bottleName ? ` <span class="text-muted">「${escapeHtml(b.bottleName)}」</span>` : ''}`).join('<br>')}</td>
            <td class="flex-row" data-label="操作">
              <button class="btn btn-sm btn-ghost" data-view="${bottles[0].id}">閲覧</button>
            </td>
          </tr>
        `).join('')}
        </tbody>
      </table>
      ${rows.length === 0 ? '<div class="empty-state">該当するお客様がいません</div>' : ''}
    </div>
  `;

  body.querySelectorAll('[data-visit]').forEach((el) => el.addEventListener('click', () => openVisitModal(el.dataset.visit)));
  body.querySelectorAll('[data-customer-bottles]').forEach((el) => el.addEventListener('click', () => openCustomerBottlesModal(el.dataset.customerBottles)));
  body.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => { APP.detailBottleId = el.dataset.view; APP.detailMode = 'view'; renderScreen('detail'); }));
  body.querySelectorAll('[data-sort]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.dataset.sort;
      const cur = APP.sort.manageCustomer || {};
      APP.sort.manageCustomer = { key, dir: cur.key === key && cur.dir === 'asc' ? 'desc' : 'asc' };
      renderManageCustomerBody(root);
    });
  });
}

// ==========================================================================
// 13.5 画面：統合
// ==========================================================================

// 統合候補を検出する：
// ・名前やフリガナが同じ／似ている別々のお客様
// ・特徴・注意事項に「◯番」のようにボトル番号への言及があり、
//   実際にその番号のボトルが別のお客様として登録されている場合
// 統合候補をペア（2人ずつ）で検出する。
// ※以前グループ化（3人以上をまとめて1件に）を試したが、似た名前が連鎖してしまうと
//   無関係な人まで同じグループに引き込まれてしまい、また「まとめて統合」しかできず
//   一部の人だけを統合したい場合に対応できなかったため、ペア表示に戻している。
function mergePairKey(idA, idB) {
  return [idA, idB].sort().join('__');
}
// スペース（半角・全角）区切りで、名前に含まれる「人数」を数える
// （例：「けんた　たつや　まさと」は3、「みっちゃん」は1）
function nameTokenCount(name) {
  if (!name) return 0;
  return name.split(/[\s　]+/).filter((s) => s.length > 0).length;
}
function groupKey(memberIds) {
  return [...memberIds].sort().join('__');
}

// Union-Find：連結している（＝どこかで一致・類似と判定された）お客様同士を1つのグループにまとめる
class MergeDSU {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }
  find(x) {
    while (this.parent.get(x) !== x) {
      this.parent.set(x, this.parent.get(this.parent.get(x)));
      x = this.parent.get(x);
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function findMergeCandidateGroups() {
  const withBottles = APP.customers.filter((c) => getActiveBottlesOf(c.id).length > 0);
  const ids = withBottles.map((c) => c.id);
  const dsu = new MergeDSU(ids);
  const edgeReasons = new Map(); // pairKey -> Set(reason)

  function addEdge(aId, bId, reason) {
    dsu.union(aId, bId);
    const key = mergePairKey(aId, bId);
    if (!edgeReasons.has(key)) edgeReasons.set(key, new Set());
    edgeReasons.get(key).add(reason);
  }

  for (let i = 0; i < withBottles.length; i++) {
    for (let j = i + 1; j < withBottles.length; j++) {
      const a = withBottles[i];
      const b = withBottles[j];
      const kanaA = BKUtil.normalizeKana(a.kana);
      const kanaB = BKUtil.normalizeKana(b.kana);
      const nameA = BKUtil.normalizeName(a.name);
      const nameB = BKUtil.normalizeName(b.name);
      // 「けんた」と「けんた　たつや　まさと　たいよう」のような団体名義との誤マッチを防ぐため、
      // スペース区切りの人数（名前の数）が同じ同士のみを比較対象とする
      const tokensA = nameTokenCount(a.name);
      const tokensB = nameTokenCount(b.name);
      let reason = null;
      if (tokensA === tokensB) {
        if (kanaA && kanaB && kanaA.length >= 2 && kanaA === kanaB) reason = 'フリガナ【一致】';
        else if (nameA && nameB && nameA.length >= 2 && nameA === nameB) reason = 'お客様名【一致】';
        // 短い一致（「さん」等）による誤検出を避けるため、3文字以上の一致のみ「似た名前」として扱う
        else if (nameA.length >= 3 && nameB.length >= 3 && (nameA.includes(nameB) || nameB.includes(nameA))) reason = 'お客様名【類似】';
      }
      if (reason) addEdge(a.id, b.id, reason);
    }
  }

  const numberMentionRegex = /(\d{1,4})\s*番/g;
  for (const c of withBottles) {
    if (!c.memo) continue;
    // 言及されている番号は、そのお客様が既に持っているボトル種類の範囲内でのみ探す
    // （種類ごとに番号が独立しているため、無関係な種類まで対象にすると誤検出が増える）
    const ownedTypes = new Set(getActiveBottlesOf(c.id).map((b) => b.bottleType));
    const matches = [...c.memo.matchAll(numberMentionRegex)];
    for (const m of matches) {
      const mentionedNo = Number(m[1]);
      const mentionedBottles = APP.bottles.filter(
        (b) => b.status === 'active' && b.bottleNo === mentionedNo && b.customerId !== c.id && ownedTypes.has(b.bottleType)
      );
      for (const b of mentionedBottles) {
        const other = getCustomer(b.customerId);
        if (!other) continue;
        addEdge(c.id, other.id, `特徴・注意事項【${mentionedNo}番の記載】（${b.bottleType} No.${mentionedNo} を所有）`);
      }
    }
  }

  const dismissed = new Set(APP.settings.dismissedMergePairs || []);
  const groupsByRoot = new Map();
  for (const id of ids) {
    const root = dsu.find(id);
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, new Set());
    groupsByRoot.get(root).add(id);
  }

  const results = [];
  for (const idSet of groupsByRoot.values()) {
    if (idSet.size < 2) continue;
    const key = groupKey(idSet);
    if (dismissed.has(key)) continue;
    const members = [...idSet].map((id) => getCustomer(id));
    const reasonsSet = new Set();
    for (const [pairKey, reasons] of edgeReasons.entries()) {
      const [x, y] = pairKey.split('__');
      if (idSet.has(x) && idSet.has(y)) reasons.forEach((r) => reasonsSet.add(r));
    }
    results.push({ members, reasons: [...reasonsSet], key });
  }
  // ボトル本数の多い順（影響が大きい候補を上に）
  results.sort((a, b) => {
    const countA = a.members.reduce((s, m) => s + getActiveBottlesOf(m.id).length, 0);
    const countB = b.members.reduce((s, m) => s + getActiveBottlesOf(m.id).length, 0);
    return countB - countA;
  });
  return results;
}

// このグループ（メンバーの組み合わせ）を「統合しない」として今後は候補に出さないようにする。
// メンバー構成が変わる（別の人が加わる等）と別のグループとして再度表示される。
async function dismissMergeGroup(memberIds) {
  const key = groupKey(memberIds);
  const dismissed = new Set(APP.settings.dismissedMergePairs || []);
  dismissed.add(key);
  APP.settings.dismissedMergePairs = [...dismissed];
  await APP.storage.putSettings(APP.settings);
  showToast('この組み合わせは今後表示されません');
  renderScreen('merge');
}

// members のうち、最もボトル数の多い1人を軸（anchor）にして、
// 残り（チェックが入っている人のみ）のボトルをそちらへ付け替える
async function mergeCustomerGroup(memberIds, newName, newKana) {
  const members = memberIds.map((id) => getCustomer(id));
  const anchor = members.reduce((best, m) =>
    getActiveBottlesOf(m.id).length > getActiveBottlesOf(best.id).length ? m : best
  );
  const now = BKUtil.nowISO();
  let movedCount = 0;
  for (const m of members) {
    if (m.id === anchor.id) continue;
    const bottles = getActiveBottlesOf(m.id);
    for (const bottle of bottles) {
      const before = { ...bottle };
      bottle.customerId = anchor.id;
      bottle.updatedAt = now;
      await APP.storage.putBottle(bottle);
      await logOperation('内容修正', 'bottle', bottle.id, before, bottle, `統合：${m.name} 様 → ${anchor.name} 様へ付け替え`);
      movedCount++;
    }
  }
  const beforeCustomer = { ...anchor };
  anchor.name = newName;
  anchor.kana = newKana;
  anchor.updatedAt = now;
  await APP.storage.putCustomer(anchor);
  await logOperation('内容修正', 'customer', anchor.id, beforeCustomer, anchor, '統合による名称更新');

  await refreshCache();
  await syncCustomerLastVisitToLatest(anchor.id);
  await refreshCache();
  showToast(`${members.length}人を「${newName}」様に統合しました`);
  renderScreen('merge');
}

function openMergeGroupModal(memberIds) {
  const members = memberIds.map((id) => getCustomer(id));
  const anchor = members.reduce((best, m) =>
    getActiveBottlesOf(m.id).length > getActiveBottlesOf(best.id).length ? m : best
  );

  const body = `
    <p>統合するメンバーを選んでください（チェックを外すと、その方は今回の統合から除外されます）。</p>
    <div class="candidate-list" style="margin-bottom:12px;">
      ${members.map((m) => `
        <label class="checkbox-field" style="width:100%; align-items:flex-start; padding:6px 4px; border-bottom:1px solid var(--color-border-soft);">
          <input type="checkbox" class="mgm-member-check" data-member="${m.id}" checked>
          <span>
            <b>${escapeHtml(m.name)}</b>（${escapeHtml(m.kana)}）・所有${getActiveBottlesOf(m.id).length}本<br>
            <span class="text-muted" style="font-size:13px;">${getActiveBottlesOf(m.id).map((b) => `${bottleTagHtml(b)}${b.bottleName ? `「${escapeHtml(b.bottleName)}」` : ''}`).join(' ')}</span>
          </span>
        </label>
      `).join('')}
    </div>
    <div class="form-field">
      <label>統合後のお客様名</label>
      <input type="text" id="mgm-name" value="${escapeHtml(anchor.name)}">
    </div>
    <div class="form-field">
      <label>統合後のフリガナ</label>
      <input type="text" id="mgm-kana" value="${escapeHtml(anchor.kana)}">
    </div>
    <p class="text-muted" style="margin-top:10px;" id="mgm-total"></p>
  `;
  const actions = `
    <button class="btn btn-ghost" id="m-cancel">キャンセル</button>
    <button class="btn btn-primary" id="m-confirm">統合する</button>
  `;
  const box = openModal('統合の確認', body, actions);

  function recomputeTotal() {
    const checked = [...box.querySelectorAll('.mgm-member-check:checked')].map((el) => el.dataset.member);
    const total = checked.reduce((s, id) => s + getActiveBottlesOf(id).length, 0);
    box.querySelector('#mgm-total').textContent = `選択中：${checked.length}人・統合後の所有ボトル：${total}本`;
  }
  box.querySelectorAll('.mgm-member-check').forEach((el) => el.addEventListener('change', recomputeTotal));
  recomputeTotal();

  box.querySelector('#m-cancel').addEventListener('click', closeModal);
  box.querySelector('#m-confirm').addEventListener('click', async () => {
    const checkedIds = [...box.querySelectorAll('.mgm-member-check:checked')].map((el) => el.dataset.member);
    if (checkedIds.length < 2) { showToast('統合するには2人以上選択してください', 'error'); return; }
    const newName = box.querySelector('#mgm-name').value.trim();
    const newKana = box.querySelector('#mgm-kana').value.trim();
    if (!newName) { showToast('お客様名を入力してください', 'error'); return; }
    await mergeCustomerGroup(checkedIds, newName, newKana);
    closeModal();
  });
}

function renderMergeScreen(root) {
  const groups = findMergeCandidateGroups();

  root.innerHTML = `
    <h2 class="screen-title">統合 <span class="count-badge">候補 ${groups.length}件</span></h2>
    <p class="text-muted">別々に登録されているお客様を、1人のお客様としてまとめます。名前・ボトルをタップすると詳細が確認できます。</p>

    <div class="panel">
      <h3 class="mt-0">統合候補</h3>
      ${groups.length === 0 ? '<p class="text-muted">現在、統合候補は見つかっていません。</p>' : `
      <div class="candidate-list">
        ${groups.map((g, i) => {
          const totalBottles = g.members.reduce((s, m) => s + getActiveBottlesOf(m.id).length, 0);
          const nameLabel = [...new Set(g.members.map((m) => `${m.name}${m.kana ? `（${m.kana}）` : ''}`))].join(' ／ ');
          const bottleRows = g.members.flatMap((m) => getActiveBottlesOf(m.id).map((b) => `
            <div style="padding:2px 0;">
              <button class="customer-link" data-view-customer="${m.id}">${bottleTagHtml(b)}${b.bottleName ? `「${escapeHtml(b.bottleName)}」` : ''}</button>
            </div>
          `)).join('');
          return `
          <div class="candidate-item" style="align-items:flex-start;">
            <div>
              <div><b>${escapeHtml(nameLabel)}</b>　所有${totalBottles}本</div>
              <div style="margin-top:4px; padding-left:8px;">${bottleRows}</div>
              <div class="text-faint" style="font-size:13px; margin-top:6px;">${g.reasons.map(escapeHtml).join(' ／ ')}</div>
            </div>
            <div class="flex-row">
              <button class="btn btn-sm btn-ghost" data-dismiss="${i}">統合しない</button>
              <button class="btn btn-sm btn-primary" data-candidate="${i}">統合する</button>
            </div>
          </div>
        `;
        }).join('')}
      </div>
      `}
    </div>

    <div class="panel">
      <h3 class="mt-0">手動で統合</h3>
      <p class="text-muted">「統合するボトル」と「統合先のボトル」を、それぞれ検索して選んでください。統合先の現在のお客様名が自動入力されます。</p>

      <div class="form-field form-field--full">
        <label>統合するボトルを検索</label>
        <input type="text" id="mg-source-search" placeholder="お客様名、ボトル名など">
      </div>
      <div id="mg-source-results"></div>
      <div id="mg-source-selected" class="text-muted" style="margin-top:6px;"></div>

      <div class="text-muted" style="margin:14px 0 6px; font-weight:700;">↓ 統合先</div>

      <div class="form-field form-field--full">
        <label>統合先のボトルを検索</label>
        <input type="text" id="mg-target-search" placeholder="お客様名、ボトル名など">
      </div>
      <div id="mg-target-results"></div>
      <div id="mg-target-selected" class="text-muted" style="margin-top:6px;"></div>

      <div class="form-grid" style="margin-top:12px;">
        <div class="form-field">
          <label>統合後のお客様名</label>
          <input type="text" id="mg-finalName" placeholder="統合先ボトルを選ぶと自動入力されます">
        </div>
        <div class="form-field">
          <label>統合後のフリガナ</label>
          <input type="text" id="mg-finalKana">
        </div>
      </div>
      <div class="flex-row" style="margin-top:16px;">
        <button class="btn btn-primary" id="mg-submit">統合する</button>
      </div>
    </div>
  `;

  groups.forEach((g, i) => {
    root.querySelector(`[data-candidate="${i}"]`).addEventListener('click', () => {
      openMergeGroupModal(g.members.map((m) => m.id));
    });
    root.querySelector(`[data-dismiss="${i}"]`).addEventListener('click', () => {
      dismissMergeGroup(g.members.map((m) => m.id));
    });
  });
  root.querySelectorAll('[data-view-customer]').forEach((el) => {
    el.addEventListener('click', () => openCustomerBottlesModal(el.dataset.viewCustomer));
  });

  let sourceBottleId = null;
  let targetBottleId = null;
  const finalNameInput = root.querySelector('#mg-finalName');
  const finalKanaInput = root.querySelector('#mg-finalKana');

  function bottleSearchResultsHtml(query, excludeBottleId) {
    const q = query.trim();
    if (!q) return '';
    const matches = APP.bottles
      .filter((b) => b.status === 'active' && b.id !== excludeBottleId)
      .filter((b) => {
        const c = getCustomer(b.customerId);
        if (String(b.bottleNo) === q) return true;
        return matchesFreeword(q, c.name, c.kana, b.bottleName, b.bottleNameKana, c.memo);
      })
      .slice(0, 20);
    if (matches.length === 0) return '<p class="text-faint" style="margin-top:6px;">該当するボトルが見つかりません</p>';
    return `<div class="candidate-list" style="margin-top:6px;">${matches.map((b) => {
      const c = getCustomer(b.customerId);
      return `
      <button class="btn btn-ghost btn-sm" data-pick-bottle="${b.id}" style="width:100%; justify-content:flex-start; text-align:left;">
        ${bottleTagHtml(b)} ${escapeHtml(c.name)} 様（${escapeHtml(c.kana)}）${b.bottleName ? `「${escapeHtml(b.bottleName)}」` : ''}
      </button>`;
    }).join('')}</div>`;
  }

  function setupBottleSearch(inputId, resultsId, selectedId, onPick) {
    const input = root.querySelector(`#${inputId}`);
    const resultsEl = root.querySelector(`#${resultsId}`);
    input.addEventListener('input', () => {
      resultsEl.innerHTML = bottleSearchResultsHtml(input.value, inputId === 'mg-source-search' ? targetBottleId : sourceBottleId);
      resultsEl.querySelectorAll('[data-pick-bottle]').forEach((el) => {
        el.addEventListener('click', () => {
          onPick(el.dataset.pickBottle);
          input.value = '';
          resultsEl.innerHTML = '';
        });
      });
    });
  }

  function renderSourceSelected() {
    const el = root.querySelector('#mg-source-selected');
    if (!sourceBottleId) { el.textContent = ''; return; }
    const b = APP.bottles.find((x) => x.id === sourceBottleId);
    const c = getCustomer(b.customerId);
    el.innerHTML = `選択中：${bottleTagHtml(b)} ${escapeHtml(c.name)} 様（${escapeHtml(c.kana)}）`;
  }

  function renderTargetSelected() {
    const el = root.querySelector('#mg-target-selected');
    if (!targetBottleId) { el.textContent = ''; return; }
    const b = APP.bottles.find((x) => x.id === targetBottleId);
    const c = getCustomer(b.customerId);
    el.innerHTML = `統合先の候補：${bottleTagHtml(b)} ${escapeHtml(c.name)} 様（${escapeHtml(c.kana)}）`;
    finalNameInput.value = c.name;
    finalKanaInput.value = c.kana;
  }

  setupBottleSearch('mg-source-search', 'mg-source-results', 'mg-source-selected', (id) => {
    sourceBottleId = id;
    renderSourceSelected();
  });
  setupBottleSearch('mg-target-search', 'mg-target-results', 'mg-target-selected', (id) => {
    targetBottleId = id;
    renderTargetSelected();
  });

  root.querySelector('#mg-submit').addEventListener('click', async () => {
    const finalName = finalNameInput.value.trim();
    const finalKana = finalKanaInput.value.trim();

    if (!sourceBottleId) { showToast('統合するボトルを選択してください', 'error'); return; }
    if (!targetBottleId) { showToast('統合先のボトルを選択してください', 'error'); return; }
    if (!finalName) { showToast('統合後のお客様名を入力してください', 'error'); return; }

    const sourceBottle = APP.bottles.find((b) => b.id === sourceBottleId);
    const targetBottle = APP.bottles.find((b) => b.id === targetBottleId);
    if (sourceBottle.customerId === targetBottle.customerId) {
      showToast('すでに同じお客様として登録されています', 'error');
      return;
    }
    const targetCustomer = getCustomer(targetBottle.customerId);
    const sourceCustomer = getCustomer(sourceBottle.customerId);
    const now = BKUtil.nowISO();

    // 選択したボトルだけでなく、統合元のお客様が持つ全てのボトルを付け替える
    const sourceBottles = getActiveBottlesOf(sourceCustomer.id);
    for (const b of sourceBottles) {
      const beforeBottle = { ...b };
      b.customerId = targetCustomer.id;
      b.updatedAt = now;
      await APP.storage.putBottle(b);
      await logOperation('内容修正', 'bottle', b.id, beforeBottle, b, `統合（手動）：${sourceCustomer.name} 様 → ${targetCustomer.name} 様へ付け替え`);
    }

    const beforeCustomer = { ...targetCustomer };
    targetCustomer.name = finalName;
    targetCustomer.kana = finalKana || targetCustomer.kana;
    targetCustomer.updatedAt = now;
    await APP.storage.putCustomer(targetCustomer);
    await logOperation('内容修正', 'customer', targetCustomer.id, beforeCustomer, targetCustomer, '統合（手動）による名称更新');

    await refreshCache();
    await syncCustomerLastVisitToLatest(targetCustomer.id);
    await refreshCache();
    showToast(`${sourceBottles.length}本を ${finalName} 様に統合しました`);
    renderScreen('merge');
  });
}

// ==========================================================================
// 14. 画面：破棄対象
// ==========================================================================

function renderDisposalTargetScreen(root) {
  root.innerHTML = `
    <h2 class="screen-title">破棄対象 <span class="count-badge" id="dt-count">0件</span></h2>
    <p class="text-muted">最終来店日から${APP.settings.disposalThresholdMonths}ヶ月以上経過（★は除外）しているボトルです。</p>
    ${searchBarHtml({ showType: APP.disposalTab === ALL_TYPES_TAB })}
    <div id="dt-body"></div>
  `;
  attachSearchBarEvents(root, () => renderDisposalTargetBody(root));
  renderDisposalTargetBody(root);
}

function renderDisposalTargetBody(root) {
  const baseTargets = APP.bottles
    .filter((b) => b.status === 'active')
    .map((b) => ({ bottle: b, customer: getCustomer(b.customerId) }))
    .filter(({ bottle, customer }) => !customer.star && BKUtil.isDisposalTarget(bottle.lastVisitDate, APP.settings.disposalThresholdMonths));

  let list = baseTargets
    .filter(({ bottle }) => APP.disposalTab === ALL_TYPES_TAB || bottle.bottleType === APP.disposalTab)
    .filter(({ bottle, customer }) => bottleMatchesFilters(bottle, customer));

  const sortDir = APP.sort.disposalTarget?.dir || 'desc';
  list = [...list].sort((a, b) => {
    const da = BKUtil.diffDays(a.bottle.lastVisitDate, BKUtil.todayJST());
    const db = BKUtil.diffDays(b.bottle.lastVisitDate, BKUtil.todayJST());
    return sortDir === 'asc' ? da - db : db - da;
  });

  const body = root.querySelector('#dt-body');
  root.querySelector('#dt-count').textContent = `${list.length}件`;
  body.innerHTML = `
    <div class="tab-bar">
      <div class="tab-bar__item ${APP.disposalTab === ALL_TYPES_TAB ? 'is-active' : ''}" data-tab="${ALL_TYPES_TAB}">すべて（${baseTargets.length}）</div>
      ${BOTTLE_TYPES.map((t) => {
        const cnt = baseTargets.filter(({ bottle }) => bottle.bottleType === t).length;
        return `<div class="tab-bar__item ${APP.disposalTab === t ? 'is-active' : ''}" data-tab="${t}">${t}（${cnt}）</div>`;
      }).join('')}
    </div>
    <div class="table-wrap is-cardable">
      <table class="data-table data-table--fixed">
        <colgroup>
          <col style="width:26%"><col style="width:104px"><col style="width:70px"><col style="width:40%"><col style="width:130px"><col style="width:130px">
        </colgroup>
        <thead><tr>
          <th>ボトル・お客様</th>
          <th>最終来店日</th><th data-sort="elapsedDays" class="${APP.sort.disposalTarget?.key === 'elapsedDays' ? 'sort-active' : ''}">経過日数 ${sortDir === 'asc' ? '▲' : '▼'}</th>
          <th>特徴・注意事項</th><th>残量</th><th>操作</th>
        </tr></thead>
        <tbody>
        ${list.map(({ bottle, customer }) => {
          const draft = APP.remainingDraft[bottle.id] ?? 50;
          return `
          <tr>
            <td data-label="ボトル・お客様">
              ${bottleTagHtml(bottle)}<br>
              <button class="customer-link" data-customer-bottles="${customer.id}">${escapeHtml(customer.name)}</button><br>
              <span class="text-faint" style="font-size:12px;">${escapeHtml(customer.kana)}</span>
            </td>
            <td class="date-cell-compact" data-label="最終来店日">${BKUtil.displayDateBroken(bottle.lastVisitDate)}</td>
            <td data-label="経過日数">${elapsedDaysLabel(bottle.lastVisitDate)}</td>
            <td class="text-muted" data-label="特徴・注意事項">${escapeHtml(customer.memo)}</td>
            <td data-label="残量">
              <div class="amount-slider-wrap">
                <input type="range" min="0" max="100" step="5" value="${draft}" data-slider="${bottle.id}">
                <span class="amount-value" id="amount-${bottle.id}">${draft}%</span>
              </div>
            </td>
            <td class="flex-row" data-label="操作">
              <button class="btn btn-sm btn-ghost" data-view="${bottle.id}">詳細</button>
              <button class="btn btn-sm btn-danger" data-discard="${bottle.id}">流す</button>
            </td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
      ${list.length === 0 ? '<div class="empty-state">現在、破棄対象のボトルはありません</div>' : ''}
    </div>
  `;

  const sortHeader = body.querySelector('[data-sort="elapsedDays"]');
  if (sortHeader) {
    sortHeader.addEventListener('click', () => {
      const cur = APP.sort.disposalTarget || {};
      APP.sort.disposalTarget = { key: 'elapsedDays', dir: cur.key === 'elapsedDays' && cur.dir === 'desc' ? 'asc' : 'desc' };
      renderDisposalTargetBody(root);
    });
  }

  body.querySelectorAll('[data-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      APP.disposalTab = el.dataset.tab;
      if (APP.disposalTab !== ALL_TYPES_TAB) APP.filters.bottleType = '';
      renderDisposalTargetScreen(root);
    });
  });
  body.querySelectorAll('[data-customer-bottles]').forEach((el) => el.addEventListener('click', () => openCustomerBottlesModal(el.dataset.customerBottles)));
  body.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => { APP.detailBottleId = el.dataset.view; APP.detailMode = 'edit'; renderScreen('detail'); }));
  body.querySelectorAll('[data-slider]').forEach((el) => {
    el.addEventListener('input', () => {
      APP.remainingDraft[el.dataset.slider] = Number(el.value);
      document.getElementById(`amount-${el.dataset.slider}`).textContent = `${el.value}%`;
    });
  });
  body.querySelectorAll('[data-discard]').forEach((el) => {
    el.addEventListener('click', () => openDiscardModal(el.dataset.discard));
  });
}

function openDiscardModal(bottleId, afterScreen = 'disposal-target') {
  const bottle = APP.bottles.find((b) => b.id === bottleId);
  const customer = getCustomer(bottle.customerId);
  const remaining = APP.remainingDraft[bottleId] ?? 50;

  if (customer.star) {
    showToast('★（残す）が設定されているお客様のボトルです。破棄内容をよくご確認ください。', 'warn');
  }

  const body = `
    ${customer.star ? `<div class="warning-box">⚠ このお客様には ★（残す） が設定されています。本当に破棄してよいか、今一度ご確認ください。</div>` : ''}
    <div class="modal-info-row"><span>お客様名</span><span>${escapeHtml(customer.name)}</span></div>
    ${bottle.bottleName ? `<div class="modal-info-row"><span>ボトル名</span><span>${escapeHtml(bottle.bottleName)}</span></div>` : ''}
    <div class="modal-info-row"><span>ボトル種類</span><span>${escapeHtml(bottle.bottleType)}</span></div>
    <div class="modal-info-row"><span>ボトルNo.</span><span>${bottle.bottleNo}</span></div>
    <div class="modal-info-row"><span>最終来店日</span><span>${BKUtil.displayDate(bottle.lastVisitDate)}</span></div>
    <div class="modal-info-row"><span>残量</span><span>${remaining}%</span></div>
    <p style="margin-top:16px;">このボトルを破棄します。よろしいですか？</p>
  `;
  const actions = `
    <button class="btn btn-ghost" id="m-cancel">キャンセル</button>
    <button class="btn btn-danger" id="m-confirm">破棄する</button>
  `;
  const box = openModal('破棄の確認', body, actions);
  box.querySelector('#m-cancel').addEventListener('click', closeModal);
  box.querySelector('#m-confirm').addEventListener('click', async () => {
    await discardBottle(bottleId, remaining, afterScreen);
    closeModal();
  });
}

async function discardBottle(bottleId, remainingAmount, afterScreen = 'disposal-target') {
  const bottle = APP.bottles.find((b) => b.id === bottleId);
  const customer = getCustomer(bottle.customerId);
  const now = BKUtil.nowISO();
  const today = BKUtil.todayJST();
  const before = { ...bottle };

  bottle.status = 'disposed';
  bottle.updatedAt = now;
  await APP.storage.putBottle(bottle);

  const entry = {
    id: BKUtil.uuid(),
    displayId: `${before.bottleType}_${before.bottleNo}_${BKUtil.compactDate(today)}`,
    originalBottleNo: before.bottleNo,
    bottleId: bottle.id,
    bottleType: bottle.bottleType,
    customerId: customer.id,
    bottleNameSnapshot: bottle.bottleName || '',
    bottleNameKanaSnapshot: bottle.bottleNameKana || '',
    customerNameSnapshot: customer.name,
    customerKanaSnapshot: customer.kana,
    lastVisitDateAtDisposal: before.lastVisitDate,
    disposedAt: now,
    remainingAmount,
    memo: customer.memo,
    status: 'disposed',
    restoredAt: null,
  };
  await APP.storage.putDisposalHistory(entry);
  await logOperation('破棄', 'bottle', bottle.id, before, bottle, `残量${remainingAmount}%`);

  delete APP.remainingDraft[bottleId];
  await refreshCache();
  showToast(`${bottle.bottleType} No.${before.bottleNo} を破棄しました`);
  renderScreen(afterScreen);
}

// ==========================================================================
// 15. 画面：破棄履歴
// ==========================================================================

function renderDisposalHistoryScreen(root) {
  if (!APP.disposalHistoryGroupBy) APP.disposalHistoryGroupBy = 'none';
  root.innerHTML = `
    <h2 class="screen-title">破棄履歴 <span class="count-badge" id="dh-count">0件</span></h2>
    ${searchBarHtml()}
    <div class="tab-bar">
      <div class="tab-bar__item ${APP.disposalHistoryGroupBy === 'none' ? 'is-active' : ''}" data-group-by="none">すべて表示</div>
      <div class="tab-bar__item ${APP.disposalHistoryGroupBy === 'day' ? 'is-active' : ''}" data-group-by="day">破棄日ごと</div>
      <div class="tab-bar__item ${APP.disposalHistoryGroupBy === 'month' ? 'is-active' : ''}" data-group-by="month">破棄月ごと</div>
    </div>
    <div id="dh-body"></div>
  `;
  attachSearchBarEvents(root, () => renderDisposalHistoryBody(root));
  root.querySelectorAll('[data-group-by]').forEach((el) => {
    el.addEventListener('click', () => {
      APP.disposalHistoryGroupBy = el.dataset.groupBy;
      renderDisposalHistoryScreen(root);
    });
  });
  renderDisposalHistoryBody(root);
}

function disposalHistoryTableHtml(list) {
  return `
    <div class="table-wrap is-cardable">
      <table class="data-table data-table--fixed">
        <colgroup>
          <col style="width:16%"><col style="width:16%"><col style="width:22%"><col style="width:104px"><col style="width:104px"><col style="width:70px"><col style="width:26%"><col style="width:100px"><col style="width:110px">
        </colgroup>
        <thead><tr>
          <th>履歴ID</th><th>ボトル名</th><th>お客様名</th>
          <th>最終来店日</th><th>破棄日</th><th>残量</th><th>特徴・注意事項</th><th>状態</th><th>操作</th>
        </tr></thead>
        <tbody>
        ${list.map((h) => {
          const canRestore = h.status === 'disposed' && isBottleNoFree(h.bottleType, h.originalBottleNo, h.bottleId);
          const restoreBtn = h.status === 'restored'
            ? '<span class="text-faint">復元済み</span>'
            : canRestore
              ? `<button class="btn btn-sm btn-ghost" data-restore="${h.id}">復元</button>`
              : `<span class="text-faint" title="No.${h.originalBottleNo} は現在使用中のため復元できません">復元不可（番号使用中）</span>`;
          return `
          <tr>
            <td data-label="履歴ID">${escapeHtml(h.displayId)}</td>
            <td class="text-muted" data-label="ボトル名">${bottleNameCellHtml(h.bottleNameSnapshot, h.bottleNameKanaSnapshot)}</td>
            <td data-label="お客様名">
              ${escapeHtml(h.customerNameSnapshot)}<br>
              <span class="text-faint" style="font-size:12px;">${escapeHtml(h.customerKanaSnapshot)}</span>
            </td>
            <td class="date-cell-compact" data-label="最終来店日">${BKUtil.displayDateBroken(h.lastVisitDateAtDisposal)}</td>
            <td class="date-cell-compact" data-label="破棄日">${BKUtil.displayDateBroken(BKUtil.jstDateFromISO(h.disposedAt))}</td>
            <td data-label="残量">${h.remainingAmount}%</td>
            <td class="text-muted" data-label="特徴・注意事項">${escapeHtml(h.memo)}</td>
            <td data-label="状態">${h.status === 'restored' ? '<span class="status-pill status-normal">復元済み</span>' : '<span class="status-pill status-target">破棄済み</span>'}</td>
            <td data-label="操作">${restoreBtn}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
      ${list.length === 0 ? '<div class="empty-state">破棄履歴はありません</div>' : ''}
    </div>
  `;
}

function renderDisposalHistoryBody(root) {
  const f = APP.filters;
  let list = [...APP.disposalHistory];
  list = list.filter((h) => {
    if (!matchesFreeword(f.freeword, h.customerNameSnapshot, h.customerKanaSnapshot, h.bottleNameSnapshot, h.bottleNameKanaSnapshot, h.memo)) return false;
    if (f.bottleType && h.bottleType !== f.bottleType) return false;
    if (f.bottleNo && String(h.originalBottleNo) !== String(f.bottleNo).trim()) return false;
    if (f.yearMonth && BKUtil.toYearMonth(BKUtil.jstDateFromISO(h.disposedAt)) !== f.yearMonth) return false;
    return true;
  });
  list.sort((a, b) => (a.disposedAt < b.disposedAt ? 1 : -1));

  root.querySelector('#dh-count').textContent = `${list.length}件`;
  const body = root.querySelector('#dh-body');

  if (APP.disposalHistoryGroupBy === 'none') {
    body.innerHTML = disposalHistoryTableHtml(list);
  } else {
    const groupKeyFn = APP.disposalHistoryGroupBy === 'day'
      ? (h) => BKUtil.jstDateFromISO(h.disposedAt)
      : (h) => BKUtil.toYearMonth(BKUtil.jstDateFromISO(h.disposedAt));
    const groups = new Map();
    for (const h of list) {
      const key = groupKeyFn(h);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(h);
    }
    const sortedKeys = [...groups.keys()].sort((a, b) => (a < b ? 1 : -1));
    body.innerHTML = sortedKeys.map((key) => {
      const groupList = groups.get(key);
      const label = APP.disposalHistoryGroupBy === 'day'
        ? `${BKUtil.displayDate(key)}`
        : `${key.replace('-', '年')}月`;
      return `
        <div class="panel">
          <h3 class="mt-0">${label} <span class="count-badge">${groupList.length}件</span></h3>
          ${disposalHistoryTableHtml(groupList)}
        </div>
      `;
    }).join('') || '<div class="empty-state">破棄履歴はありません</div>';
  }

  body.querySelectorAll('[data-restore]').forEach((el) => {
    el.addEventListener('click', () => openRestoreModal(el.dataset.restore));
  });
}

function openRestoreModal(historyId) {
  const h = APP.disposalHistory.find((x) => x.id === historyId);
  const body = `
    <div class="modal-info-row"><span>お客様名</span><span>${escapeHtml(h.customerNameSnapshot)}</span></div>
    <div class="modal-info-row"><span>種類</span><span>${escapeHtml(h.bottleType)}</span></div>
    <div class="modal-info-row"><span>元のボトルNo.</span><span>${h.originalBottleNo}</span></div>
    <div class="modal-info-row"><span>破棄日</span><span>${BKUtil.displayDate(BKUtil.jstDateFromISO(h.disposedAt))}</span></div>
    <p style="margin-top:16px;">このボトルを復元します。よろしいですか？</p>
  `;
  const actions = `
    <button class="btn btn-ghost" id="m-cancel">キャンセル</button>
    <button class="btn btn-primary" id="m-confirm">復元する</button>
  `;
  const box = openModal('復元の確認', body, actions);
  box.querySelector('#m-cancel').addEventListener('click', closeModal);
  box.querySelector('#m-confirm').addEventListener('click', async () => {
    await restoreBottle(historyId);
    closeModal();
  });
}

async function restoreBottle(historyId) {
  const h = APP.disposalHistory.find((x) => x.id === historyId);
  if (!isBottleNoFree(h.bottleType, h.originalBottleNo, h.bottleId)) {
    showToast('元の番号が使用中のため復元できません', 'error');
    return;
  }
  const bottle = await APP.storage.getBottle(h.bottleId);
  const before = { ...bottle };
  bottle.status = 'active';
  bottle.updatedAt = BKUtil.nowISO();
  await APP.storage.putBottle(bottle);

  const beforeHist = { ...h };
  h.status = 'restored';
  h.restoredAt = BKUtil.nowISO();
  await APP.storage.putDisposalHistory(h);

  await logOperation('復元', 'bottle', bottle.id, before, bottle);
  await logOperation('復元', 'disposalHistory', h.id, beforeHist, h);

  await refreshCache();
  showToast(`${h.bottleType} No.${h.originalBottleNo} を復元しました`);
  renderScreen('disposal-history');
}

// ==========================================================================
// 16. 画面：閲覧・修正
// ==========================================================================

// ==========================================================================
// 履歴・元に戻す
// ==========================================================================
function targetLabelForLog(log) {
  const snap = log.after || log.before;
  if (!snap) return '（不明）';
  if (log.targetType === 'customer') return `${snap.name || '（名前なし）'} 様`;
  if (log.targetType === 'bottle') return `${escapeHtml(snap.bottleType || '')} No.${snap.bottleNo ?? ''}${snap.bottleName ? `「${escapeHtml(snap.bottleName)}」` : ''}`;
  if (log.targetType === 'disposalHistory') return snap.displayId || '';
  return '';
}

function historyPanelHtml() {
  const logs = [...APP.operationLogs].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return `
    <p class="text-muted">直近の操作履歴です。間違えた操作は「元に戻す」でその操作の直前の状態に戻せます。</p>
    <div class="table-wrap is-cardable">
      <table class="data-table">
        <thead><tr>
          <th>日時</th><th>操作</th><th>対象</th><th>メモ</th><th>操作</th>
        </tr></thead>
        <tbody>
        ${logs.slice(0, 300).map((log) => `
          <tr>
            <td data-label="日時">${new Date(log.timestamp).toLocaleString('ja-JP')}</td>
            <td data-label="種別"><span class="status-pill status-normal">${escapeHtml(log.actionType)}</span></td>
            <td data-label="対象">${targetLabelForLog(log)}</td>
            <td class="text-muted" data-label="メモ">${escapeHtml(log.note || '')}</td>
            <td data-label="操作"><button class="btn btn-sm btn-ghost" data-undo="${log.id}">元に戻す</button></td>
          </tr>
        `).join('')}
        </tbody>
      </table>
      ${logs.length === 0 ? '<div class="empty-state">まだ操作履歴がありません</div>' : ''}
    </div>
  `;
}

function confirmUndo(logId) {
  const log = APP.operationLogs.find((l) => l.id === logId);
  if (!log) return;
  const body = `<p>この操作（${escapeHtml(log.actionType)}：${targetLabelForLog(log)}）を元に戻しますか？</p>`;
  const actions = `
    <button class="btn btn-ghost" id="m-cancel">キャンセル</button>
    <button class="btn btn-primary" id="m-confirm">元に戻す</button>
  `;
  const box = openModal('元に戻す', body, actions);
  box.querySelector('#m-cancel').addEventListener('click', closeModal);
  box.querySelector('#m-confirm').addEventListener('click', async () => {
    closeModal();
    await undoOperation(log);
  });
}

async function undoOperation(log) {
  try {
    if (log.targetType === 'customer') {
      if (log.before) {
        await APP.storage.putCustomer(log.before);
      } else {
        const stillHasBottles = APP.bottles.some((b) => b.customerId === log.targetId && b.status === 'active');
        if (stillHasBottles) {
          showToast('このお客様には現在ボトルが登録されているため、削除による取り消しはできません', 'error');
          return;
        }
        await APP.storage.deleteCustomer(log.targetId);
      }
    } else if (log.targetType === 'bottle') {
      if (log.before) {
        await APP.storage.putBottle(log.before);
        // 破棄の取り消しの場合、対応する破棄履歴も完全に削除し、破棄した事実自体をなくす
        if (log.actionType === '破棄' && log.after) {
          const entry = APP.disposalHistory.find((h) => h.bottleId === log.targetId && h.disposedAt === log.after.updatedAt);
          if (entry) await APP.storage.deleteDisposalHistory(entry.id);
        }
      } else {
        await APP.storage.deleteBottle(log.targetId);
      }
    } else if (log.targetType === 'disposalHistory') {
      if (log.before) {
        await APP.storage.putDisposalHistory(log.before);
      } else {
        await APP.storage.deleteDisposalHistory(log.targetId);
      }
    }
    // 元に戻した操作自体は履歴に残さない（その操作が最初から無かったことにする）
    await APP.storage.deleteOperationLog(log.id);
    await refreshCache();
    showToast('元に戻しました');
    renderScreen('backup');
  } catch (err) {
    showToast('元に戻す処理に失敗しました', 'error');
  }
}

function renderDetailScreen(root) {
  const bottle = APP.bottles.find((b) => b.id === APP.detailBottleId);
  if (!bottle) { renderScreen('manage-bottle'); return; }
  const customer = getCustomer(bottle.customerId);
  const otherBottles = getActiveBottlesOf(customer.id).filter((b) => b.id !== bottle.id);
  const visits = APP.visits.filter((v) => v.customerId === customer.id).sort((a, b) => (a.visitDate < b.visitDate ? 1 : -1));
  const readonly = APP.detailMode !== 'edit';
  const today = BKUtil.todayJST();

  root.innerHTML = `
    <div class="flex-row" style="justify-content:space-between; margin-bottom:14px;">
      <h2 class="screen-title mt-0">${readonly ? '閲覧' : '修正'}：${escapeHtml(customer.name)} 様</h2>
      <div class="flex-row">
        <button class="btn btn-sm btn-ghost" id="btn-add-same-customer">＋ このお客様にボトルを追加</button>
        ${readonly ? `<button class="btn btn-sm btn-ghost" id="btn-to-edit">修正する</button>` : ''}
        <button class="btn btn-sm btn-ghost" id="btn-back">← 一覧に戻る</button>
      </div>
    </div>

    <div class="panel">
      <div class="form-grid">
        <div class="form-field">
          <label>お客様名</label>
          <input type="text" id="d-name" value="${escapeHtml(customer.name)}" ${readonly ? 'disabled' : ''}>
        </div>
        <div class="form-field">
          <label>お客様名（カナ）</label>
          <input type="text" id="d-kana" value="${escapeHtml(customer.kana)}" ${readonly ? 'disabled' : ''}>
        </div>
        <div class="form-field">
          <label>ボトル種類</label>
          <input type="text" value="${escapeHtml(bottle.bottleType)}" disabled title="種類の変更は非対応です">
        </div>
        <div class="form-field">
          <label>ボトルNo.</label>
          <input type="number" id="d-bottleNo" value="${bottle.bottleNo}" min="1" ${readonly ? 'disabled' : ''}>
          <div class="form-error" id="err-bottleNo"></div>
        </div>
        <div class="form-field">
          <label>ボトル名</label>
          <input type="text" id="d-bottleName" value="${escapeHtml(bottle.bottleName)}" ${readonly ? 'disabled' : ''} placeholder="例：太郎と仲間たち">
        </div>
        <div class="form-field">
          <label>ボトル名（カナ）</label>
          <input type="text" id="d-bottleNameKana" value="${escapeHtml(bottle.bottleNameKana)}" ${readonly ? 'disabled' : ''} placeholder="例：タロウトナカマタチ">
        </div>
        <div class="form-field form-field--full">
          <label>特徴・注意事項</label>
          <textarea id="d-memo" ${readonly ? 'disabled' : ''}>${escapeHtml(customer.memo)}</textarea>
        </div>
        <div class="form-field">
          <label class="checkbox-field">
            <input type="checkbox" id="d-star" ${customer.star ? 'checked' : ''} ${readonly ? 'disabled' : ''}>
            残す（★）
          </label>
        </div>
        <div class="form-field">
          <label>最終来店日</label>
          <input type="date" id="d-lastVisitDate" value="${bottle.lastVisitDate}" max="${today}" ${readonly ? 'disabled' : ''}>
          <div class="form-error" id="err-lastVisitDate"></div>
          ${!readonly ? `<div class="text-faint" style="font-size:12px;">同じお客様が持つ他のボトルの最終来店日も、まとめて更新されます</div>` : ''}
        </div>
        <div class="form-field">
          <label>登録日</label>
          <input type="text" value="${BKUtil.displayDate(bottle.createdAt.slice(0,10))}" disabled>
        </div>
        <div class="form-field">
          <label>更新日</label>
          <input type="text" value="${BKUtil.displayDate(bottle.updatedAt.slice(0,10))}" disabled>
        </div>
      </div>
      ${!readonly ? `
      <div class="flex-row" style="margin-top:18px;">
        <button class="btn btn-primary" id="btn-save">保存する</button>
      </div>` : ''}
    </div>

    <div class="panel">
      <h3 class="mt-0">所有しているほかのボトル</h3>
      ${otherBottles.length ? otherBottles.map((b) => `<div style="margin-bottom:6px;"><button class="customer-link" data-goto-bottle="${b.id}">${bottleTagHtml(b)}${b.bottleName ? ` 「${escapeHtml(b.bottleName)}」` : ''} 最終来店日：${BKUtil.displayDate(b.lastVisitDate)}</button></div>`).join('') : '<p class="text-muted">他に所有しているボトルはありません</p>'}
    </div>

    <div class="panel">
      <h3 class="mt-0">来店履歴</h3>
      ${visits.length ? `<ul>${visits.map((v) => `<li>${BKUtil.displayDate(v.visitDate)}</li>`).join('')}</ul>` : '<p class="text-muted">来店履歴がありません</p>'}
    </div>

    <div class="panel">
      <h3 class="mt-0">他のボトルをこの方に統合</h3>
      <p class="text-muted">別に登録されているボトルを検索して、複数選択してこのお客様に統合できます。</p>
      <div class="form-field form-field--full">
        <input type="text" id="merge-search-input" placeholder="お客様名・フリガナ・ボトル名・No.で検索">
      </div>
      <div id="merge-search-results"></div>
      <div class="flex-row" style="margin-top:12px;">
        <button class="btn btn-primary" id="merge-search-submit">選択したボトルを統合する</button>
      </div>
    </div>

    <div class="panel">
      <h3 class="mt-0">このボトルを破棄する</h3>
      <div class="amount-slider-wrap">
        <input type="range" min="0" max="100" step="5" value="${APP.remainingDraft[bottle.id] ?? 50}" id="d-remaining-slider">
        <span class="amount-value" id="d-remaining-value">${APP.remainingDraft[bottle.id] ?? 50}%</span>
      </div>
      <div class="flex-row" style="margin-top:12px;">
        <button class="btn btn-danger" id="btn-discard">流す</button>
      </div>
    </div>

    <div class="panel">
      <h3 class="mt-0">登録の取り消し（入力ミスの場合）</h3>
      <p class="text-muted">実際には存在しないボトル（入力ミス・CSV取り込みミス等）を、破棄履歴に残さず完全に削除します。</p>
      <div class="flex-row">
        <button class="btn btn-ghost" id="btn-delete-mistake">このボトルの登録を取り消す</button>
      </div>
    </div>
  `;

  root.querySelector('#btn-back').addEventListener('click', () => renderScreen('manage-bottle'));
  root.querySelector('#btn-add-same-customer').addEventListener('click', () => {
    APP.addForm.prefillCustomerId = customer.id;
    renderScreen('add');
  });
  const toEdit = root.querySelector('#btn-to-edit');
  if (toEdit) toEdit.addEventListener('click', () => { APP.detailMode = 'edit'; renderScreen('detail'); });

  root.querySelector('#btn-delete-mistake').addEventListener('click', () => {
    const body = `<p>${escapeHtml(bottle.bottleType)} No.${bottle.bottleNo}${bottle.bottleName ? `「${escapeHtml(bottle.bottleName)}」` : ''} の登録を完全に取り消します。破棄履歴には残りません。よろしいですか？</p>`;
    const actions = `
      <button class="btn btn-ghost" id="m-cancel">キャンセル</button>
      <button class="btn btn-danger" id="m-confirm">取り消す</button>
    `;
    const box = openModal('登録の取り消し', body, actions);
    box.querySelector('#m-cancel').addEventListener('click', closeModal);
    box.querySelector('#m-confirm').addEventListener('click', async () => {
      closeModal();
      await logOperation('内容修正', 'bottle', bottle.id, bottle, null, '入力ミスによる登録取り消し');
      await APP.storage.deleteBottle(bottle.id);
      await refreshCache();
      showToast('登録を取り消しました');
      renderScreen('manage-bottle');
    });
  });

  root.querySelectorAll('[data-goto-bottle]').forEach((el) => {
    el.addEventListener('click', () => goToBottleDetailWithGuard(root, bottle, customer, el.dataset.gotoBottle));
  });

  const slider = root.querySelector('#d-remaining-slider');
  slider.addEventListener('input', () => {
    APP.remainingDraft[bottle.id] = Number(slider.value);
    root.querySelector('#d-remaining-value').textContent = `${slider.value}%`;
  });
  root.querySelector('#btn-discard').addEventListener('click', () => openDiscardModal(bottle.id, 'manage-bottle'));

  // 他のボトルを検索して、複数選択でこのお客様に統合する
  const mergeSelected = new Set();
  const mergeSearchInput = root.querySelector('#merge-search-input');
  const mergeResultsEl = root.querySelector('#merge-search-results');

  function renderMergeSearchResults() {
    const q = mergeSearchInput.value.trim();
    let matches = [];
    if (q) {
      matches = APP.bottles
        .filter((b) => b.status === 'active' && b.customerId !== customer.id)
        .filter((b) => {
          if (String(b.bottleNo) === q) return true;
          const c = getCustomer(b.customerId);
          return matchesFreeword(q, c.name, c.kana, b.bottleName, b.bottleNameKana, c.memo);
        })
        .slice(0, 30);
    }
    mergeResultsEl.innerHTML = !q
      ? `<p class="text-muted" style="margin-top:8px;">検索キーワードを入力してください</p>`
      : matches.length === 0
      ? `<p class="text-muted" style="margin-top:8px;">該当するボトルが見つかりません</p>`
      : `<div class="candidate-list" style="margin-top:8px;">${matches.map((b) => {
          const c = getCustomer(b.customerId);
          return `
          <label class="checkbox-field" style="width:100%; padding:8px 4px; border-bottom:1px solid var(--color-border-soft);">
            <input type="checkbox" class="merge-search-check" data-bottle-id="${b.id}" ${mergeSelected.has(b.id) ? 'checked' : ''}>
            <span>${bottleTagHtml(b)} ${escapeHtml(c.name)} 様（${escapeHtml(c.kana)}）${b.bottleName ? `「${escapeHtml(b.bottleName)}」` : ''}</span>
          </label>`;
        }).join('')}</div>`;
    mergeResultsEl.querySelectorAll('.merge-search-check').forEach((chk) => {
      chk.addEventListener('change', () => {
        if (chk.checked) mergeSelected.add(chk.dataset.bottleId);
        else mergeSelected.delete(chk.dataset.bottleId);
      });
    });
  }
  mergeSearchInput.addEventListener('input', renderMergeSearchResults);
  renderMergeSearchResults();

  root.querySelector('#merge-search-submit').addEventListener('click', async () => {
    if (mergeSelected.size === 0) { showToast('統合するボトルを選択してください', 'error'); return; }
    const now = BKUtil.nowISO();
    let count = 0;
    for (const bottleId of mergeSelected) {
      const b = APP.bottles.find((x) => x.id === bottleId);
      if (!b || b.customerId === customer.id) continue;
      const before = { ...b };
      const beforeOwner = getCustomer(before.customerId);
      b.customerId = customer.id;
      b.updatedAt = now;
      await APP.storage.putBottle(b);
      await logOperation('内容修正', 'bottle', b.id, before, b, `統合（詳細画面から）：${beforeOwner ? beforeOwner.name : ''} → ${customer.name}`);
      count++;
    }
    await refreshCache();
    await syncCustomerLastVisitToLatest(customer.id);
    await refreshCache();
    showToast(`${count}本を${customer.name}様に統合しました`);
    renderScreen('detail');
  });

async function saveDetailScreenChanges(root, bottle, customer) {
  const newName = root.querySelector('#d-name').value.trim();
  const newKana = root.querySelector('#d-kana').value.trim();
  const newMemo = root.querySelector('#d-memo').value.trim();
  const newStar = root.querySelector('#d-star').checked;
  const newNo = Number(root.querySelector('#d-bottleNo').value);
  const newBottleName = root.querySelector('#d-bottleName').value.trim();
  const newBottleNameKana = root.querySelector('#d-bottleNameKana').value.trim();
  const newLastVisitDate = root.querySelector('#d-lastVisitDate').value;
  root.querySelector('#err-bottleNo').textContent = '';
  root.querySelector('#err-lastVisitDate').textContent = '';

  let finalName = newName;
  if (!finalName && newBottleName) finalName = newBottleName;
  if (!finalName) { showToast('お客様名、またはボトル名のいずれかを入力してください', 'error'); return false; }
  if (newNo !== bottle.bottleNo) {
    if (!isBottleNoFree(bottle.bottleType, newNo, bottle.id)) {
      root.querySelector('#err-bottleNo').textContent = `No.${newNo} は現在使用中のため変更できません。`;
      return false;
    }
  }
  if (!newLastVisitDate) {
    root.querySelector('#err-lastVisitDate').textContent = '最終来店日を入力してください。';
    return false;
  }
  if (BKUtil.isFutureDate(newLastVisitDate)) {
    root.querySelector('#err-lastVisitDate').textContent = '未来の日付は指定できません。';
    return false;
  }

  const now = BKUtil.nowISO();
  const beforeCustomer = { ...customer };
  customer.name = finalName; customer.kana = newKana; customer.memo = newMemo; customer.star = newStar; customer.updatedAt = now;
  await APP.storage.putCustomer(customer);
  await logOperation('内容修正', 'customer', customer.id, beforeCustomer, customer);
  if (beforeCustomer.star !== newStar) await logOperation('★の変更', 'customer', customer.id, beforeCustomer, customer);

  if (newNo !== bottle.bottleNo || newBottleName !== (bottle.bottleName || '') || newBottleNameKana !== (bottle.bottleNameKana || '')) {
    const beforeBottle = { ...bottle };
    if (newNo !== bottle.bottleNo) bottle.bottleNo = newNo;
    bottle.bottleName = newBottleName;
    bottle.bottleNameKana = newBottleNameKana;
    bottle.updatedAt = now;
    await APP.storage.putBottle(bottle);
    if (beforeBottle.bottleNo !== bottle.bottleNo) await logOperation('ボトルNo.変更', 'bottle', bottle.id, beforeBottle, bottle);
    if (beforeBottle.bottleName !== bottle.bottleName || beforeBottle.bottleNameKana !== bottle.bottleNameKana) await logOperation('内容修正', 'bottle', bottle.id, beforeBottle, bottle, 'ボトル名を変更');
  }

  let visitCount = 0;
  if (newLastVisitDate !== bottle.lastVisitDate) {
    visitCount = await applyVisitDateToBottles(customer.id, newLastVisitDate);
  }

  await refreshCache();
  showToast(visitCount > 0 ? `保存しました（${visitCount}本の最終来店日を更新）` : '保存しました');
  return true;
}

// 編集モードで、フォームの内容が元の値から変わっているかどうかを判定する
function hasUnsavedDetailChanges(root, bottle, customer) {
  if (APP.detailMode !== 'edit') return false;
  const nameEl = root.querySelector('#d-name');
  if (!nameEl) return false;
  const newName = root.querySelector('#d-name').value.trim();
  const newKana = root.querySelector('#d-kana').value.trim();
  const newMemo = root.querySelector('#d-memo').value.trim();
  const newStar = root.querySelector('#d-star').checked;
  const newNo = Number(root.querySelector('#d-bottleNo').value);
  const newBottleName = root.querySelector('#d-bottleName').value.trim();
  const newBottleNameKana = root.querySelector('#d-bottleNameKana').value.trim();
  const newLastVisitDate = root.querySelector('#d-lastVisitDate').value;

  if (newName !== customer.name) return true;
  if (newKana !== (customer.kana || '')) return true;
  if (newMemo !== (customer.memo || '')) return true;
  if (newStar !== !!customer.star) return true;
  if (newNo !== bottle.bottleNo) return true;
  if (newBottleName !== (bottle.bottleName || '')) return true;
  if (newBottleNameKana !== (bottle.bottleNameKana || '')) return true;
  if (newLastVisitDate !== bottle.lastVisitDate) return true;
  return false;
}

// 他のボトルへ移動する前に、保存されていない変更がないか確認する
function goToBottleDetailWithGuard(root, bottle, customer, targetBottleId) {
  if (hasUnsavedDetailChanges(root, bottle, customer)) {
    const body = `<p>保存されていない変更があります。移動する前にどうしますか？</p>`;
    const actions = `
      <button class="btn btn-ghost" id="m-discard">破棄して移動する</button>
      <button class="btn btn-primary" id="m-save">保存してから移動する</button>
    `;
    const box = openModal('保存されていない変更があります', body, actions);
    box.querySelector('#m-discard').addEventListener('click', () => {
      closeModal();
      APP.detailBottleId = targetBottleId;
      APP.detailMode = 'view';
      renderScreen('detail');
    });
    box.querySelector('#m-save').addEventListener('click', async () => {
      const ok = await saveDetailScreenChanges(root, bottle, customer);
      if (ok) {
        closeModal();
        APP.detailBottleId = targetBottleId;
        APP.detailMode = 'view';
        renderScreen('detail');
      }
    });
  } else {
    APP.detailBottleId = targetBottleId;
    APP.detailMode = 'view';
    renderScreen('detail');
  }
}

  const saveBtn = root.querySelector('#btn-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const ok = await saveDetailScreenChanges(root, bottle, customer);
      if (ok) {
        APP.detailMode = 'view';
        renderScreen('detail');
      }
    });
  }
}

// ==========================================================================
// 17. 画面：バックアップ・設定
// ==========================================================================

function renderBackupScreen(root) {
  const s = APP.settings;
  const lastBackup = s.lastBackupAt ? new Date(s.lastBackupAt).toLocaleString('ja-JP') : '未実施';
  const overdue = isBackupOverdue();
  const pushText = s.lastSheetPushAt ? `最終プッシュ：${new Date(s.lastSheetPushAt).toLocaleString('ja-JP')}` : '最終プッシュ：未実施';
  const pullText = s.lastSheetPullAt ? `最終プル：${new Date(s.lastSheetPullAt).toLocaleString('ja-JP')}` : '最終プル：未実施';

  root.innerHTML = `
    <h2 class="screen-title">設定</h2>

    <div class="panel">
      <h3 class="mt-0">データ連携（プッシュ・プル）</h3>
      <p class="text-muted">Google Apps Script のWebアプリ URLを設定すると、スプレッドシートへバックアップを送信（プッシュ）したり、他の端末が入力したデータを取得（プル）したりできます。Wi-Fi接続時のみ動作します。</p>
      <div class="form-field form-field--full">
        <label>Google Apps Script のURL</label>
        <input type="text" id="s-sheetUrl" value="${escapeHtml(s.sheetSyncUrl || '')}" placeholder="空欄の場合、組み込みのURLが自動で使われます">
        <p class="text-faint" style="font-size:12px; margin-top:4px;">通常はこのまま空欄で問題ありません。別のスプレッドシートに切り替えたい場合のみ入力してください。</p>
      </div>
      <div class="form-field">
        <label class="checkbox-field">
          <input type="checkbox" id="s-autoSync" ${s.sheetAutoSync ? 'checked' : ''}>
          データ変更のたびに自動で送信（プッシュ）する
        </label>
      </div>
      <div class="form-field">
        <label class="checkbox-field">
          <input type="checkbox" id="s-autoPull" ${s.sheetAutoPullOnStart ? 'checked' : ''}>
          起動時に自動で共有データを取得（プル）する
        </label>
      </div>
      <p class="text-muted" id="sheet-sync-status">${pushText}<br>${pullText}</p>
      <div class="flex-row" style="margin-top:8px;">
        <button class="btn btn-primary" id="btn-save-sheetsync">連携設定を保存</button>
        <button class="btn btn-ghost" id="btn-sync-now">今すぐ送信する（プッシュ）</button>
        <button class="btn btn-ghost" id="btn-pull-now">最新の共有データを取得する（プル）</button>
      </div>
      <div class="warning-box" style="margin-top:12px;">
        ⚠ 複数の端末でほぼ同時に入力すると、後から送信した方の内容で上書きされる場合があります。同時に同じお客様を編集しないようご注意ください。
      </div>
    </div>

    <div class="panel">
      <h3 class="mt-0">バックアップ・復元（JSON・CSV）</h3>
      <p>最終バックアップ日時：<b>${lastBackup}</b> ${overdue ? '<span class="status-pill status-target">バックアップを推奨します</span>' : ''}</p>
      <div class="flex-row">
        <button class="btn btn-primary" id="btn-export-json">JSONバックアップを書き出す</button>
        <button class="btn btn-ghost" id="btn-export-csv">CSVで一覧を書き出す</button>
      </div>
      <div class="form-field form-field--full" style="margin-top:16px;">
        <label>JSONバックアップから復元</label>
        <input type="file" id="file-json" accept="application/json">
        <div class="form-error" id="err-import-json"></div>
      </div>
      <div class="form-field form-field--full">
        <label>CSVインポート（既存スプレッドシートからの取り込み）</label>
        <input type="file" id="file-csv" accept=".csv,text/csv">
        <div class="form-error" id="err-import-csv"></div>
        <p class="text-faint">列の順序：種類, ボトルNo.(空欄可), ボトル名(空欄可), ボトル名（カナ）(空欄可), お客様名, フリガナ, 来店日(YYYY-MM-DD), 特徴・注意事項, 星(TRUE/FALSE)</p>
      </div>
    </div>

    <div class="panel">
      <h3 class="mt-0">設定</h3>
      <div class="form-grid">
        <div class="form-field">
          <label>破棄対象の判定（経過月数）</label>
          <input type="number" id="s-threshold" value="${s.disposalThresholdMonths}" min="1">
        </div>
        <div class="form-field">
          <label>「まもなく破棄対象」表示（何日前から）</label>
          <input type="number" id="s-nearDays" value="${s.nearDisposalWarningDays}" min="0">
        </div>
        <div class="form-field">
          <label>ボトルNo. 標準上限（種類ごと）</label>
          <input type="number" id="s-defaultMax" value="${s.defaultMaxBottleNo}" min="1">
        </div>
        <div class="form-field">
          <label>バックアップ推奨間隔（日）</label>
          <input type="number" id="s-backupInterval" value="${s.backupReminderIntervalDays}" min="1">
        </div>
      </div>
      <h4>種類ごとのボトルNo.上限（未入力は標準上限を使用）</h4>
      <div class="form-grid">
        ${BOTTLE_TYPES.map((t) => `
          <div class="form-field">
            <label>${t}</label>
            <input type="number" min="1" data-max-type="${t}" value="${s.maxBottleNoByType[t] || ''}" placeholder="${s.defaultMaxBottleNo}">
          </div>
        `).join('')}
      </div>
      <div class="flex-row" style="margin-top:16px;">
        <button class="btn btn-primary" id="btn-save-settings">設定を保存</button>
      </div>
    </div>

    <div class="panel">
      <h3 class="mt-0">履歴</h3>
      ${historyPanelHtml()}
    </div>
  `;

  root.querySelectorAll('[data-undo]').forEach((el) => {
    el.addEventListener('click', () => confirmUndo(el.dataset.undo));
  });

  root.querySelector('#btn-export-json').addEventListener('click', exportJsonBackup);
  root.querySelector('#btn-export-csv').addEventListener('click', exportCsv);
  root.querySelector('#file-json').addEventListener('change', (e) => handleJsonImport(e.target.files[0]));
  root.querySelector('#file-csv').addEventListener('change', (e) => handleCsvImport(e.target.files[0]));

  root.querySelector('#btn-save-sheetsync').addEventListener('click', async () => {
    APP.settings.sheetSyncUrl = root.querySelector('#s-sheetUrl').value.trim();
    APP.settings.sheetAutoSync = root.querySelector('#s-autoSync').checked;
    APP.settings.sheetAutoPullOnStart = root.querySelector('#s-autoPull').checked;
    await APP.storage.putSettings(APP.settings);
    showToast('連携設定を保存しました');
  });
  root.querySelector('#btn-sync-now').addEventListener('click', () => manualSyncNow());
  root.querySelector('#btn-pull-now').addEventListener('click', () => {
    const body = hasUnsyncedLocalChanges()
      ? `<div class="warning-box">⚠ この端末にはまだ送信していない変更が残っている可能性があります。先に取得すると、その変更は失われます。</div><p>共有データを取得して、この端末のデータを置き換えます。よろしいですか？</p>`
      : `<p>共有データを取得して、この端末のデータを置き換えます。よろしいですか？</p>`;
    const actions = `
      <button class="btn btn-ghost" id="m-cancel">キャンセル</button>
      <button class="btn btn-primary" id="m-confirm">取得する</button>
    `;
    const box = openModal('共有データの取得', body, actions);
    box.querySelector('#m-cancel').addEventListener('click', closeModal);
    box.querySelector('#m-confirm').addEventListener('click', async () => {
      closeModal();
      await pullFromSpreadsheet(false);
    });
  });

  root.querySelector('#btn-save-settings').addEventListener('click', async () => {
    const newSettings = { ...APP.settings };
    newSettings.disposalThresholdMonths = Number(root.querySelector('#s-threshold').value) || 3;
    newSettings.nearDisposalWarningDays = Number(root.querySelector('#s-nearDays').value) || 0;
    newSettings.defaultMaxBottleNo = Number(root.querySelector('#s-defaultMax').value) || 200;
    newSettings.backupReminderIntervalDays = Number(root.querySelector('#s-backupInterval').value) || 7;
    const maxByType = {};
    root.querySelectorAll('[data-max-type]').forEach((el) => {
      if (el.value) maxByType[el.dataset.maxType] = Number(el.value);
    });
    newSettings.maxBottleNoByType = maxByType;
    APP.settings = newSettings;
    await APP.storage.putSettings(newSettings);
    scheduleAutoSync();
    showToast('設定を保存しました');
  });
}

function isBackupOverdue() {
  const s = APP.settings;
  if (!s.lastBackupAt) return true;
  const daysSince = BKUtil.diffDays(BKUtil.jstDateFromISO(s.lastBackupAt), BKUtil.todayJST());
  return daysSince >= s.backupReminderIntervalDays;
}

function updateBackupStatusBadge() {
  const el = document.getElementById('backup-status');
  const s = APP.settings;
  const pushText = s.lastSheetPushAt ? new Date(s.lastSheetPushAt).toLocaleString('ja-JP') : '未実施';
  const pullText = s.lastSheetPullAt ? new Date(s.lastSheetPullAt).toLocaleString('ja-JP') : '未実施';
  el.innerHTML = `プッシュ: ${pushText}<br>プル: ${pullText}`;
}

function maybeShowBackupReminder() {
  if (isBackupOverdue()) {
    showToast('しばらくバックアップが行われていません。「バックアップ・設定」から書き出しをおすすめします。', 'warn');
  }
}

async function exportJsonBackup() {
  const data = await APP.storage.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bottlekeep-backup-${BKUtil.compactDate(BKUtil.todayJST())}.json`;
  a.click();
  URL.revokeObjectURL(url);

  APP.settings.lastBackupAt = BKUtil.nowISO();
  await APP.storage.putSettings(APP.settings);
  updateBackupStatusBadge();
  showToast('JSONバックアップを書き出しました');
}

function exportCsv() {
  const header = ['種類', 'ボトルNo.', 'ボトル名', 'ボトル名（カナ）', 'お客様名', 'フリガナ', '最終来店日', '特徴・注意事項', '星', '状態'];
  const rows = APP.bottles.filter((b) => b.status === 'active').map((b) => {
    const c = getCustomer(b.customerId);
    const status = computeStatus(b, c);
    return [b.bottleType, b.bottleNo, (b.bottleName || '').replaceAll(',', '、'), (b.bottleNameKana || '').replaceAll(',', '、'), c.name, c.kana, b.lastVisitDate, (c.memo || '').replaceAll(',', '、'), c.star ? 'TRUE' : 'FALSE', status.label];
  });
  const csv = [header, ...rows].map((r) => r.join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bottlekeep-list-${BKUtil.compactDate(BKUtil.todayJST())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSVを書き出しました');
}

// スプレッドシート連携：種類ごとにシートを分けた、以前のインポート元ファイルに近い形式で送る
function buildSpreadsheetPayload() {
  const byTypeByNo = {};
  BOTTLE_TYPES.forEach((t) => { byTypeByNo[t] = {}; });
  APP.bottles.filter((b) => b.status === 'active').forEach((b) => {
    const c = getCustomer(b.customerId);
    if (!byTypeByNo[b.bottleType]) byTypeByNo[b.bottleType] = {};
    const status = computeStatus(b, c);
    byTypeByNo[b.bottleType][b.bottleNo] = [
      b.bottleNo,
      b.bottleName || '',
      b.bottleNameKana || '',
      c ? c.name : '',
      c ? c.kana : '',
      b.lastVisitDate,
      c ? c.memo : '',
      c && c.star ? '★' : '',
      status.label.replaceAll('<br>', ''),
    ];
  });
  // 番号が飛ばずに1〜上限まで並ぶよう、使われていない番号も空欄の行として埋める
  const rowsByType = {};
  BOTTLE_TYPES.forEach((t) => {
    const max = maxNoFor(t);
    const rows = [];
    for (let n = 1; n <= max; n++) {
      rows.push(byTypeByNo[t][n] || [n, '', '', '', '', '', '', '', '']);
    }
    rowsByType[t] = rows;
  });
  return {
    header: ['番号', 'ボトル名', 'ボトル名（カナ）', 'お客様名', 'フリガナ', '最終来店日', '特徴・注意事項', '★', '状態'],
    bottleTypes: BOTTLE_TYPES,
    rowsByType,
    totalCount: APP.bottles.filter((b) => b.status === 'active').length,
    syncedAt: BKUtil.nowISO(),
    // まるごと復元用の生データ（他端末が「取得」した時に使う）。
    // 操作履歴は際限なく増えるとスプレッドシートのセル上限に触れる恐れがあるため、直近300件のみ含める。
    rawExport: {
      exportedAt: BKUtil.nowISO(),
      customers: APP.customers,
      bottles: APP.bottles,
      visits: APP.visits,
      disposalHistory: APP.disposalHistory,
      operationLogs: [...APP.operationLogs].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, 300),
      settings: APP.settings,
    },
  };
}

// Google Apps Script の Web App URL へ、現在のデータを送信する（共有スプレッドシートへの書き込み）。
// ブラウザの制約上（CORS）、送信が実際に成功したかどうかを厳密には確認できないため、
// 通信が完了したら「送信しました」という扱いにしている（silent=true の場合はトースト非表示）。
// fetch + mode:'no-cors' は、Apps Script側でのリダイレクトの都合で
// POSTの中身が実際には届かないことがある（届いたように見えて実は失敗する）ため、
// 隠しiframe＋フォーム送信という、リダイレクトに強い方式で送信する
async function submitViaHiddenForm(url, payloadJson) {
  // 以前は隠しiframe＋フォーム送信で行っていたが、iPadでホーム画面に追加した状態（PWA的な起動）だと
  // iframe経由の送信が制限され、届かないことがあるようだった。fetch + no-cors の方が
  // シンプルでこうした制約を受けにくいため、こちらに切り替える。
  // no-corsモードのため成否はレスポンスから読み取れないが、Apps Script側は
  // e.postData.contents（生のPOST本文）を読む実装に既になっているので、そのまま送れる。
  let fetchError = null;
  try {
    await fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payloadJson,
    });
  } catch (err) {
    fetchError = err;
    console.error('[BottleKeeper] fetch送信でエラー:', err);
  }
  if (fetchError) {
    throw new Error(`ネットワーク送信に失敗しました：${fetchError.message || fetchError}`);
  }
  // サーバー側の処理（分割書き込み等）が完了するまで少し待つ
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

async function syncToSpreadsheet(silent = false) {
  const url = getSheetSyncUrl();
  // 安全対策：この端末にデータが1件も無い状態で送信すると、共有シートを空で
  // 上書きしてしまう事故につながるため、必ず拒否する（自動・手動を問わず）。
  if (APP.customers.length === 0 && APP.bottles.length === 0) {
    if (!silent) showToast('この端末にはデータが1件もないため、送信を中止しました（共有データを誤って消さないための安全対策です）。先に「取得（プル）」を行ってください。', 'error');
    return false;
  }
  try {
    await submitViaHiddenForm(url, JSON.stringify(buildSpreadsheetPayload()));
    APP.settings.lastSheetPushAt = BKUtil.nowISO();
    await APP.storage.putSettings(APP.settings);
    updateSheetSyncStatus();
    // 補足：送信の仕組み上（クロスオリジンのため）、届いたかをその場で確実に検証することはできない。
    // 以前は取得し直して照合する確認を行っていたが、Google側の読み取りキャッシュの影響で
    // 実際は成功しているのに失敗と誤判定することが多く、かえって混乱を招くため取りやめた。
    // 確実に確認したい場合は、スプレッドシートの「_共有データ」シートを直接開いて確認するのが最も確実。
    if (!silent) showToast('スプレッドシートへ送信しました');
    return true;
  } catch (err) {
    console.error('[BottleKeeper] 送信エラー:', err);
    if (!silent) showToast(`同期に失敗しました：${err && err.message ? err.message : err}`, 'error');
    return false;
  }
}

// このお客様のデータが最後に同期した後に変更されたかどうか
// （＝プッシュしていないローカル変更が残っているか）を判定する
function hasUnsyncedLocalChanges() {
  const lastMutation = APP.settings.lastLocalMutationAt;
  if (!lastMutation) return false;
  const lastSync = APP.settings.lastSheetPushAt;
  if (!lastSync) return true;
  return lastMutation > lastSync;
}

// JSONバックアップの復元や共有データの取得（プル）を行うと、バックアップ／共有データに
// 含まれる settings で丸ごと上書きされてしまう。スプレッドシート連携のURL等は
// 「この端末の接続設定」であり、データの中身とは別物なので、復元後も維持する。
async function importAllPreservingSyncSettings(data) {
  const preserved = {
    sheetSyncUrl: APP.settings.sheetSyncUrl,
    sheetAutoSync: APP.settings.sheetAutoSync,
    sheetAutoPullOnStart: APP.settings.sheetAutoPullOnStart,
    lastSheetPushAt: APP.settings.lastSheetPushAt,
    lastSheetPullAt: APP.settings.lastSheetPullAt,
    simpleModeBottle: APP.settings.simpleModeBottle,
    simpleModeCustomer: APP.settings.simpleModeCustomer,
    // プル直後は、この端末の状態は共有データと完全に一致しているはずなので、
    // 「まだ送信していない変更」は無いものとしてリセットする
    lastLocalMutationAt: null,
  };
  await APP.storage.importAll(data);
  await refreshCache(false);
  const restored = await APP.storage.getSettings();
  APP.settings = { ...DEFAULT_SETTINGS, ...restored, ...preserved };
  await APP.storage.putSettings(APP.settings);
}

// 共有スプレッドシートから最新の全データを取得し、ローカルのデータを置き換える。
// ローカルに未送信の変更が残っている場合は、呼び出し側で確認を取ってから呼ぶこと。
// fetch でGETすると、Google側のリダイレクト先（googleusercontent.com）にCORSヘッダーが無いため、
// レスポンスの中身を読み取れない（ブロックされる）。そのため、隠しiframeでURLを読み込み、
// Apps Script側からpostMessageで結果を受け取る方式にする。
// script タグでの読み込み（JSONP）はCORSの制約を受けないため、これで共有データを取得する。
// iframe+postMessage方式は、Apps Script側のHTML出力が独自にサンドボックス化されるため
// うまく届かないことがあり、JSONPの方が確実に動作する。
// Googleスプレッドシート公式の「gviz」JSON書き出し機能を使って、指定シートのA1セルの値を取得する。
// これはGoogle自身が長年提供している仕組みで、Apps Script経由の応答よりもブラウザ間の相性問題が起きにくい。
// 前提：スプレッドシートが「リンクを知っている人は閲覧可」に設定されていること。
function fetchSheetColumnViaGviz(sheetId, sheetName, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const callbackName = `bottleKeepGviz_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const params = new URLSearchParams();
    params.set('tqx', `out:json;responseHandler:${callbackName}`);
    params.set('sheet', sheetName);
    params.set('range', 'A:A'); // データは分割されて複数行にまたがることがあるため、A列全体を取得する
    params.set('headers', '0');
    const scriptUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?${params.toString()}`;
    const script = document.createElement('script');
    let done = false;

    function cleanup() {
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
    }
    window[callbackName] = (resp) => {
      if (done) return;
      done = true;
      cleanup();
      try {
        const rows = (resp && resp.table && resp.table.rows) || [];
        const combined = rows.map((r) => (r && r.c && r.c[0] && r.c[0].v) || '').join('');
        resolve(combined || null);
      } catch (e) {
        reject(e);
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('応答がありませんでした（タイムアウト）'));
    }, timeoutMs);
    script.onerror = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('スクリプトの読み込みに失敗しました'));
    };
    script.src = scriptUrl;
    document.head.appendChild(script);
  });
}

// gviz経由の読み取りは、書き込み直後は少し古い内容を返すことがある（Google側の反映ラグ）。
// そのため何度か読み直し、その中で一番新しい exportedAt のものを採用する。
async function pullFromSpreadsheet(silent = false) {
  let cellValue;
  try {
    cellValue = await fetchSheetColumnViaGviz(BUILT_IN_SPREADSHEET_ID, '_共有データ');
  } catch (err) {
    if (!silent) showToast(`取得に失敗しました（${err && err.message ? err.message : err}）`, 'error');
    return false;
  }
  if (!cellValue) {
    if (!silent) showToast('共有データがまだありません（一度も同期されていません）', 'error');
    return false;
  }
  let rawExport;
  try {
    rawExport = JSON.parse(cellValue);
  } catch (err) {
    if (!silent) showToast('取得したデータの形式が正しくありませんでした', 'error');
    return false;
  }
  // 安全対策：取得した共有データが空（顧客・ボトルとも0件）なのに、
  // この端末には既にデータがある場合は、誤って良いデータを消してしまわないよう取得を中止する。
  const incomingCount = (rawExport.customers || []).length + (rawExport.bottles || []).length;
  const localCount = APP.customers.length + APP.bottles.length;
  if (incomingCount === 0 && localCount > 0) {
    if (!silent) showToast('共有データが空だったため、取得を中止しました（この端末の既存データを守るための安全対策です）。スプレッドシート側の状態をご確認ください。', 'error');
    return false;
  }
  await importAllPreservingSyncSettings(rawExport);
  APP.settings.lastSheetPullAt = BKUtil.nowISO();
  await APP.storage.putSettings(APP.settings);
  updateSheetSyncStatus();
  if (!silent) showToast('共有データを取得しました');
  renderScreen(APP.currentScreen);
  return true;
}

function updateSheetSyncStatus() {
  const el = document.getElementById('sheet-sync-status');
  const s = APP.settings;
  const pushText = s.lastSheetPushAt ? `最終プッシュ：${new Date(s.lastSheetPushAt).toLocaleString('ja-JP')}` : '最終プッシュ：未実施';
  const pullText = s.lastSheetPullAt ? `最終プル：${new Date(s.lastSheetPullAt).toLocaleString('ja-JP')}` : '最終プル：未実施';
  if (el) el.innerHTML = `${pushText}<br>${pullText}`;
  updateBackupStatusBadge();
}

function handleJsonImport(file) {
  if (!file) return;
  const errEl = document.getElementById('err-import-json');
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (e) {
      errEl.textContent = 'ファイルの形式が正しくありません（JSONとして読み込めません）。';
      return;
    }
    const requiredKeys = ['customers', 'bottles', 'visits', 'disposalHistory'];
    const valid = requiredKeys.every((k) => Array.isArray(data[k]));
    if (!valid) {
      errEl.textContent = 'バックアップファイルの形式が正しくありません。';
      return;
    }
    confirmOverwriteImport(data);
  };
  reader.onerror = () => { errEl.textContent = 'ファイルの読み込みに失敗しました。'; };
  reader.readAsText(file);
}

function confirmOverwriteImport(data) {
  const body = `
    <p>現在のデータをすべて上書きして復元します。</p>
    <p>顧客数：${data.customers.length}件 / ボトル数：${data.bottles.length}件</p>
    <p style="color:var(--color-danger-strong);"><b>この操作は取り消せません。よろしいですか？</b></p>
  `;
  const actions = `
    <button class="btn btn-ghost" id="m-cancel">キャンセル</button>
    <button class="btn btn-danger" id="m-confirm1">上書きする</button>
  `;
  const box = openModal('復元の確認（1/2）', body, actions);
  box.querySelector('#m-cancel').addEventListener('click', closeModal);
  box.querySelector('#m-confirm1').addEventListener('click', () => {
    const body2 = `<p><b>本当によろしいですか？</b><br>現在のデータは完全に置き換わります。</p>`;
    const actions2 = `
      <button class="btn btn-ghost" id="m-cancel2">キャンセル</button>
      <button class="btn btn-danger" id="m-confirm2">はい、復元する</button>
    `;
    const box2 = openModal('復元の確認（2/2・最終確認）', body2, actions2);
    box2.querySelector('#m-cancel2').addEventListener('click', closeModal);
    box2.querySelector('#m-confirm2').addEventListener('click', async () => {
      await importAllPreservingSyncSettings(data);
      closeModal();
      showToast('データを復元しました');
      renderScreen('backup');
    });
  });
}

function handleCsvImport(file) {
  if (!file) return;
  const errEl = document.getElementById('err-import-csv');
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const text = reader.result;
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) { errEl.textContent = 'データ行が見つかりませんでした。'; return; }
      const dataLines = lines.slice(1); // 先頭行はヘッダーとして無視
      let imported = 0, skipped = 0;
      const now = BKUtil.nowISO();
      // このCSV内での重複（同じ名前が複数行にまたがる＝1人が複数本持っている場合）だけをまとめる。
      // 既存のお客様への自動統合はしない（誤って別人と結びつくのを防ぐため、統合は「統合」画面で手動確認して行う）
      const batchCustomers = new Map(); // "正規化名前__正規化カナ" -> customer
      for (const line of dataLines) {
        const cols = line.split(',').map((c) => c.trim());
        const [type, noStr, bottleName, bottleNameKana, name, kana, visitDate, memo, starStr] = cols;
        if (!type || !name || !visitDate) { skipped++; continue; }
        const finalType = BOTTLE_TYPES.includes(type) ? type : 'その他';
        let no = noStr ? Number(noStr) : null;
        if (!no || !isBottleNoFree(finalType, no)) {
          no = allocateBottleNo(finalType);
        }
        if (no === null) { skipped++; continue; }

        const batchKey = `${BKUtil.normalizeName(name)}__${BKUtil.normalizeKana(kana || '')}`;
        let customer = batchCustomers.get(batchKey);
        if (!customer) {
          customer = { id: BKUtil.uuid(), name, kana: kana || '', memo: memo || '', star: (starStr || '').toUpperCase() === 'TRUE', createdAt: now, updatedAt: now };
          await APP.storage.putCustomer(customer);
          await logOperation('新規登録', 'customer', customer.id, null, customer, 'CSVインポート');
          APP.customers.push(customer);
          batchCustomers.set(batchKey, customer);
        }
        const bottle = { id: BKUtil.uuid(), bottleNo: no, bottleType: finalType, bottleName: bottleName || '', bottleNameKana: bottleNameKana || '', customerId: customer.id, status: 'active', lastVisitDate: visitDate, createdAt: now, updatedAt: now };
        await APP.storage.putBottle(bottle);
        await logOperation('新規登録', 'bottle', bottle.id, null, bottle, 'CSVインポート');
        APP.bottles.push(bottle);
        imported++;
      }
      await refreshCache();
      showToast(`CSVインポート完了：${imported}件取り込み、${skipped}件スキップ。似た名前は自動統合されません。重複があれば「統合」画面でご確認ください。`);
      renderScreen('backup');
    } catch (e) {
      errEl.textContent = 'CSVの読み込み中にエラーが発生しました。列の形式をご確認ください。';
    }
  };
  reader.onerror = () => { errEl.textContent = 'ファイルの読み込みに失敗しました。'; };
  reader.readAsText(file);
}
