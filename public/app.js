'use strict';

/* ============================================================
   Caisse — suivi de portefeuille, dépenses et revenus
   Données stockées localement (localStorage), montants en centimes.
   ============================================================ */

const STORAGE_KEY = 'caisse.v1';

const DEFAULT_CATEGORIES = [
  { id: 'c-courses', name: 'Courses', icon: '🛒', kind: 'expense' },
  { id: 'c-logement', name: 'Logement', icon: '🏠', kind: 'expense' },
  { id: 'c-transport', name: 'Transport', icon: '🚗', kind: 'expense' },
  { id: 'c-resto', name: 'Restaurants', icon: '🍽️', kind: 'expense' },
  { id: 'c-factures', name: 'Factures', icon: '💡', kind: 'expense' },
  { id: 'c-sante', name: 'Santé', icon: '💊', kind: 'expense' },
  { id: 'c-loisirs', name: 'Loisirs', icon: '🎮', kind: 'expense' },
  { id: 'c-shopping', name: 'Shopping', icon: '🛍️', kind: 'expense' },
  { id: 'c-abonnements', name: 'Abonnements', icon: '📱', kind: 'expense' },
  { id: 'c-autre-dep', name: 'Autre', icon: '📦', kind: 'expense' },
  { id: 'c-salaire', name: 'Salaire', icon: '💼', kind: 'income' },
  { id: 'c-freelance', name: 'Freelance / Ventes', icon: '🧾', kind: 'income' },
  { id: 'c-cadeau', name: 'Cadeaux', icon: '🎁', kind: 'income' },
  { id: 'c-invest', name: 'Investissements', icon: '📈', kind: 'income' },
  { id: 'c-autre-rev', name: 'Autre', icon: '💰', kind: 'income' },
];

const DEFAULT_ACCOUNTS = [
  { id: 'a-especes', name: 'Espèces', icon: '💵', initial: 0 },
  { id: 'a-banque', name: 'Compte bancaire', icon: '🏦', initial: 0 },
  { id: 'a-mobile', name: 'Mobile Money', icon: '📱', initial: 0 },
];

const CURRENCIES = [
  ['XOF', 'Franc CFA (BCEAO — Afrique de l’Ouest)'], ['XAF', 'Franc CFA (BEAC — Afrique centrale)'],
  ['EUR', 'Euro (€)'], ['USD', 'Dollar US ($)'], ['CAD', 'Dollar canadien ($)'],
  ['CHF', 'Franc suisse'], ['GBP', 'Livre sterling (£)'], ['MAD', 'Dirham marocain'],
  ['GNF', 'Franc guinéen'], ['CDF', 'Franc congolais'], ['TND', 'Dinar tunisien'],
  ['DZD', 'Dinar algérien'], ['LBP', 'Livre libanaise'], ['HTG', 'Gourde haïtienne'],
];

const uid = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- État ---------- */

function freshState() {
  return {
    version: 1,
    currency: 'XOF',
    theme: 'auto',
    accounts: structuredClone(DEFAULT_ACCOUNTS),
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c, budget: 0 })),
    transactions: [],
    deleted: {},
    prefsU: 0,
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) { /* stockage indisponible : on repart d'un état vide */ }
  return freshState();
}

function normalize(s) {
  const base = freshState();
  if (!s || typeof s !== 'object') return base;
  return {
    version: 1,
    currency: typeof s.currency === 'string' ? s.currency : base.currency,
    theme: ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto',
    accounts: Array.isArray(s.accounts) ? s.accounts : base.accounts,
    categories: Array.isArray(s.categories) ? s.categories : base.categories,
    transactions: Array.isArray(s.transactions) ? s.transactions : [],
    // Pour la synchronisation : éléments supprimés (id → date) et date de modification de la devise
    deleted: s.deleted && typeof s.deleted === 'object' ? s.deleted : {},
    prefsU: Number(s.prefsU) || 0,
  };
}

let state = loadState();

/* Suivi des modifications : chaque élément reçoit sa date de modification (u),
   et chaque suppression laisse une trace, pour fusionner entre appareils. */
const COLLECTIONS = ['accounts', 'categories', 'transactions'];
const recordKey = (r) => { const { u, ...rest } = r; return JSON.stringify(rest); };

function indexState(s) {
  const m = new Map();
  for (const k of COLLECTIONS) for (const r of s[k]) m.set(r.id, recordKey(r));
  return { records: m, currency: s.currency };
}
let snapshot = indexState(state);

function trackChanges() {
  const now = Date.now();
  const seen = new Set();
  for (const k of COLLECTIONS) {
    for (const r of state[k]) {
      seen.add(r.id);
      if (snapshot.records.get(r.id) !== recordKey(r)) r.u = now;
      if (state.deleted[r.id]) delete state.deleted[r.id];
    }
  }
  for (const id of snapshot.records.keys()) if (!seen.has(id)) state.deleted[id] = now;
  if (snapshot.currency !== state.currency) state.prefsU = now;
  snapshot = indexState(state);
}

// Enregistre sur l'appareil sans marquer de modification (après une synchro)
function persistLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { toast('⚠️ Impossible d’enregistrer sur cet appareil'); }
}

function save() {
  trackChanges();
  persistLocal();
  if (typeof onStateSaved === 'function') onStateSaved();
}

/* ---------- Utilitaires ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Nombre de décimales usuel de la devise (0 pour le franc CFA, 2 pour l'euro)
function decimals() {
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: state.currency }).resolvedOptions().maximumFractionDigits; }
  catch (e) { return 2; }
}

function money(cents, opts = {}) {
  const d = decimals();
  const o = {
    style: 'currency', currency: state.currency,
    minimumFractionDigits: opts.compact ? 0 : d,
    maximumFractionDigits: opts.compact ? 0 : d,
    signDisplay: opts.sign ? 'exceptZero' : 'auto',
  };
  // Très grands montants dans les tuiles : notation courte (ex. 1,2 M F CFA)
  if (opts.short) Object.assign(o, { notation: 'compact', maximumFractionDigits: 1 });
  try { return new Intl.NumberFormat('fr-FR', o).format(cents / 100); }
  catch (e) { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100); }
}

// Valeur d'un montant pour un champ de saisie
const inputValue = (cents) => (cents / 100).toFixed(decimals()).replace('.', ',');

const kpiMoney = (cents, sign = false) => {
  const units = Math.abs(cents) / 100;
  return money(cents, { sign, compact: units >= 1000, short: units >= 1000000 });
};

function compact(cents) {
  const v = cents / 100;
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' M';
  if (a >= 1e3) return (v / 1e3).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' k';
  return Math.round(v).toLocaleString('fr-FR');
}

function currencySymbol() {
  try {
    const parts = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: state.currency }).formatToParts(0);
    return (parts.find((x) => x.type === 'currency') || {}).value || state.currency;
  } catch (e) { return state.currency; }
}

function parseAmount(str) {
  let clean = String(str).replace(/\s/g, '');
  // Devise sans centimes (franc CFA) : « 25.000 » ou « 25,000 » = vingt-cinq mille
  clean = decimals() === 0 ? clean.replace(/[.,]/g, '') : clean.replace(',', '.');
  clean = clean.replace(/[^\d.]/g, '');
  const n = parseFloat(clean);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const monthKey = (iso) => iso.slice(0, 7);
const monthOf = (y, m) => `${y}-${String(m + 1).padStart(2, '0')}`;
function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthOf(d.getFullYear(), d.getMonth());
}
function monthName(key, short = false) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', short ? { month: 'short' } : { month: 'long', year: 'numeric' });
}
function fullDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function dayLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const t = todayISO();
  if (iso === t) return 'Aujourd’hui';
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  if (date.toDateString() === yest.toDateString()) return 'Hier';
  return date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

const catById = (id) => state.categories.find((c) => c.id === id);
const accById = (id) => state.accounts.find((a) => a.id === id);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2200);
}

function applyTheme() {
  if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);
}

/* ---------- Calculs ---------- */

function accountBalance(accId) {
  const acc = accById(accId);
  let bal = acc ? acc.initial || 0 : 0;
  for (const t of state.transactions) {
    if (t.type === 'income' && t.accountId === accId) bal += t.amount;
    else if (t.type === 'expense' && t.accountId === accId) bal -= t.amount;
    else if (t.type === 'transfer') {
      if (t.accountId === accId) bal -= t.amount;
      if (t.toAccountId === accId) bal += t.amount;
    }
  }
  return bal;
}

const netWorth = () => state.accounts.reduce((s, a) => s + accountBalance(a.id), 0);

function monthTotals(key) {
  let income = 0, expense = 0;
  const byCat = new Map();
  for (const t of state.transactions) {
    if (monthKey(t.date) !== key) continue;
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') {
      expense += t.amount;
      byCat.set(t.categoryId, (byCat.get(t.categoryId) || 0) + t.amount);
    }
  }
  return { income, expense, net: income - expense, byCat };
}

function sortedTx(list) {
  return [...list].sort((a, b) => (b.date.localeCompare(a.date)) || ((b.created || 0) - (a.created || 0)));
}

/* ---------- Navigation ---------- */

const ui = {
  view: 'home',
  month: monthKey(todayISO()),
  txFilter: 'all',
  txSearch: '',
  statsRange: 6,
};

const TITLES = { home: 'Accueil', tx: 'Opérations', accounts: 'Comptes', stats: 'Statistiques', settings: 'Réglages' };
const VIEWS_WITH_MONTH = new Set(['home', 'tx']);

function render() {
  $('#view-title').textContent = TITLES[ui.view];
  $('#month-picker').style.visibility = VIEWS_WITH_MONTH.has(ui.view) ? 'visible' : 'hidden';
  $('#month-label').textContent = monthName(ui.month);
  $('#fab').style.display = ui.view === 'settings' ? 'none' : '';
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.view === ui.view));
  const app = $('#app');
  app.innerHTML = ({ home: viewHome, tx: viewTx, accounts: viewAccounts, stats: viewStats, settings: viewSettings })[ui.view]();
  if (ui.view === 'stats') bindChart();
}

let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (ui.view === 'stats') render(); }, 150);
});

/* ---------- Vue : Accueil ---------- */

function viewHome() {
  const m = monthTotals(ui.month);
  const nw = netWorth();
  const prev = monthTotals(shiftMonth(ui.month, -1));
  const diff = m.expense - prev.expense;
  const savingsRate = m.income > 0 ? Math.round((m.net / m.income) * 100) : null;

  const cats = [...m.byCat.entries()].sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 0;

  const budgeted = state.categories.filter((c) => c.kind === 'expense' && c.budget > 0);

  const recent = sortedTx(state.transactions.filter((t) => monthKey(t.date) === ui.month)).slice(0, 5);

  return `
    <section class="card">
      <div class="hero-label">Patrimoine total</div>
      <div class="hero ${nw < 0 ? 'neg' : ''}">${money(nw)}</div>
      <div class="sub">${state.accounts.length} compte${state.accounts.length > 1 ? 's' : ''} · ${esc(state.accounts.map((a) => a.name).join(', '))}</div>
    </section>

    <section class="kpis">
      <div class="kpi"><div class="label"><span class="dot" style="background:var(--income)"></span>Revenus</div><div class="value" title="${money(m.income)}">${kpiMoney(m.income)}</div></div>
      <div class="kpi"><div class="label"><span class="dot" style="background:var(--expense)"></span>Dépenses</div><div class="value" title="${money(m.expense)}">${kpiMoney(m.expense)}</div></div>
      <div class="kpi"><div class="label">Solde du mois</div><div class="value ${m.net > 0 ? 'pos' : m.net < 0 ? 'neg' : ''}" title="${money(m.net, { sign: true })}">${kpiMoney(m.net, true)}</div></div>
    </section>

    ${(m.income || m.expense || prev.expense) ? `
    <section class="card">
      <h2>Résumé</h2>
      <div class="sub" style="font-size:14px;color:var(--ink-2)">
        ${savingsRate !== null ? `Taux d’épargne : <b class="${savingsRate >= 0 ? 'pos' : 'neg'}">${savingsRate} %</b><br>` : ''}
        ${prev.expense ? `Dépenses vs ${monthName(shiftMonth(ui.month, -1)).split(' ')[0]} :
          <b class="${diff > 0 ? 'neg' : 'pos'}">${diff > 0 ? '▲' : diff < 0 ? '▼' : '='} ${money(Math.abs(diff))}</b>` : ''}
      </div>
    </section>` : ''}

    <section class="card">
      <h2>Dépenses par catégorie</h2>
      ${cats.length ? cats.map(([id, amt]) => {
        const c = catById(id) || { name: 'Sans catégorie', icon: '❔' };
        const pct = m.expense ? Math.round((amt / m.expense) * 100) : 0;
        return `<div class="hbar">
          <div class="row"><span class="name">${c.icon} ${esc(c.name)}</span><span class="amt">${money(amt)} · ${pct} %</span></div>
          <div class="track"><div class="fill" style="width:${Math.max(2, (amt / maxCat) * 100)}%"></div></div>
        </div>`;
      }).join('') : `<div class="empty"><span class="big">🧾</span>Aucune dépense ce mois-ci.<br>Touchez <b>+</b> pour en ajouter une.</div>`}
    </section>

    ${budgeted.length ? `
    <section class="card">
      <h2>Budgets du mois</h2>
      ${budgeted.map((c) => {
        const spent = m.byCat.get(c.id) || 0;
        const ratio = spent / c.budget;
        const cls = ratio > 1 ? 'over' : ratio > 0.8 ? 'warn' : 'ok';
        const left = c.budget - spent;
        return `<div class="hbar">
          <div class="row"><span class="name">${c.icon} ${esc(c.name)}</span><span class="amt">${money(spent)} / ${money(c.budget)}</span></div>
          <div class="track"><div class="fill ${cls}" style="width:${Math.min(100, Math.max(2, ratio * 100))}%"></div></div>
          <div class="budget-note ${left < 0 ? 'over' : ''}">${left >= 0 ? `Reste ${money(left)}` : `⚠️ Dépassé de ${money(-left)}`}</div>
        </div>`;
      }).join('')}
    </section>` : ''}

    <section class="card">
      <h2>Dernières opérations <span class="right"><a href="#" data-goto="tx" style="color:var(--accent)">Tout voir</a></span></h2>
      ${recent.length ? `<div class="tx-list" style="border:0">${recent.map(txRow).join('')}</div>` : `<div class="empty">Rien pour ce mois.</div>`}
    </section>
  `;
}

function txRow(t) {
  let icon, title, sub, amt, cls;
  const acc = accById(t.accountId);
  if (t.type === 'transfer') {
    const to = accById(t.toAccountId);
    icon = '🔁';
    title = t.note || 'Virement';
    sub = `${acc ? acc.name : '?'} → ${to ? to.name : '?'}`;
    amt = money(t.amount);
    cls = '';
  } else {
    const c = catById(t.categoryId) || { name: 'Sans catégorie', icon: '❔' };
    icon = c.icon;
    title = t.note || c.name;
    sub = `${t.note ? c.name + ' · ' : ''}${acc ? acc.name : ''}`;
    amt = (t.type === 'income' ? '+' : '−') + money(t.amount);
    cls = t.type === 'income' ? 'pos' : '';
  }
  return `<button class="tx" data-edit="${t.id}">
    <span class="ico">${icon}</span>
    <span class="mid"><div class="t1">${esc(title)}</div><div class="t2">${esc(sub)}</div><div class="t3">📅 ${fullDate(t.date)}</div></span>
    <span class="amt ${cls}">${amt}</span>
  </button>`;
}

/* ---------- Vue : Opérations ---------- */

function viewTx() {
  const q = ui.txSearch.trim().toLowerCase();
  let list = state.transactions.filter((t) => monthKey(t.date) === ui.month);
  if (ui.txFilter !== 'all') list = list.filter((t) => t.type === ui.txFilter);
  if (q) {
    list = list.filter((t) => {
      const c = catById(t.categoryId);
      const a = accById(t.accountId);
      return [t.note, c && c.name, a && a.name, String(t.amount / 100)].some((s) => s && String(s).toLowerCase().includes(q));
    });
  }
  list = sortedTx(list);

  const groups = new Map();
  for (const t of list) {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  }

  const seg = [['all', 'Tout'], ['expense', 'Dépenses'], ['income', 'Revenus'], ['transfer', 'Virements']]
    .map(([k, l]) => `<button data-filter="${k}" class="${ui.txFilter === k ? 'on' : ''}">${l}</button>`).join('');

  return `
    <div class="toolbar">
      <input type="search" id="tx-search" placeholder="Rechercher (description, catégorie, montant)…" value="${esc(ui.txSearch)}" aria-label="Rechercher">
    </div>
    <div class="toolbar"><div class="seg">${seg}</div></div>
    ${list.length ? [...groups.entries()].map(([d, ts]) => {
      const dayNet = ts.reduce((s, t) => s + (t.type === 'income' ? t.amount : t.type === 'expense' ? -t.amount : 0), 0);
      return `<div class="tx-day">${dayLabel(d)} <span style="float:right">${dayNet ? money(dayNet, { sign: true }) : ''}</span></div>
      <div class="tx-list">${ts.map(txRow).join('')}</div>`;
    }).join('') : `<div class="card empty"><span class="big">🔍</span>Aucune opération${q ? ' trouvée' : ' ce mois-ci'}.</div>`}
  `;
}

/* ---------- Vue : Comptes ---------- */

function viewAccounts() {
  const nw = netWorth();
  return `
    <section class="card">
      <div class="hero-label">Patrimoine total</div>
      <div class="hero ${nw < 0 ? 'neg' : ''}">${money(nw)}</div>
    </section>
    <div class="tx-list" style="margin-bottom:14px">
      ${state.accounts.map((a) => {
        const b = accountBalance(a.id);
        return `<button class="acc" data-acc="${a.id}">
          <span class="ico" style="width:38px;height:38px;border-radius:12px;background:var(--surface-2);display:grid;place-items:center;font-size:19px">${a.icon || '👛'}</span>
          <span class="mid"><div style="font-weight:600">${esc(a.name)}</div><div class="sub">Solde initial ${money(a.initial || 0)}</div></span>
          <span style="font-weight:700" class="${b < 0 ? 'neg' : ''}">${money(b)}</span>
        </button>`;
      }).join('')}
    </div>
    <div class="btn-row">
      <button class="btn" id="add-account">➕ Nouveau compte</button>
      <button class="btn" id="add-transfer" ${state.accounts.length < 2 ? 'disabled' : ''}>🔁 Virement</button>
    </div>
  `;
}

/* ---------- Vue : Statistiques ---------- */

function statsMonths() {
  const end = monthKey(todayISO());
  const months = [];
  for (let i = ui.statsRange - 1; i >= 0; i--) months.push(shiftMonth(end, -i));
  return months.map((k) => ({ key: k, ...monthTotals(k) }));
}

function viewStats() {
  const data = statsMonths();
  const totIn = data.reduce((s, d) => s + d.income, 0);
  const totOut = data.reduce((s, d) => s + d.expense, 0);
  const n = data.length;

  // Top catégories sur la période
  const byCat = new Map();
  data.forEach((d) => d.byCat.forEach((v, k) => byCat.set(k, (byCat.get(k) || 0) + v)));
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxTop = top.length ? top[0][1] : 0;

  const seg = [[3, '3 mois'], [6, '6 mois'], [12, '12 mois']]
    .map(([k, l]) => `<button data-range="${k}" class="${ui.statsRange === k ? 'on' : ''}">${l}</button>`).join('');

  return `
    <div class="toolbar"><div class="seg">${seg}</div></div>
    <section class="kpis">
      <div class="kpi"><div class="label">Revenu moyen</div><div class="value">${kpiMoney(Math.round(totIn / n))}</div></div>
      <div class="kpi"><div class="label">Dépense moy.</div><div class="value">${kpiMoney(Math.round(totOut / n))}</div></div>
      <div class="kpi"><div class="label">Épargné</div><div class="value ${totIn - totOut >= 0 ? 'pos' : 'neg'}">${kpiMoney(totIn - totOut, true)}</div></div>
    </section>

    <section class="card">
      <h2>Revenus et dépenses par mois</h2>
      <div class="legend">
        <span><span class="dot" style="background:var(--income)"></span>Revenus</span>
        <span><span class="dot" style="background:var(--expense)"></span>Dépenses</span>
      </div>
      <div class="chart" id="chart">${barChart(data)}</div>
      <details>
        <summary>Voir le tableau</summary>
        <table class="data">
          <thead><tr><th>Mois</th><th>Revenus</th><th>Dépenses</th><th>Solde</th></tr></thead>
          <tbody>${data.map((d) => `<tr><td>${monthName(d.key)}</td><td>${money(d.income)}</td><td>${money(d.expense)}</td>
            <td class="${d.net > 0 ? 'pos' : d.net < 0 ? 'neg' : ''}">${money(d.net, { sign: true })}</td></tr>`).join('')}</tbody>
        </table>
      </details>
    </section>

    <section class="card">
      <h2>Top dépenses (${ui.statsRange} mois)</h2>
      ${top.length ? top.map(([id, amt]) => {
        const c = catById(id) || { name: 'Sans catégorie', icon: '❔' };
        return `<div class="hbar">
          <div class="row"><span class="name">${c.icon} ${esc(c.name)}</span><span class="amt">${money(amt)} · ${money(Math.round(amt / n), { compact: true })}/mois</span></div>
          <div class="track"><div class="fill" style="width:${Math.max(2, (amt / maxTop) * 100)}%"></div></div>
        </div>`;
      }).join('') : `<div class="empty">Pas encore de données.</div>`}
    </section>
  `;
}

function niceStep(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const r = v / p;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p;
}

function barChart(data) {
  const W = Math.max(260, Math.min(720, window.innerWidth) - 66), H = 220, padL = 40, padR = 4, padT = 8, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const step = niceStep(Math.max(10000, ...data.map((d) => Math.max(d.income, d.expense))) / 4);
  const max = step * Math.ceil(Math.max(1, ...data.map((d) => Math.max(d.income, d.expense))) / step);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const groupW = plotW / data.length;
  const gap = 2;
  const barW = Math.min(28, (groupW * 0.7 - gap) / 2);
  const ticks = [];
  for (let v = 0; v <= max + 1; v += step) ticks.push(v);

  // Barre à extrémité arrondie (4px) ancrée sur la ligne de base
  const bar = (x, v, cls) => {
    if (v <= 0) return '';
    const top = y(v), h = padT + plotH - top, r = Math.min(4, h, barW / 2);
    return `<path class="${cls}" d="M${x},${padT + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${padT + plotH} Z"/>`;
  };

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenus et dépenses par mois">`;
  ticks.forEach((t) => {
    s += `<line class="gridline" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`;
    s += `<text class="tick" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
  });
  data.forEach((d, i) => {
    const cx = padL + groupW * i + groupW / 2;
    s += bar(cx - barW - gap / 2, d.income, 'bar-in');
    s += bar(cx + gap / 2, d.expense, 'bar-out');
    s += `<text class="tick" x="${cx}" y="${H - 8}" text-anchor="middle">${monthName(d.key, true).replace('.', '')}</text>`;
    s += `<rect class="hit" data-i="${i}" x="${padL + groupW * i}" y="${padT}" width="${groupW}" height="${plotH}" rx="6"/>`;
  });
  s += `<line class="baseline" x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}"/>`;
  return s + '</svg>';
}

function bindChart() {
  const chart = $('#chart');
  if (!chart) return;
  const data = statsMonths();
  const tip = $('#tooltip');
  const show = (el, ev) => {
    chart.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on'));
    el.classList.add('on');
    const d = data[+el.dataset.i];
    tip.innerHTML = `<div class="tt-title">${monthName(d.key)}</div>
      <div class="tt-row"><span><span class="dot" style="background:var(--income)"></span> Revenus</span><b>${money(d.income)}</b></div>
      <div class="tt-row"><span><span class="dot" style="background:var(--expense)"></span> Dépenses</span><b>${money(d.expense)}</b></div>
      <div class="tt-row"><span>Solde</span><b class="${d.net >= 0 ? 'pos' : 'neg'}">${money(d.net, { sign: true })}</b></div>`;
    tip.style.display = 'block';
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, r.top - tip.offsetHeight - 8) + 'px';
  };
  const hide = () => {
    tip.style.display = 'none';
    chart.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on'));
  };
  chart.querySelectorAll('.hit').forEach((h) => {
    h.addEventListener('mouseenter', (e) => show(h, e));
    h.addEventListener('mouseleave', hide);
    h.addEventListener('click', (e) => { e.stopPropagation(); show(h, e); });
  });
  document.addEventListener('click', hide, { once: true });
  window.addEventListener('scroll', hide, { once: true });
}

/* ---------- Vue : Réglages ---------- */

function viewSettings() {
  const themeSeg = [['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']]
    .map(([k, l]) => `<button data-theme-set="${k}" class="${state.theme === k ? 'on' : ''}">${l}</button>`).join('');
  return `
    ${typeof accountSettingsHTML === 'function' ? accountSettingsHTML() : ''}
    <section class="card">
      <h2>Général</h2>
      <div class="settings-row"><span>Devise</span>
        <select id="currency">${CURRENCIES.map(([c, l]) => `<option value="${c}" ${state.currency === c ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div class="settings-row"><span>Thème</span><div class="seg">${themeSeg}</div></div>
    </section>

    <section class="card">
      <h2>Catégories & budgets mensuels</h2>
      <div class="sub" style="margin-bottom:8px">Touchez une catégorie pour la modifier ou lui fixer un budget.</div>
      <div class="tx-list">
        ${state.categories.map((c) => `<button class="tx" data-cat="${c.id}">
          <span class="ico">${c.icon}</span>
          <span class="mid"><div class="t1">${esc(c.name)}</div><div class="t2">${c.kind === 'income' ? 'Revenu' : 'Dépense'}</div></span>
          <span class="amt" style="font-weight:500;color:var(--ink-2)">${c.budget ? money(c.budget) + '/mois' : ''}</span>
        </button>`).join('')}
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn" id="add-cat">➕ Nouvelle catégorie</button></div>
    </section>

    <section class="card">
      <h2>Sauvegarde</h2>
      <div class="sub" style="margin-bottom:10px">Vos données sont sauvegardées dans votre compte. Vous pouvez aussi en garder une copie sur ce téléphone.</div>
      <div class="btn-row" style="margin-bottom:8px">
        <button class="btn" id="export-json">⬇️ Sauvegarder (JSON)</button>
        <button class="btn" id="import-json">⬆️ Restaurer</button>
      </div>
      <div class="btn-row" style="margin-bottom:8px"><button class="btn" id="export-csv">📄 Exporter en CSV (Excel)</button></div>
      <div class="btn-row"><button class="btn danger" id="reset">🗑️ Tout effacer</button></div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </section>
    <p class="sub" style="text-align:center">Caisse · ${state.transactions.length} opération${state.transactions.length > 1 ? 's' : ''} enregistrée${state.transactions.length > 1 ? 's' : ''}</p>
  `;
}

/* ---------- Feuilles (formulaires) ---------- */

const sheet = $('#sheet');
const sheetForm = $('#sheet-form');

function openSheet(html, onSubmit, onMount) {
  sheetForm.innerHTML = html;
  sheetForm.onsubmit = (e) => {
    e.preventDefault();
    const action = e.submitter && e.submitter.value;
    if (action === 'cancel') return sheet.close();
    if (onSubmit(action) !== false) sheet.close();
  };
  sheet.showModal();
  if (onMount) onMount();
}
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

const sheetHead = (title) => `<div class="sheet-head"><h3>${title}</h3><button class="icon-btn" value="cancel" formnovalidate aria-label="Fermer">×</button></div>`;

function openTxSheet(existing, preset = {}) {
  const t = existing ? { ...existing } : {
    type: preset.type || 'expense', amount: 0, date: defaultDate(), note: '',
    accountId: state.accounts[0] && state.accounts[0].id,
    toAccountId: state.accounts[1] && state.accounts[1].id,
    categoryId: null,
  };
  let type = t.type;
  let categoryId = t.categoryId;

  // Descriptions récentes de ce type, proposées en raccourci
  const pastNotes = () => [...new Set(sortedTx(state.transactions).filter((x) => x.type === type && x.note).map((x) => x.note))].slice(0, 6);

  const accOptions = (sel) => state.accounts.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${a.icon || ''} ${esc(a.name)}</option>`).join('');

  const body = () => {
    const cats = state.categories.filter((c) => c.kind === (type === 'income' ? 'income' : 'expense'));
    if (type !== 'transfer' && !cats.some((c) => c.id === categoryId)) categoryId = cats[0] && cats[0].id;
    return `
      ${sheetHead(existing ? 'Modifier l’opération' : 'Nouvelle opération')}
      <div class="type-switch">
        ${[['expense', 'Dépense'], ['income', 'Revenu'], ['transfer', 'Virement']].map(([k, l]) =>
          `<button type="button" data-type="${k}" class="${type === k ? 'on' : ''}" ${k === 'transfer' && state.accounts.length < 2 ? 'disabled' : ''}>${l}</button>`).join('')}
      </div>
      <label class="f">Montant (${currencySymbol()})
        <input class="amount-input" name="amount" inputmode="decimal" autocomplete="off" required placeholder="${inputValue(0)}"
          value="${t.amount ? inputValue(t.amount) : ''}">
      </label>
      <label class="f">Description
        <textarea name="note" rows="2" maxlength="200" placeholder="${type === 'income' ? 'Ex. Salaire d’octobre, vente du téléphone…' : type === 'transfer' ? 'Ex. Retrait au guichet, dépôt Orange Money…' : 'Ex. Marché du samedi, carburant, facture CIE…'}">${esc(t.note)}</textarea>
      </label>
      ${pastNotes().length ? `<div class="chips" style="margin-top:-6px">${pastNotes().map((n) => `<button type="button" class="chip" data-note="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      ${type === 'transfer' ? `
        <div class="two">
          <label class="f">De<select name="accountId">${accOptions(t.accountId)}</select></label>
          <label class="f">Vers<select name="toAccountId">${accOptions(t.toAccountId)}</select></label>
        </div>` : `
        <div class="f" style="font-size:13px;color:var(--ink-2)">Catégorie</div>
        <div class="chips">${cats.map((c) => `<button type="button" class="chip ${c.id === categoryId ? 'on' : ''}" data-chip="${c.id}">${c.icon} ${esc(c.name)}</button>`).join('')}</div>
        <label class="f">Compte<select name="accountId">${accOptions(t.accountId)}</select></label>`}
      <label class="f">Date<input type="date" name="date" required value="${t.date}"></label>
      <div class="btn-row">
        ${existing ? `<button class="btn danger" value="delete" formnovalidate>Supprimer</button>` : ''}
        <button class="btn primary" value="save">Enregistrer</button>
      </div>`;
  };

  const snapshot = () => {
    const f = sheetForm.elements;
    t.amount = parseAmount(f.amount.value) || 0;
    t.date = f.date.value;
    t.note = f.note.value;
    if (f.accountId) t.accountId = f.accountId.value;
    if (f.toAccountId) t.toAccountId = f.toAccountId.value;
  };

  const mount = () => {
    sheetForm.querySelectorAll('[data-type]').forEach((b) => b.onclick = () => {
      snapshot(); type = b.dataset.type; sheetForm.innerHTML = body(); mount();
    });
    sheetForm.querySelectorAll('[data-note]').forEach((b) => b.onclick = () => {
      sheetForm.elements.note.value = b.dataset.note;
    });
    sheetForm.querySelectorAll('[data-chip]').forEach((b) => b.onclick = () => {
      categoryId = b.dataset.chip;
      sheetForm.querySelectorAll('[data-chip]').forEach((x) => x.classList.toggle('on', x === b));
    });
    if (!existing) sheetForm.elements.amount.focus();
  };

  openSheet(body(), (action) => {
    if (action === 'delete') {
      if (!confirm('Supprimer cette opération ?')) return false;
      state.transactions = state.transactions.filter((x) => x.id !== existing.id);
      save(); render(); toast('Opération supprimée');
      return;
    }
    const f = sheetForm.elements;
    const amount = parseAmount(f.amount.value);
    if (!amount) { toast('Entrez un montant valide'); f.amount.focus(); return false; }
    if (!f.date.value) { toast('Choisissez une date'); return false; }
    const rec = {
      id: existing ? existing.id : uid('t'),
      created: existing ? existing.created : Date.now(),
      type, amount, date: f.date.value, note: f.note.value.trim(),
      accountId: f.accountId.value,
    };
    if (type === 'transfer') {
      rec.toAccountId = f.toAccountId.value;
      if (rec.toAccountId === rec.accountId) { toast('Choisissez deux comptes différents'); return false; }
    } else {
      rec.categoryId = categoryId;
    }
    if (existing) state.transactions = state.transactions.map((x) => (x.id === existing.id ? rec : x));
    else state.transactions.push(rec);
    save();
    ui.month = monthKey(rec.date);
    render();
    toast(existing ? 'Opération modifiée' : 'Opération ajoutée ✓');
  }, mount);
}

function defaultDate() {
  // Si on consulte un autre mois que le mois courant, on propose le 1er de ce mois
  const t = todayISO();
  return monthKey(t) === ui.month ? t : ui.month + '-01';
}

function openAccountSheet(acc) {
  const a = acc || { name: '', icon: '👛', initial: 0 };
  const icons = ['💵', '🏦', '💳', '🐷', '📈', '👛', '📱', '🪙'];
  let icon = a.icon || '👛';
  const used = acc && state.transactions.some((t) => t.accountId === acc.id || t.toAccountId === acc.id);
  openSheet(`
    ${sheetHead(acc ? 'Modifier le compte' : 'Nouveau compte')}
    <label class="f">Nom<input name="name" required maxlength="40" value="${esc(a.name)}" placeholder="Ex. Livret A, Mobile Money…"></label>
    <div class="f" style="font-size:13px;color:var(--ink-2)">Icône</div>
    <div class="chips">${icons.map((i) => `<button type="button" class="chip ${i === icon ? 'on' : ''}" data-icon="${i}">${i}</button>`).join('')}</div>
    <label class="f">Solde initial (${currencySymbol()})
      <input name="initial" inputmode="decimal" value="${inputValue(a.initial || 0)}">
    </label>
    <div class="sub" style="margin:-6px 0 14px">Le montant présent sur ce compte avant votre première opération. Peut être négatif (ex. -150).</div>
    <div class="btn-row">
      ${acc ? `<button class="btn danger" value="delete" formnovalidate>Supprimer</button>` : ''}
      <button class="btn primary" value="save">Enregistrer</button>
    </div>
  `, (action) => {
    if (action === 'delete') {
      if (state.accounts.length <= 1) { toast('Il faut garder au moins un compte'); return false; }
      if (used && !confirm('Ce compte a des opérations. Les supprimer aussi ?')) return false;
      if (!used && !confirm('Supprimer ce compte ?')) return false;
      state.transactions = state.transactions.filter((t) => t.accountId !== acc.id && t.toAccountId !== acc.id);
      state.accounts = state.accounts.filter((x) => x.id !== acc.id);
      save(); render(); toast('Compte supprimé');
      return;
    }
    const f = sheetForm.elements;
    const raw = f.initial.value.trim();
    const neg = raw.startsWith('-');
    const initial = (parseAmount(raw) || 0) * (neg ? -1 : 1);
    const rec = { id: acc ? acc.id : uid('a'), name: f.name.value.trim(), icon, initial };
    if (!rec.name) { toast('Donnez un nom au compte'); return false; }
    if (acc) state.accounts = state.accounts.map((x) => (x.id === acc.id ? rec : x));
    else state.accounts.push(rec);
    save(); render(); toast(acc ? 'Compte modifié' : 'Compte créé ✓');
  }, () => {
    sheetForm.querySelectorAll('[data-icon]').forEach((b) => b.onclick = () => {
      icon = b.dataset.icon;
      sheetForm.querySelectorAll('[data-icon]').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
}

function openCategorySheet(cat) {
  const c = cat || { name: '', icon: '📦', kind: 'expense', budget: 0 };
  let kind = c.kind;
  const used = cat && state.transactions.some((t) => t.categoryId === cat.id);
  openSheet(`
    ${sheetHead(cat ? 'Modifier la catégorie' : 'Nouvelle catégorie')}
    <div class="type-switch" style="grid-template-columns:1fr 1fr">
      <button type="button" data-kind="expense" class="${kind === 'expense' ? 'on' : ''}" ${used ? 'disabled' : ''}>Dépense</button>
      <button type="button" data-kind="income" class="${kind === 'income' ? 'on' : ''}" ${used ? 'disabled' : ''}>Revenu</button>
    </div>
    <div class="two" style="grid-template-columns:80px 1fr">
      <label class="f">Emoji<input name="icon" maxlength="4" value="${esc(c.icon)}" style="text-align:center"></label>
      <label class="f">Nom<input name="name" required maxlength="30" value="${esc(c.name)}"></label>
    </div>
    <label class="f" id="budget-field" ${kind === 'income' ? 'hidden' : ''}>Budget mensuel (${currencySymbol()}, 0 = aucun)
      <input name="budget" inputmode="decimal" value="${c.budget ? inputValue(c.budget) : ''}" placeholder="0">
    </label>
    <div class="btn-row">
      ${cat ? `<button class="btn danger" value="delete" formnovalidate>Supprimer</button>` : ''}
      <button class="btn primary" value="save">Enregistrer</button>
    </div>
  `, (action) => {
    if (action === 'delete') {
      if (used) { toast('Catégorie utilisée par des opérations'); return false; }
      if (!confirm('Supprimer cette catégorie ?')) return false;
      state.categories = state.categories.filter((x) => x.id !== cat.id);
      save(); render(); return;
    }
    const f = sheetForm.elements;
    const rec = {
      id: cat ? cat.id : uid('c'), kind,
      name: f.name.value.trim(), icon: f.icon.value.trim() || '📦',
      budget: kind === 'expense' ? (parseAmount(f.budget.value) || 0) : 0,
    };
    if (!rec.name) return false;
    if (cat) state.categories = state.categories.map((x) => (x.id === cat.id ? rec : x));
    else state.categories.push(rec);
    save(); render(); toast('Catégorie enregistrée ✓');
  }, () => {
    sheetForm.querySelectorAll('[data-kind]').forEach((b) => b.onclick = () => {
      kind = b.dataset.kind;
      sheetForm.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b));
      $('#budget-field').hidden = kind === 'income';
    });
  });
}

/* ---------- Import / export ---------- */

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function exportCSV() {
  const rows = [['Date', 'Type', 'Catégorie', 'Compte', 'Vers compte', 'Montant', 'Description']];
  const label = { income: 'Revenu', expense: 'Dépense', transfer: 'Virement' };
  for (const t of sortedTx(state.transactions).reverse()) {
    const c = catById(t.categoryId), a = accById(t.accountId), to = accById(t.toAccountId);
    const signed = t.type === 'expense' ? -t.amount : t.amount;
    rows.push([t.date, label[t.type], c ? c.name : '', a ? a.name : '', to ? to.name : '', inputValue(signed), t.note || '']);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  download(`caisse-${todayISO()}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
}

/* ---------- Événements ---------- */

document.addEventListener('click', (e) => {
  const tab = e.target.closest('.tabbar [data-view]');
  if (tab) { ui.view = tab.dataset.view; window.scrollTo(0, 0); return render(); }

  const go = e.target.closest('[data-goto]');
  if (go) { e.preventDefault(); ui.view = go.dataset.goto; return render(); }

  const edit = e.target.closest('[data-edit]');
  if (edit) return openTxSheet(state.transactions.find((t) => t.id === edit.dataset.edit));

  const acc = e.target.closest('[data-acc]');
  if (acc) return openAccountSheet(accById(acc.dataset.acc));

  const cat = e.target.closest('[data-cat]');
  if (cat) return openCategorySheet(catById(cat.dataset.cat));

  const filter = e.target.closest('[data-filter]');
  if (filter) { ui.txFilter = filter.dataset.filter; return render(); }

  const range = e.target.closest('[data-range]');
  if (range) { ui.statsRange = +range.dataset.range; return render(); }

  const th = e.target.closest('[data-theme-set]');
  if (th) { state.theme = th.dataset.themeSet; save(); applyTheme(); return render(); }

  switch (e.target.closest('button')?.id) {
    case 'fab': return openTxSheet(null);
    case 'prev-month': ui.month = shiftMonth(ui.month, -1); return render();
    case 'next-month': ui.month = shiftMonth(ui.month, 1); return render();
    case 'add-account': return openAccountSheet(null);
    case 'add-transfer': return openTxSheet(null, { type: 'transfer' });
    case 'add-cat': return openCategorySheet(null);
    case 'export-json': download(`caisse-sauvegarde-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json'); return toast('Sauvegarde téléchargée');
    case 'export-csv': exportCSV(); return toast('CSV téléchargé');
    case 'import-json': return $('#import-file').click();
    case 'reset':
      if (confirm(`Effacer toutes vos données${typeof auth !== 'undefined' && auth ? ', sur tous vos appareils connectés' : ''} ? Cette action est irréversible.`) && confirm('Vraiment tout effacer ?')) {
        const { theme, deleted } = state;
        state = { ...freshState(), theme, deleted }; save(); render(); toast('Données effacées');
      }
      return;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'tx-search') {
    ui.txSearch = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const el = $('#tx-search');
    el.focus(); el.setSelectionRange(pos, pos);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'currency') { state.currency = e.target.value; save(); render(); toast('Devise mise à jour'); }
  if (e.target.id === 'import-file') {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((txt) => {
      const data = JSON.parse(txt);
      if (!data || !Array.isArray(data.transactions) || !Array.isArray(data.accounts)) throw new Error('format');
      if (!confirm(`Remplacer vos données actuelles par cette sauvegarde (${data.transactions.length} opérations) ?`)) return;
      const { deleted } = state;
      state = normalize(data); state.deleted = { ...deleted, ...state.deleted }; save(); applyTheme(); render(); toast('Sauvegarde restaurée ✓');
    }).catch(() => toast('Fichier invalide'));
    e.target.value = '';
  }
});

// Raccourcis clavier (ordinateur)
document.addEventListener('keydown', (e) => {
  if (sheet.open || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.key === 'n' || e.key === '+') { e.preventDefault(); openTxSheet(null); }
  if (e.key === 'ArrowLeft' && VIEWS_WITH_MONTH.has(ui.view)) { ui.month = shiftMonth(ui.month, -1); render(); }
  if (e.key === 'ArrowRight' && VIEWS_WITH_MONTH.has(ui.view)) { ui.month = shiftMonth(ui.month, 1); render(); }
});

/* ---------- Démarrage ---------- */

applyTheme();
render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
