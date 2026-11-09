/* =====================================================================
   A4 Godagama – Avissawella widening (feasibility study): classified
   vehicle count
   ---------------------------------------------------------------------
   Setup: enumerator and count location (station). Then, for each time
   interval (date, from, to, direction) the enumerator taps one counter per
   vehicle passing. "Save interval" writes one row with each vehicle type's
   count, the passenger and freight totals and the overall total, and the
   next interval starts where this one ended (same length, same direction).

   Offline-first, like the other survey apps: saved intervals go to
   localStorage first and are sent to the Apps Script backend in batches
   (every 15 s and on reconnect). The interval being counted is kept as a
   draft, so a reload or a phone call never loses the running counts.
   ===================================================================== */

const CONFIG = Object.assign({ appsScriptUrl: '', locations: [], directions: [] }, window.A4VC_CONFIG || {});
const PLACEHOLDER_URL = 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE';
const SURVEY_TYPE = 'a4-vehicle-count';
const SYNC_ACTION = 'submit_a4_vehcount_v1';
const BATCH_SIZE = 50;
const SYNC_INTERVAL_MS = 15000;

const QUEUE_KEY = 'a4vc_queue';     // intervals waiting to sync
const BACKUP_KEY = 'a4vc_backup';   // every interval saved on this device
const SESSION_KEY = 'a4vc_session'; // enumerator / location
const DRAFT_KEY = 'a4vc_draft';     // the interval currently being counted
const HISTORY_KEY = 'a4vc_history'; // undo-save stack (eventIds)
const DIRECTIONS_KEY = 'a4vc_directions';
const THEME_KEY = 'a4vc_theme';

const TUKTUK_SVG = '<svg class="svg-icon" viewBox="1.8 1.4 28.4 23" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="M2.5 13V6.2Q2.5 2 7 2H24.2Q26.4 2 26.7 3.8L27.9 12.4H26.1L25.1 4.3H7.6Q5.3 4.3 5.3 6.6V13Z"/><path d="M3.5 12.6H27.4Q29.7 12.6 29.7 15Q29.7 16.4 28.6 17.6L27.8 18.6H10.77A3.6 3.6 0 0 0 5.23 18.6H4.6Q2.4 18.6 2.4 16.2V13.7Q2.4 12.6 3.5 12.6ZM27.5 14.6a0.85 0.85 0 1 0 1.7 0a0.85 0.85 0 1 0 -1.7 0Z"/><path d="M22.6 12.6L24.6 8.4L25.5 8.8L23.8 12.6Z"/><path d="M5 20.9a3 3 0 1 0 6 0a3 3 0 1 0 -6 0ZM6.9 20.9a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0ZM24 21.4a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0ZM25.6 21.4a0.9 0.9 0 1 0 1.8 0a0.9 0.9 0 1 0 -1.8 0Z"/><path d="M26.05 18.4H26.95V20.5H26.05Z"/></svg>';

// Vehicle types, in button order. `id` is the field name sent to the sheet;
// `sub` is the axle / wheel description shown under the name.
const GROUPS = [
    { id: 'passenger', label: 'Passenger vehicles' },
    { id: 'freight', label: 'Freight vehicles' }
];
const TYPES = [
    { id: 'motorcycle', group: 'passenger', label: 'Motorcycle', icon: 'fa-motorcycle' },
    { id: 'threeWheeler', group: 'passenger', label: '3-wheeler', icon: TUKTUK_SVG },
    { id: 'taxi', group: 'passenger', label: 'Taxi', icon: 'fa-taxi' },
    { id: 'carJeep', group: 'passenger', label: 'Car / Jeep', icon: 'fa-car-side' },
    { id: 'passengerVan', group: 'passenger', label: 'Passenger van', icon: 'fa-van-shuttle' },
    { id: 'officeVan', group: 'passenger', label: 'Office van', icon: 'fa-van-shuttle' },
    { id: 'schoolVan', group: 'passenger', label: 'School van', icon: 'fa-bus-simple' },
    { id: 'minibus', group: 'passenger', label: 'Minibus', icon: 'fa-van-shuttle' },
    { id: 'largeBus', group: 'passenger', label: 'Large bus', icon: 'fa-bus' },
    { id: 'deliveryVan', group: 'freight', label: 'Delivery van', icon: 'fa-van-shuttle' },
    { id: 'lightTruck', group: 'freight', label: 'Light truck', sub: '2 axles / 4 wheels', icon: 'fa-truck-pickup' },
    { id: 'mediumTruck', group: 'freight', label: 'Medium truck', sub: '2 axles / 6 wheels', icon: 'fa-truck' },
    { id: 'largeTruck', group: 'freight', label: 'Large truck', sub: '2 axles / 6 wheels', icon: 'fa-truck-front' },
    { id: 'heavyVehicle', group: 'freight', label: 'Heavy vehicle', sub: '3 axles / 10 wheels', icon: 'fa-truck-field' },
    { id: 'container20', group: 'freight', label: 'Container with trailer', sub: '3 axles / 20 ft', icon: 'fa-truck-moving' },
    { id: 'container40', group: 'freight', label: 'Container with trailer', sub: 'Multi-axle / 40 ft', icon: 'fa-truck-ramp-box' },
    { id: 'otherFreight', group: 'freight', label: 'Other freight', sub: 'Write it in Notes', icon: 'fa-ellipsis' }
];
const typeName = t => t.sub && !/Notes/.test(t.sub) ? `${t.label} (${t.sub})` : t.label;

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
        return fallback;
    }
}
function writeJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (e) {
        console.error('localStorage write failed for', key, e);
        showStorageWarning();
        return false;
    }
}
function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
const pad2 = n => String(n).padStart(2, '0');
function formatDate(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function formatTime(ts) { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function nowHHMM() { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function toMinutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function fromMinutes(mins) { mins = ((mins % 1440) + 1440) % 1440; return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`; }
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
}
const $ = id => document.getElementById(id);
const iconHtml = icon => icon.startsWith('<') ? icon.replace('class="svg-icon"', 'class="svg-icon ctr-icon"') : `<i class="fa-solid ${icon} ctr-icon" aria-hidden="true"></i>`;

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let session = readJSON(SESSION_KEY, null);
let draft = readJSON(DRAFT_KEY, null);
let isSyncing = false;
let inFlightIds = new Set();
let lastSyncError = null;

function blankCounts() { const c = {}; TYPES.forEach(t => { c[t.id] = 0; }); return c; }
function newDraft(prev) {
    return {
        date: (prev && prev.date) || formatDate(Date.now()),
        from: (prev && prev.from) || '',
        to: (prev && prev.to) || '',
        direction: (prev && prev.direction) || '',
        notes: (prev && prev.notes) || '',
        counts: blankCounts(),
        taps: []
    };
}
if (!draft || !draft.counts) draft = newDraft();
TYPES.forEach(t => { if (typeof draft.counts[t.id] !== 'number') draft.counts[t.id] = 0; });

const screens = { setup: $('screen-setup'), survey: $('screen-survey') };
function showScreen(name) {
    Object.keys(screens).forEach(k => screens[k].classList.toggle('active', k === name));
    document.body.classList.toggle('on-survey', name === 'survey');
}
function saveSession() { writeJSON(SESSION_KEY, session); }
function saveDraft() { writeJSON(DRAFT_KEY, draft); }

// ---------------------------------------------------------------------
// Toasts, modal, storage warning
// ---------------------------------------------------------------------
let toastTimer = null;
function showToast(message, type = 'success') {
    const c = $('toast-container');
    c.innerHTML = '';
    const t = el('div', `toast ${type}`);
    t.textContent = message;
    c.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2200);
}
function openModal({ title, html, okLabel = 'OK', cancelLabel = 'Cancel', danger = false, showCancel = true }) {
    return new Promise(resolve => {
        const modal = $('modal'), ok = $('modal-ok'), cancel = $('modal-cancel');
        $('modal-title').textContent = title;
        $('modal-body').innerHTML = html;
        ok.textContent = okLabel;
        ok.classList.toggle('danger', danger);
        cancel.textContent = cancelLabel;
        cancel.classList.toggle('hidden', !showCancel);
        modal.classList.remove('hidden');
        const close = r => {
            modal.classList.add('hidden');
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            resolve(r);
        };
        const onOk = () => close(true);
        const onCancel = () => close(false);
        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
    });
}
let storageWarningEl = null;
function showStorageWarning() {
    if (storageWarningEl && document.body.contains(storageWarningEl)) return;
    storageWarningEl = el('div', 'storage-warning', 'DEVICE STORAGE FULL: counts may NOT be saved. Sync or export a backup now. <button type="button">Dismiss</button>');
    storageWarningEl.setAttribute('role', 'alert');
    storageWarningEl.querySelector('button').addEventListener('click', () => { storageWarningEl.remove(); storageWarningEl = null; });
    document.body.prepend(storageWarningEl);
    if (navigator.onLine) syncQueue();
}

// ---------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------
function applyTheme(theme) {
    const isLight = theme === 'light';
    document.body.classList.toggle('light-theme', isLight);
    $('theme-toggle').querySelector('i').className = isLight ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    document.querySelector('meta[name="theme-color"]').setAttribute('content', isLight ? '#f1f5f9' : '#0f172a');
}
$('theme-toggle').addEventListener('click', () => {
    const next = document.body.classList.contains('light-theme') ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme(next);
});

// ---------------------------------------------------------------------
// Setup screen
// ---------------------------------------------------------------------
const inputName = $('surveyor-name');
const inputLoc = $('location-name');
const btnStart = $('btn-start');

function normLocation(s) {
    return (s || '').trim().replace(/\s+/g, ' ');
}

function renderLocationChips() {
    const box = $('location-chips');
    box.innerHTML = '';
    box.classList.toggle('hidden', !CONFIG.locations.length);
    CONFIG.locations.forEach(l => {
        const b = el('button', 'chip-opt', `<span>${escapeHtml(l)}</span>`);
        b.type = 'button';
        b.dataset.value = l;
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => { inputLoc.value = l; $('gps-status').classList.add('hidden'); checkSetupForm(); });
        box.appendChild(b);
    });
}
function checkSetupForm() {
    const loc = normLocation(inputLoc.value);
    $('location-chips').querySelectorAll('button').forEach(b => {
        const on = b.dataset.value === loc;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
    });
    const ok = inputName.value.trim() && loc;
    btnStart.disabled = !ok;
    btnStart.classList.toggle('btn-disabled', !ok);
}
[inputName, inputLoc].forEach(i => i.addEventListener('input', checkSetupForm));

$('btn-gps').addEventListener('click', () => {
    const status = $('gps-status');
    status.className = 'status-text';
    status.textContent = 'Getting coordinates...';
    if (!('geolocation' in navigator)) {
        status.className = 'status-text err';
        status.textContent = 'GPS is not supported on this device. Type the location instead.';
        return;
    }
    navigator.geolocation.getCurrentPosition(
        pos => {
            inputLoc.value = `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
            status.className = 'status-text ok';
            status.textContent = `GPS saved (accuracy ~${Math.round(pos.coords.accuracy)} m)`;
            checkSetupForm();
        },
        () => {
            status.className = 'status-text err';
            status.textContent = 'GPS failed. Turn on location, or pick / type the location.';
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
});

btnStart.addEventListener('click', () => {
    if (btnStart.disabled) return;
    session = {
        id: generateId(),
        active: true,
        name: inputName.value.trim(),
        location: normLocation(inputLoc.value),
        startedAt: Date.now()
    };
    saveSession();
    writeJSON(HISTORY_KEY, []);
    startSurveyScreen();
});

function startSurveyScreen() {
    $('info-location').textContent = session.location;
    $('info-name').textContent = session.name;
    renderInterval();
    renderCounters();
    renderSaved();
    updateSyncStatus();
    showScreen('survey');
}

// ---------------------------------------------------------------------
// Interval (date, from, to, direction)
// ---------------------------------------------------------------------
const dateInput = $('count-date');
const dirInput = $('direction');
const notesInput = $('interval-notes');

function intervalMinutes() {
    if (!draft.from || !draft.to) return null;
    let m = toMinutes(draft.to) - toMinutes(draft.from);
    if (m < 0) m += 1440; // runs past midnight
    return m;
}

// Direction: the preset buttons (To / From Colombo) or "Other", which opens a
// box to type any other direction. The box stays hidden otherwise, so more
// counters fit on a phone screen.
let otherDirection = false;
const isPresetDirection = d => CONFIG.directions.some(p => p[0].toLowerCase() === (d || '').trim().toLowerCase());

function renderDirectionChips() {
    const box = $('direction-chips');
    box.innerHTML = '';
    CONFIG.directions.concat([['Other', 'fa-pen', true]]).forEach(([d, icon, other]) => {
        const b = el('button', 'chip-opt', `<i class="fa-solid ${icon}"></i><span>${escapeHtml(d)}</span>`);
        b.type = 'button';
        b.dataset.value = other ? '' : d;
        if (other) b.dataset.other = '1';
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => {
            otherDirection = !!other;
            if (other) { if (isPresetDirection(draft.direction)) draft.direction = ''; }
            else draft.direction = d;
            saveDraft();
            renderInterval();
            if (other) dirInput.focus();
        });
        box.appendChild(b);
    });
}

function renderInterval() {
    dateInput.value = draft.date || '';
    const preset = isPresetDirection(draft.direction);
    const other = otherDirection || (!!(draft.direction || '').trim() && !preset);
    const typed = preset ? '' : (draft.direction || '');
    if (dirInput.value !== typed) dirInput.value = typed;
    dirInput.classList.toggle('hidden', !other);
    notesInput.value = draft.notes || '';
    $('direction-chips').querySelectorAll('button').forEach(b => {
        const on = b.dataset.other ? other : b.dataset.value.toLowerCase() === (draft.direction || '').trim().toLowerCase();
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
    });
    [['btn-from', draft.from], ['btn-to', draft.to]].forEach(([id, v]) => {
        const b = $(id);
        b.querySelector('.time-val').textContent = v || '--:--';
        b.classList.toggle('empty', !v);
    });
    const info = $('interval-info');
    const m = intervalMinutes();
    if (m === null) { info.textContent = 'Set From and To for this count.'; info.classList.remove('warn'); }
    else if (m === 0) { info.textContent = 'From and To are the same time - check them.'; info.classList.add('warn'); }
    else {
        const overnight = toMinutes(draft.to) < toMinutes(draft.from);
        info.textContent = `Interval: ${m} min` + (overnight ? ' (runs past midnight - check times)' : '');
        info.classList.toggle('warn', overnight);
    }
    const presets = CONFIG.directions.map(d => d[0].toLowerCase());
    const dl = $('direction-list');
    dl.innerHTML = readJSON(DIRECTIONS_KEY, []).filter(d => !presets.includes(d.toLowerCase()))
        .map(d => `<option value="${escapeHtml(d)}"></option>`).join('');
}

dateInput.addEventListener('change', () => { draft.date = dateInput.value; saveDraft(); });
dirInput.addEventListener('input', () => { otherDirection = true; draft.direction = dirInput.value; saveDraft(); renderInterval(); });
notesInput.addEventListener('input', () => { draft.notes = notesInput.value; saveDraft(); });
$('btn-from').addEventListener('click', () => openTimePicker('from', 'From'));
$('btn-to').addEventListener('click', () => openTimePicker('to', 'To'));

function rememberDirection(d) {
    d = (d || '').trim();
    if (!d) return;
    const list = readJSON(DIRECTIONS_KEY, []).filter(x => x.toLowerCase() !== d.toLowerCase());
    list.unshift(d);
    writeJSON(DIRECTIONS_KEY, list.slice(0, 12));
}

// ---------------------------------------------------------------------
// Counters (one grid per group: passenger, freight)
// ---------------------------------------------------------------------
const countersEl = $('counters');

function buildCounters() {
    countersEl.innerHTML = '';
    GROUPS.forEach(g => {
        const head = el('h2', 'counter-group', `${escapeHtml(g.label)} <span class="group-total" data-group="${g.id}">0</span>`);
        const grid = el('div', 'counter-grid');
        grid.setAttribute('aria-label', g.label);
        TYPES.filter(t => t.group === g.id).forEach(t => {
            const box = el('div', 'counter');
            box.dataset.type = t.id;
            const btn = el('button', 'counter-main',
                iconHtml(t.icon) +
                `<span class="ctr-label">${escapeHtml(t.label)}</span>` +
                (t.sub ? `<span class="ctr-sub">${escapeHtml(t.sub)}</span>` : '') +
                `<span class="ctr-count">0</span>`);
            btn.type = 'button';
            btn.addEventListener('click', () => {
                draft.counts[t.id] += 1;
                draft.taps.push(t.id);
                if (draft.taps.length > 2000) draft.taps = draft.taps.slice(-2000);
                saveDraft();
                btn.classList.remove('tapped');
                void btn.offsetWidth;
                btn.classList.add('tapped');
                vibrate(30);
                renderCounters();
            });
            const minus = el('button', 'ctr-minus', '<i class="fa-solid fa-minus" aria-hidden="true"></i>');
            minus.type = 'button';
            minus.setAttribute('aria-label', `Remove one ${typeName(t)}`);
            minus.addEventListener('click', () => {
                if (draft.counts[t.id] <= 0) return;
                draft.counts[t.id] -= 1;
                const i = draft.taps.lastIndexOf(t.id);
                if (i >= 0) draft.taps.splice(i, 1);
                saveDraft();
                renderCounters();
            });
            box.append(btn, minus);
            grid.appendChild(box);
        });
        countersEl.append(head, grid);
    });
}

const groupTotal = (counts, g) => TYPES.filter(t => t.group === g).reduce((s, t) => s + (counts[t.id] || 0), 0);
function intervalTotal() { return TYPES.reduce((s, t) => s + (draft.counts[t.id] || 0), 0); }

function renderCounters() {
    TYPES.forEach(t => {
        const box = countersEl.querySelector(`[data-type="${t.id}"]`);
        const n = draft.counts[t.id] || 0;
        box.querySelector('.ctr-count').textContent = n;
        box.querySelector('.counter-main').setAttribute('aria-label', `${typeName(t)}: ${n}. Tap to add one.`);
        box.querySelector('.ctr-minus').disabled = n === 0;
    });
    GROUPS.forEach(g => { countersEl.querySelector(`.group-total[data-group="${g.id}"]`).textContent = groupTotal(draft.counts, g.id); });
    $('total-count').textContent = intervalTotal();
}

function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

$('btn-undo-tap').addEventListener('click', () => {
    const last = draft.taps.pop();
    if (!last) { showToast('No taps to undo in this interval', 'error'); return; }
    if (draft.counts[last] > 0) draft.counts[last] -= 1;
    saveDraft();
    renderCounters();
    showToast(`Removed one ${typeName(TYPES.find(t => t.id === last))}`);
});

$('btn-reset').addEventListener('click', async () => {
    if (intervalTotal() === 0) return;
    const ok = await openModal({ title: 'Reset all counts?', html: 'All counts for this interval go back to 0. Saved intervals are not affected.', okLabel: 'Reset', danger: true });
    if (!ok) return;
    draft.counts = blankCounts();
    draft.taps = [];
    saveDraft();
    renderCounters();
});

// ---------------------------------------------------------------------
// Time wheel picker (same control as the Kerbside Interview app)
// ---------------------------------------------------------------------
const ITEM_H = 44;
const wheelHour = $('wheel-hour');
const wheelMinute = $('wheel-minute');
let pickerKey = null;

function buildWheel(node, count) {
    node.innerHTML = '';
    node.appendChild(el('div', 'spacer'));
    for (let i = 0; i < count; i++) {
        const it = el('div', 'item', pad2(i));
        it.dataset.i = i;
        it.addEventListener('click', () => setWheel(node, i, true));
        node.appendChild(it);
    }
    node.appendChild(el('div', 'spacer'));
    let raf = null;
    node.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = null; paintWheel(node); });
    });
    node.addEventListener('keydown', e => {
        const i = wheelIndex(node);
        if (e.key === 'ArrowDown') { e.preventDefault(); setWheel(node, Math.min(count - 1, i + 1), true); }
        if (e.key === 'ArrowUp') { e.preventDefault(); setWheel(node, Math.max(0, i - 1), true); }
    });
}
function wheelIndex(node) {
    const n = node.querySelectorAll('.item').length;
    return Math.max(0, Math.min(n - 1, Math.round(node.scrollTop / ITEM_H)));
}
function setWheel(node, i, smooth) {
    node.scrollTo({ top: i * ITEM_H, behavior: smooth ? 'smooth' : 'auto' });
    if (!smooth) paintWheel(node);
}
function paintWheel(node) {
    const i = wheelIndex(node);
    node.querySelectorAll('.item').forEach((it, k) => {
        it.classList.toggle('sel', k === i);
        it.classList.toggle('near', Math.abs(k - i) === 1);
    });
}
function openTimePicker(key, title) {
    pickerKey = key;
    $('time-sheet-title').textContent = title;
    $('time-sheet').classList.remove('hidden');
    const [h, m] = (draft[key] || nowHHMM()).split(':').map(Number);
    requestAnimationFrame(() => { setWheel(wheelHour, h, false); setWheel(wheelMinute, m, false); wheelHour.focus({ preventScroll: true }); });
}
function closeTimePicker() { $('time-sheet').classList.add('hidden'); pickerKey = null; }

$('time-done').addEventListener('click', () => {
    if (!pickerKey) return;
    draft[pickerKey] = `${pad2(wheelIndex(wheelHour))}:${pad2(wheelIndex(wheelMinute))}`;
    saveDraft();
    renderInterval();
    closeTimePicker();
});
$('time-now').addEventListener('click', () => {
    const d = new Date();
    setWheel(wheelHour, d.getHours(), true);
    setWheel(wheelMinute, d.getMinutes(), true);
});
$('time-clear').addEventListener('click', () => {
    if (!pickerKey) return;
    draft[pickerKey] = '';
    saveDraft();
    renderInterval();
    closeTimePicker();
});
$('time-sheet').addEventListener('click', e => { if (e.target.id === 'time-sheet') closeTimePicker(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && pickerKey) closeTimePicker(); });

// ---------------------------------------------------------------------
// Save interval / undo save
// ---------------------------------------------------------------------
$('btn-save').addEventListener('click', async () => {
    const problems = [];
    if (!draft.date) problems.push('Date');
    if (!draft.from) problems.push('From time');
    if (!draft.to) problems.push('To time');
    if (!(draft.direction || '').trim()) problems.push('Direction');
    if (problems.length) {
        showToast(`Please set: ${problems.join(', ')}`, 'error');
        return;
    }
    if (intervalMinutes() === 0) { showToast('From and To are the same time', 'error'); return; }
    if (draft.counts.otherFreight > 0 && !(draft.notes || '').trim()) {
        showToast('Write the "Other freight" vehicle type in Notes', 'error');
        notesInput.focus();
        return;
    }
    const total = intervalTotal();
    if (total === 0) {
        const ok = await openModal({
            title: 'Save a zero count?',
            html: `No vehicles were counted from ${escapeHtml(draft.from)} to ${escapeHtml(draft.to)}. Save this interval as 0?`,
            okLabel: 'Save 0'
        });
        if (!ok) return;
    }

    const now = Date.now();
    const record = {
        action: 'submit',
        surveyType: SURVEY_TYPE,
        eventId: generateId(),
        sessionId: session.id,
        name: session.name,
        location: session.location,
        date: draft.date,
        fromTime: draft.from,
        toTime: draft.to,
        intervalMinutes: intervalMinutes(),
        direction: draft.direction.trim(),
        notes: (draft.notes || '').trim(),
        passengerTotal: groupTotal(draft.counts, 'passenger'),
        freightTotal: groupTotal(draft.counts, 'freight'),
        total,
        savedAt: `${formatDate(now)} ${formatTime(now)}`
    };
    TYPES.forEach(t => { record[t.id] = draft.counts[t.id] || 0; });

    const queue = readJSON(QUEUE_KEY, []);
    queue.push(record);
    if (!writeJSON(QUEUE_KEY, queue)) { showToast('STORAGE FULL: interval NOT saved!', 'error'); return; }
    const backup = readJSON(BACKUP_KEY, []);
    backup.push(record);
    writeJSON(BACKUP_KEY, backup);
    const history = readJSON(HISTORY_KEY, []);
    history.push(record.eventId);
    writeJSON(HISTORY_KEY, history.slice(-50));
    rememberDirection(record.direction);

    // Next interval continues from this one's end, same length, same direction.
    const len = record.intervalMinutes;
    const next = newDraft({ date: draft.date, direction: draft.direction, from: draft.to, to: fromMinutes(toMinutes(draft.to) + len) });
    if (toMinutes(next.from) + len >= 1440) next.to = ''; // would run past midnight: let the enumerator set it
    draft = next;
    saveDraft();
    renderInterval();
    renderCounters();
    renderSaved();
    showToast(`Saved ${record.fromTime}–${record.toTime}: ${total}. Next: ${draft.from}–${draft.to || '?'}`);
    syncQueue();
});

$('btn-undo-save').addEventListener('click', async () => {
    const history = readJSON(HISTORY_KEY, []);
    const id = history[history.length - 1];
    if (!id) { showToast('Nothing to undo', 'error'); return; }
    if (inFlightIds.has(id)) { showToast('Sending it right now. Try again in a moment.', 'error'); return; }
    const record = readJSON(QUEUE_KEY, []).find(r => r.eventId === id);
    if (!record) {
        history.pop();
        writeJSON(HISTORY_KEY, history);
        showToast('Already synced to the sheet. Cannot undo.', 'error');
        return;
    }
    const ok = await openModal({
        title: 'Delete the last saved interval?',
        html: `${escapeHtml(record.fromTime)}–${escapeHtml(record.toTime)} · ${escapeHtml(record.direction)} · total ${record.total}.<br>Its counts will be put back on the counters so you can correct and save again.` +
            (intervalTotal() ? `<br><b>The ${intervalTotal()} count(s) now on the counters (${escapeHtml(draft.from || '?')}–${escapeHtml(draft.to || '?')}) will be replaced.</b>` : ''),
        okLabel: 'Delete',
        danger: true
    });
    if (!ok) return;
    history.pop();
    writeJSON(HISTORY_KEY, history);
    writeJSON(QUEUE_KEY, readJSON(QUEUE_KEY, []).filter(r => r.eventId !== id));
    writeJSON(BACKUP_KEY, readJSON(BACKUP_KEY, []).filter(r => r.eventId !== id));
    draft = newDraft({ date: record.date, from: record.fromTime, to: record.toTime, direction: record.direction, notes: record.notes });
    TYPES.forEach(t => { draft.counts[t.id] = record[t.id] || 0; });
    saveDraft();
    renderInterval();
    renderCounters();
    renderSaved();
    updateSyncStatus();
    showToast('Interval deleted and put back on the counters');
});

// ---------------------------------------------------------------------
// Saved intervals list
// ---------------------------------------------------------------------
function sessionRecords() {
    if (!session) return [];
    return readJSON(BACKUP_KEY, []).filter(r => r.sessionId === session.id);
}
function renderSaved() {
    const recs = sessionRecords();
    $('count-session').textContent = recs.length;
    const list = $('saved-list');
    if (!recs.length) { list.innerHTML = '<p class="saved-empty">No intervals saved yet.</p>'; return; }
    list.innerHTML = recs.slice().reverse().map(r => {
        const seen = TYPES.filter(t => r[t.id]).map(t => `${escapeHtml(typeName(t))} ${r[t.id]}`).join(' · ');
        return `
        <div class="saved-row">
            <span class="sr-time">${escapeHtml(r.fromTime)}–${escapeHtml(r.toTime)}</span>
            <span class="sr-dir">${escapeHtml(r.direction)}</span>
            <span class="sr-total">${r.total}</span>
            <span class="sr-types">Passenger ${r.passengerTotal} · Freight ${r.freightTotal}${seen ? ' — ' + seen : ''}</span>
            ${r.notes ? `<span class="sr-notes"><i class="fa-regular fa-note-sticky"></i> ${escapeHtml(r.notes)}</span>` : ''}
        </div>`;
    }).join('');
}

// ---------------------------------------------------------------------
// End survey
// ---------------------------------------------------------------------
$('btn-end').addEventListener('click', async () => {
    const recs = sessionRecords();
    const running = intervalTotal();
    const ok = await openModal({
        title: 'End survey?',
        html: `${recs.length} interval(s) saved at ${escapeHtml(session.location)}.` +
            (running ? `<br><b>The current interval (${running} counted) is not saved</b> and will be kept on the counters.` : ''),
        okLabel: 'End survey',
        danger: true
    });
    if (!ok) return;
    session.active = false;
    saveSession();
    writeJSON(HISTORY_KEY, []);
    syncQueue();
    const totals = {};
    TYPES.forEach(t => { totals[t.id] = recs.reduce((s, r) => s + (r[t.id] || 0), 0); });
    const sum = key => recs.reduce((s, r) => s + (r[key] || 0), 0);
    const pending = readJSON(QUEUE_KEY, []).length;
    await openModal({
        title: `${session.location}: survey ended`,
        html: `<table>
            <tr><td>Intervals saved</td><td>${recs.length}</td></tr>
            ${TYPES.map(t => `<tr><td>${escapeHtml(typeName(t))}</td><td>${totals[t.id]}</td></tr>`).join('')}
            <tr><td><b>Passenger vehicles</b></td><td>${sum('passengerTotal')}</td></tr>
            <tr><td><b>Freight vehicles</b></td><td>${sum('freightTotal')}</td></tr>
            <tr><td><b>All vehicles</b></td><td>${sum('total')}</td></tr>
            <tr><td>Waiting to sync (this device)</td><td>${pending}</td></tr>
        </table>` + (pending ? '<p style="margin-top:0.6rem">Keep the app open with internet until everything is synced, or export a backup.</p>' : ''),
        okLabel: 'New survey',
        showCancel: false
    });
    inputName.value = session.name;
    inputLoc.value = '';
    checkSetupForm();
    showScreen('setup');
});

// ---------------------------------------------------------------------
// Sync (batches of 50, removed from the queue only after server success)
// ---------------------------------------------------------------------
function isBackendConfigured() { return !!CONFIG.appsScriptUrl && CONFIG.appsScriptUrl !== PLACEHOLDER_URL; }

function syncQueue() {
    if (isSyncing || !navigator.onLine || !isBackendConfigured()) { updateSyncStatus(); return; }
    const queue = readJSON(QUEUE_KEY, []);
    if (!queue.length) { updateSyncStatus(); return; }
    const batch = queue.slice(0, BATCH_SIZE);
    isSyncing = true;
    inFlightIds = new Set(batch.map(r => r.eventId));
    updateSyncStatus();
    fetch(CONFIG.appsScriptUrl, {
        method: 'POST',
        body: JSON.stringify({ action: SYNC_ACTION, payload: batch }),
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    })
        .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(result => {
            if (result.status !== 'success') throw new Error(result.message || 'Server error');
            writeJSON(QUEUE_KEY, readJSON(QUEUE_KEY, []).filter(r => !inFlightIds.has(r.eventId)));
            lastSyncError = null;
        })
        .catch(err => { lastSyncError = err.message || String(err); console.error('Sync failed:', err); })
        .finally(() => {
            isSyncing = false;
            inFlightIds = new Set();
            updateSyncStatus();
            if (!lastSyncError && readJSON(QUEUE_KEY, []).length) setTimeout(syncQueue, 800);
        });
}

function updateSyncStatus() {
    const node = $('sync-status');
    const pending = readJSON(QUEUE_KEY, []).length;
    let cls = 'sync-status', label;
    if (!isBackendConfigured()) { cls += ' unconfigured'; label = `Not linked to sheet · ${pending} on device`; }
    else if (!navigator.onLine) { cls += ' offline'; label = `Offline · ${pending} pending`; }
    else if (isSyncing) { cls += ' syncing'; label = `Syncing · ${pending} pending`; }
    else if (lastSyncError && pending) { cls += ' error'; label = `Sync error · ${pending} pending`; }
    else if (pending) { cls += ' pending'; label = `Online · ${pending} pending`; }
    else label = 'Online · Synced';
    node.className = cls;
    node.querySelector('.sync-text').textContent = label;
    node.title = lastSyncError ? `Last error: ${lastSyncError}` : '';
}
window.addEventListener('online', () => { updateSyncStatus(); syncQueue(); });
window.addEventListener('offline', updateSyncStatus);

// ---------------------------------------------------------------------
// Local backup export
// ---------------------------------------------------------------------
function exportLocalBackup() {
    const records = readJSON(BACKUP_KEY, []);
    const pending = readJSON(QUEUE_KEY, []);
    if (!records.length && !pending.length && intervalTotal() === 0) { showToast('No counts on this device yet', 'error'); return; }
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records, pendingSync: pending, currentInterval: draft }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `a4_vehicle_counts_backup_${formatDate(Date.now())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Backup exported (${records.length} intervals)`);
}
$('btn-export').addEventListener('click', exportLocalBackup);
$('btn-export-setup').addEventListener('click', exportLocalBackup);

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
function init() {
    let theme = 'dark';
    try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
    applyTheme(theme);

    // Netlify's hosting badge sits in the bottom-right corner; the CSS keeps
    // the Save button out from under it. Netlify inserts its script after
    // app.js, so look again once the whole page has been parsed.
    const markHostBadge = () => {
        if (/\.netlify\.app$/.test(location.hostname) || document.querySelector('script[src*="/.netlify/scripts/"]')) {
            document.body.classList.add('has-host-badge');
        }
    };
    markHostBadge();
    document.addEventListener('DOMContentLoaded', markHostBadge);

    renderLocationChips();
    renderDirectionChips();
    buildCounters();
    buildWheel(wheelHour, 24);
    buildWheel(wheelMinute, 60);

    if (session) {
        inputName.value = session.name || '';
        inputLoc.value = session.location || '';
        checkSetupForm();
    }
    if (session && session.active) {
        startSurveyScreen();
        if (intervalTotal()) showToast('Counts for the current interval restored');
    }

    updateSyncStatus();
    setInterval(syncQueue, SYNC_INTERVAL_MS);
    if (!isBackendConfigured()) setTimeout(() => showToast('Apps Script URL not set: data is kept on this device only', 'error'), 600);
    syncQueue();
}

init();
