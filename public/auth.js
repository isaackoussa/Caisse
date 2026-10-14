'use strict';

/* ============================================================
   Compte en ligne, synchronisation entre appareils et code PIN.
   S'appuie sur app.js (state, save, render, openSheet, toast…).
   ============================================================ */

const AUTH_KEY = 'caisse.auth';
const PIN_KEY = 'caisse.pin';
const SKIP_KEY = 'caisse.sansCompte';
const LOCK_AFTER_MS = 60 * 1000;      // verrouillage après 1 min en arrière-plan
const SYNC_EVERY_MS = 2 * 60 * 1000;  // synchro périodique quand l'app est ouverte

function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
function writeJSON(key, v) {
  try { if (v == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* ignoré */ }
}

let auth = readJSON(AUTH_KEY); // { username, token, rev, lastSync, dirty }
const saveAuth = () => writeJSON(AUTH_KEY, auth);

/* ---------- Appels au serveur ---------- */

async function apiCall(path, { method = 'GET', body, token = auth && auth.token } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw Object.assign(new Error('Pas de connexion internet.'), { offline: true });
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* réponse vide */ }
  if (!res.ok && res.status !== 409) {
    const msg = res.status === 404 && !data.error ? 'Serveur indisponible (l’app est-elle déployée sur Netlify ?)' : data.error || `Erreur ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return { status: res.status, ...data };
}

/* ---------- Fusion de deux versions des données ---------- */

// Ce qui est envoyé au serveur (le thème reste propre à chaque appareil)
const payload = (s) => ({
  version: 1, currency: s.currency, prefsU: s.prefsU || 0, deleted: s.deleted || {},
  accounts: s.accounts, categories: s.categories, transactions: s.transactions,
});

function mergeStates(local, remote) {
  const deleted = { ...(remote.deleted || {}) };
  for (const [id, t] of Object.entries(local.deleted || {})) deleted[id] = Math.max(t, deleted[id] || 0);
  const out = { ...local, deleted };
  for (const k of COLLECTIONS) {
    const byId = new Map();
    const order = [];
    for (const r of [...(local[k] || []), ...(remote[k] || [])]) {
      const cur = byId.get(r.id);
      if (!cur) { byId.set(r.id, r); order.push(r.id); }
      else if ((r.u || 0) > (cur.u || 0)) byId.set(r.id, r); // la version la plus récente gagne
    }
    out[k] = order.map((id) => byId.get(id)).filter((r) => !(deleted[r.id] >= (r.u || 0)));
  }
  if ((remote.prefsU || 0) > (local.prefsU || 0)) { out.currency = remote.currency; out.prefsU = remote.prefsU; }
  return out;
}

/* ---------- Synchronisation ---------- */

let syncing = false, syncAgain = false, syncTimer = null, syncStatus = 'idle';

function setSyncStatus(st) {
  syncStatus = st;
  const el = $('#sync-dot');
  if (!el) return;
  el.hidden = !auth;
  const look = {
    ok: ['☁︎', 'Synchronisé'], idle: ['☁︎', 'Synchronisé'], pending: ['•', 'Modifications en attente'],
    syncing: ['⟳', 'Synchronisation…'], offline: ['⚠︎', 'Hors connexion — sera synchronisé plus tard'],
    error: ['⚠︎', 'Échec de la synchronisation — touchez pour réessayer'],
  }[st];
  el.textContent = look[0];
  el.title = el.ariaLabel = look[1];
  el.dataset.state = st;
  const line = $('#sync-line');
  if (line) line.textContent = syncLineText();
}

function syncLineText() {
  if (!auth) return '';
  if (syncStatus === 'syncing') return 'Synchronisation…';
  if (syncStatus === 'offline') return 'Hors connexion : vos modifications seront envoyées au retour du réseau.';
  if (syncStatus === 'error') return 'La dernière synchronisation a échoué.';
  if (auth.dirty) return 'Modifications en attente d’envoi.';
  if (!auth.lastSync) return 'Jamais synchronisé.';
  const min = Math.round((Date.now() - auth.lastSync) / 60000);
  return `Synchronisé ${min < 1 ? 'à l’instant' : `il y a ${min} min`}.`;
}

// Appelée par save() dans app.js à chaque modification
function onStateSaved() {
  if (!auth) return;
  auth.dirty = true;
  saveAuth();
  setSyncStatus('pending');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), 800);
}

async function sync({ quiet = true } = {}) {
  if (!auth || !auth.token) return false;
  if (syncing) { syncAgain = true; return false; }
  syncing = true;
  setSyncStatus('syncing');
  let ok = false;
  try {
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      const remote = await apiCall('/api/data');
      if (remote.data) {
        const merged = normalize(mergeStates(state, normalize(remote.data)));
        if (JSON.stringify(payload(merged)) !== JSON.stringify(payload(state))) {
          state = merged;
          snapshot = indexState(state);
          persistLocal();
          render();
        }
        if (JSON.stringify(payload(state)) === JSON.stringify(payload(normalize(remote.data)))) {
          auth.rev = remote.rev;
          ok = true;
          break;
        }
      }
      const put = await apiCall('/api/data', { method: 'PUT', body: { baseRev: remote.rev, data: payload(state) } });
      if (put.status === 409) continue; // un autre appareil vient d'écrire : on refusionne
      auth.rev = put.rev;
      ok = true;
    }
    if (!ok) throw new Error('Trop de modifications simultanées, réessayez.');
    if (!syncAgain) auth.dirty = false;
    auth.lastSync = Date.now();
    saveAuth();
    setSyncStatus('ok');
  } catch (e) {
    if (e.status === 401) sessionExpired();
    else setSyncStatus(e.offline ? 'offline' : 'error');
    if (!quiet && e.status !== 401) toast('⚠️ ' + e.message);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; setTimeout(() => sync(), 0); }
  }
  return ok;
}

function sessionExpired() {
  if (!auth) return;
  auth.token = null;
  saveAuth();
  setSyncStatus('error');
  if (!gate.hidden) return; // écran PIN affiché : on demandera la connexion après déverrouillage
  showGate('login', { forced: true, username: auth.username, message: 'Votre session a expiré. Reconnectez-vous pour continuer la synchronisation.' });
}

/* ---------- Connexion / inscription ---------- */

async function afterLogin(res) {
  const prev = auth && auth.username;
  if (prev && prev !== res.username) {
    // Autre compte sur cet appareil : on ne mélange pas les données
    state = { ...freshState(), theme: state.theme };
    snapshot = indexState(state);
    persistLocal();
  }
  auth = { username: res.username, token: res.token, rev: 0, lastSync: null, dirty: true };
  saveAuth();
  writeJSON(SKIP_KEY, null);
  hideGate();
  render();
  const ok = await sync({ quiet: false });
  if (ok) toast(`Connecté en tant que ${res.username} ✓`);
}

async function logout() {
  if (!confirm('Se déconnecter ? Vos données seront retirées de cet appareil (elles restent dans votre compte).')) return;
  const ok = await sync();
  if (!ok && auth.dirty && !confirm('Certaines modifications n’ont pas pu être envoyées (pas de connexion ?). Se déconnecter quand même et les perdre ?')) return;
  auth = null;
  saveAuth();
  writeJSON(PIN_KEY, null);
  state = { ...freshState(), theme: state.theme };
  snapshot = indexState(state);
  persistLocal();
  setSyncStatus('idle');
  render();
  showGate('welcome');
}

/* ---------- Code PIN ---------- */

const pinSupported = () => !!(window.crypto && crypto.subtle);

async function hashPin(pin, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function setPin(pin) {
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  writeJSON(PIN_KEY, { salt, hash: await hashPin(pin, salt) });
}

async function checkPin(pin) {
  const p = readJSON(PIN_KEY);
  return !!p && (await hashPin(pin, p.salt)) === p.hash;
}

function openPinSheet() {
  const has = !!readJSON(PIN_KEY);
  openSheet(`
    ${sheetHead(has ? 'Modifier le code PIN' : 'Activer le code PIN')}
    <p class="sub" style="margin-top:0">Le code est demandé à l’ouverture de l’app et après 1 minute en arrière-plan. Il protège l’accès sur ce téléphone uniquement.</p>
    <label class="f">Nouveau code (4 chiffres)
      <input name="pin1" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" required class="pin-input">
    </label>
    <label class="f">Confirmer le code
      <input name="pin2" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="off" required class="pin-input">
    </label>
    <div class="btn-row"><button class="btn primary" value="save">Enregistrer</button></div>
  `, () => {
    const f = sheetForm.elements;
    if (!/^\d{4}$/.test(f.pin1.value)) { toast('Le code doit contenir 4 chiffres'); return false; }
    if (f.pin1.value !== f.pin2.value) { toast('Les deux codes ne correspondent pas'); return false; }
    setPin(f.pin1.value).then(() => { render(); toast('Code PIN activé 🔒'); });
  }, () => setTimeout(() => sheetForm.elements.pin1.focus(), 50));
}

function openPasswordSheet() {
  openSheet(`
    ${sheetHead('Changer le mot de passe')}
    <input type="text" name="username" autocomplete="username" value="${esc(auth.username)}" hidden>
    <label class="f">Mot de passe actuel<input name="current" type="password" autocomplete="current-password" required></label>
    <label class="f">Nouveau mot de passe (6 caractères minimum)<input name="next" type="password" autocomplete="new-password" minlength="6" required></label>
    <p class="sub" style="margin-top:-4px">Vos autres appareils devront se reconnecter.</p>
    <div class="btn-row"><button class="btn primary" value="save">Enregistrer</button></div>
  `, () => {
    const f = sheetForm.elements;
    apiCall('/api/password', { method: 'POST', body: { current: f.current.value, password: f.next.value } })
      .then((res) => { auth.token = res.token; saveAuth(); sheet.close(); toast('Mot de passe modifié ✓'); })
      .catch((e) => toast('⚠️ ' + e.message));
    return false; // la feuille se ferme une fois le serveur d'accord
  });
}

/* ---------- Écran d'accueil / verrouillage ---------- */

const gate = $('#gate');
let gateOpts = {};
let pinEntry = '';
let pinFails = 0, pinWaitUntil = 0;

function showGate(mode, opts = {}) {
  gateOpts = { mode, ...opts };
  pinEntry = '';
  gate.hidden = false;
  document.body.classList.add('gated');
  if (sheet.open) sheet.close();
  renderGate();
}

function hideGate() {
  gate.hidden = true;
  document.body.classList.remove('gated');
  gateOpts = {};
}

function renderGate() {
  const { mode } = gateOpts;
  const logo = `<img src="icons/icon-192.png" alt="" class="gate-logo"><div class="gate-name">Caisse</div>`;
  if (mode === 'pin') {
    const waiting = pinWaitUntil > Date.now();
    gate.innerHTML = `
      <div class="gate-box">
        ${logo}
        <p class="gate-msg">${waiting ? `Trop d’essais. Patientez ${Math.ceil((pinWaitUntil - Date.now()) / 1000)} s.` : gateOpts.message || 'Entrez votre code'}</p>
        <div class="pin-dots">${[0, 1, 2, 3].map((i) => `<span class="${i < pinEntry.length ? 'on' : ''}"></span>`).join('')}</div>
        <div class="keypad">
          ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) =>
            k ? `<button type="button" data-key="${k}" ${waiting ? 'disabled' : ''} aria-label="${k === '⌫' ? 'Effacer' : k}">${k}</button>` : '<span></span>').join('')}
        </div>
        <button type="button" class="link-btn" data-gate="forgot">Code oublié ?</button>
      </div>`;
    if (waiting) setTimeout(() => gateOpts.mode === 'pin' && renderGate(), 1000);
    return;
  }
  const isLogin = mode !== 'register';
  gate.innerHTML = `
    <form class="gate-box" id="gate-form" novalidate>
      ${logo}
      <p class="gate-msg">${esc(gateOpts.message || 'Votre portefeuille, vos dépenses et vos revenus, sur tous vos appareils.')}</p>
      ${gateOpts.forced ? '' : `<div class="type-switch" style="grid-template-columns:1fr 1fr">
        <button type="button" data-gate="login" class="${isLogin ? 'on' : ''}">Se connecter</button>
        <button type="button" data-gate="register" class="${!isLogin ? 'on' : ''}">Créer un compte</button>
      </div>`}
      <label class="f">Identifiant
        <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${esc(gateOpts.username || '')}" placeholder="ex. isaac">
      </label>
      <label class="f">Mot de passe
        <input name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" required>
      </label>
      ${isLogin ? '' : `<label class="f">Confirmer le mot de passe<input name="password2" type="password" autocomplete="new-password" required></label>
      <p class="sub" style="margin:-4px 0 12px">Identifiant : 3 à 30 caractères (lettres, chiffres, . _ -). Mot de passe : 6 caractères minimum. Notez-le bien : il n’y a pas de récupération par e-mail.</p>`}
      <p class="gate-error" id="gate-error" role="alert"></p>
      <button class="btn primary block" type="submit">${isLogin ? 'Se connecter' : 'Créer mon compte'}</button>
      ${gateOpts.forced
        ? (gateOpts.purpose === 'reset-pin' ? '<button type="button" class="link-btn" data-gate="back-pin">Retour</button>' : '<button type="button" class="link-btn" data-gate="later">Plus tard</button>')
        : '<button type="button" class="link-btn" data-gate="skip">Continuer sans compte</button>'}
    </form>`;
  setTimeout(() => {
    const f = $('#gate-form');
    if (f) (f.elements.username.value ? f.elements.password : f.elements.username).focus();
  }, 50);
}

async function submitGateForm(form) {
  const f = form.elements;
  const err = $('#gate-error');
  const btn = form.querySelector('[type=submit]');
  const isLogin = gateOpts.mode !== 'register';
  const username = f.username.value.trim().toLowerCase();
  err.textContent = '';
  if (!username || !f.password.value) { err.textContent = 'Remplissez l’identifiant et le mot de passe.'; return; }
  if (!isLogin && f.password.value !== f.password2.value) { err.textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
  btn.disabled = true;
  btn.textContent = 'Patientez…';
  try {
    const res = await apiCall(isLogin ? '/api/login' : '/api/register', { method: 'POST', body: { username, password: f.password.value }, token: null });
    if (res.status === 409) throw new Error(res.error);
    if (gateOpts.purpose === 'reset-pin') { writeJSON(PIN_KEY, null); pinFails = 0; }
    await afterLogin(res);
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
    btn.textContent = isLogin ? 'Se connecter' : 'Créer mon compte';
  }
}

async function pressPinKey(k) {
  if (pinWaitUntil > Date.now()) return;
  if (k === '⌫') pinEntry = pinEntry.slice(0, -1);
  else if (pinEntry.length < 4) pinEntry += k;
  renderGate();
  if (pinEntry.length < 4) return;
  if (await checkPin(pinEntry)) {
    pinFails = 0;
    hideGate();
    if (auth && !auth.token) showGate('login', { forced: true, username: auth.username, message: 'Reconnectez-vous pour continuer la synchronisation.' });
    else if (auth) sync();
    return;
  }
  pinFails++;
  pinEntry = '';
  if (pinFails >= 5) { pinFails = 0; pinWaitUntil = Date.now() + 30000; }
  gateOpts.message = 'Code incorrect';
  renderGate();
  const dots = gate.querySelector('.pin-dots');
  if (dots) { dots.classList.add('shake'); setTimeout(() => dots.classList.remove('shake'), 400); }
}

gate.addEventListener('submit', (e) => { e.preventDefault(); submitGateForm(e.target); });

gate.addEventListener('click', (e) => {
  const key = e.target.closest('[data-key]');
  if (key) return pressPinKey(key.dataset.key);
  const g = e.target.closest('[data-gate]');
  if (!g) return;
  switch (g.dataset.gate) {
    case 'login': case 'register':
      gateOpts.mode = g.dataset.gate; gateOpts.message = ''; return renderGate();
    case 'skip':
      writeJSON(SKIP_KEY, true); hideGate(); return toast('Mode sans compte : vos données restent sur ce téléphone');
    case 'later':
      return hideGate();
    case 'back-pin':
      return showGate('pin');
    case 'forgot':
      if (auth) return showGate('login', { forced: true, purpose: 'reset-pin', username: auth.username, message: 'Reconnectez-vous avec votre mot de passe pour retirer le code PIN.' });
      if (confirm('Sans compte, le seul moyen est d’effacer toutes les données de l’app sur ce téléphone. Continuer ?') && confirm('Vraiment tout effacer ?')) {
        try { localStorage.clear(); } catch (err) { /* ignoré */ }
        location.reload();
      }
  }
});

// Clavier physique sur l'écran PIN
document.addEventListener('keydown', (e) => {
  if (gate.hidden || gateOpts.mode !== 'pin') return;
  if (/^\d$/.test(e.key)) pressPinKey(e.key);
  if (e.key === 'Backspace') pressPinKey('⌫');
});

/* ---------- Réglages : section « Mon compte » ---------- */

function accountSettingsHTML() {
  const hasPin = !!readJSON(PIN_KEY);
  return `
    <section class="card">
      <h2>Mon compte</h2>
      ${auth ? `
        <div class="settings-row"><span>👤 <b>${esc(auth.username)}</b></span><span class="sub" id="sync-line">${syncLineText()}</span></div>
        <div class="btn-row" style="margin:10px 0 8px">
          <button class="btn" id="sync-now">🔄 Synchroniser</button>
          <button class="btn" id="change-password">🔑 Mot de passe</button>
        </div>
        <div class="btn-row" style="margin-bottom:6px"><button class="btn danger" id="logout">Se déconnecter</button></div>
      ` : `
        <p class="sub" style="margin-top:0">Créez un compte (identifiant + mot de passe) pour sauvegarder vos données en ligne et les retrouver sur tous vos appareils.</p>
        <div class="btn-row" style="margin-bottom:6px"><button class="btn primary" id="open-login">Se connecter / Créer un compte</button></div>
      `}
      <div class="settings-row">
        <span>🔒 Code PIN <span class="sub">${hasPin ? 'activé' : 'désactivé'}</span></span>
        <span class="btn-row" style="flex:none">
          ${pinSupported()
            ? (hasPin ? '<button class="btn" id="pin-change">Modifier</button><button class="btn danger" id="pin-off">Retirer</button>' : '<button class="btn" id="pin-on">Activer</button>')
            : '<span class="sub">Indisponible ici (connexion non sécurisée)</span>'}
        </span>
      </div>
    </section>`;
}

document.addEventListener('click', (e) => {
  const id = e.target.closest('button')?.id;
  switch (id) {
    case 'sync-dot':
    case 'sync-now':
      return sync({ quiet: false }).then((ok) => ok && id === 'sync-now' && toast('Synchronisé ✓'));
    case 'change-password': return openPasswordSheet();
    case 'logout': return logout();
    case 'open-login': return showGate('login', { forced: false });
    case 'pin-on': case 'pin-change': return openPinSheet();
    case 'pin-off':
      if (confirm('Retirer le code PIN ?')) { writeJSON(PIN_KEY, null); render(); toast('Code PIN retiré'); }
  }
});

/* ---------- Démarrage ---------- */

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (readJSON(PIN_KEY) && gate.hidden && Date.now() - hiddenAt > LOCK_AFTER_MS) showGate('pin');
  if (auth) sync();
});
window.addEventListener('online', () => auth && sync());
setInterval(() => { if (auth && !document.hidden) sync(); }, SYNC_EVERY_MS);

(function startAccount() {
  setSyncStatus(auth && auth.dirty ? 'pending' : 'idle');
  if (readJSON(PIN_KEY)) showGate('pin');
  else if (auth && !auth.token) showGate('login', { forced: true, username: auth.username, message: 'Reconnectez-vous pour continuer la synchronisation.' });
  else if (!auth && !readJSON(SKIP_KEY)) showGate('login');
  if (auth && auth.token) sync();
})();
