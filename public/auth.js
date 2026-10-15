'use strict';

/* ============================================================
   Compte en ligne, synchronisation entre appareils et code PIN.
   S'appuie sur app.js (state, save, render, openSheet, toast…).
   ============================================================ */

const AUTH_KEY = 'caisse.auth';
const PIN_KEY = 'caisse.pin';
const BIO_KEY = 'caisse.bio'; // { username, credId } : Face ID / empreinte activé sur cet appareil
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
  showGate('login', { forced: true, username: auth.username, message: 'Votre session a expiré. Reconnectez-vous pour continuer.' });
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
  showGate('login', { autoTried: true }); // pas de Face ID automatique juste après une déconnexion
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
  }, () => sheetForm.elements.pin1.focus());
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

/* ---------- Face ID / empreinte (WebAuthn) ---------- */

const isApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
const BIO_NAME = isApple ? 'Face ID' : 'l’empreinte';
const BIO_LABEL = isApple ? 'Face ID / Touch ID' : 'Empreinte digitale';
const BIO_ICON = isApple ? '🙂' : '👆';

let bioAvailable = false;
const bioCheck = (window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable)
  ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then((ok) => { bioAvailable = !!ok; }).catch(() => {})
  : Promise.resolve();

const bioMarker = () => readJSON(BIO_KEY);
// Face ID utilisable pour déverrouiller : activé sur cet appareil pour le compte connecté
const bioReady = () => { const m = bioMarker(); return !!(m && auth && m.username === auth.username && window.PublicKeyCredential); };
const hasPinSet = () => !!readJSON(PIN_KEY);
const lockEnabled = () => hasPinSet() || bioReady();

const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

function creationOptions(o) {
  return {
    ...o, challenge: fromB64u(o.challenge), user: { ...o.user, id: fromB64u(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })),
  };
}
function requestOptions(o) {
  return { ...o, challenge: fromB64u(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: fromB64u(c.id) })) };
}
function credentialJSON(c) {
  const r = c.response;
  const out = { id: c.id, rawId: toB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {}, authenticatorAttachment: c.authenticatorAttachment || undefined, response: { clientDataJSON: toB64u(r.clientDataJSON) } };
  if (r.attestationObject) {
    out.response.attestationObject = toB64u(r.attestationObject);
    out.response.transports = r.getTransports ? r.getTransports() : [];
  } else {
    Object.assign(out.response, { authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: r.userHandle ? toB64u(r.userHandle) : undefined });
  }
  return out;
}

function bioError(e) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return new Error(`${BIO_LABEL} : vérification annulée ou non reconnue.`);
  if (e && e.name === 'InvalidStateError') return new Error(`${BIO_LABEL} est déjà activé pour ce compte sur cet appareil.`);
  return e instanceof Error ? e : new Error(String(e));
}

// Options préparées à l'avance : sur iPhone, Face ID doit se lancer juste après l'appui
const prefetched = {};
function prefetch(kind) {
  const url = kind === 'reg' ? '/api/passkey/register-options' : '/api/passkey/login-options';
  const body = kind === 'reg' ? {} : { credentialId: (bioMarker() || {}).credId };
  const token = kind === 'reg' ? undefined : null;
  prefetched[kind] = { at: Date.now(), p: apiCall(url, { method: 'POST', body, token }) };
  prefetched[kind].p.catch(() => {});
}
async function takeOptions(kind) {
  const f = prefetched[kind];
  delete prefetched[kind];
  if (f && Date.now() - f.at < 4 * 60000) { try { return await f.p; } catch (e) { /* on réessaie */ } }
  prefetch(kind);
  const g = prefetched[kind]; delete prefetched[kind];
  return g.p;
}

async function enableBio() {
  try {
    const { options, challengeToken } = await takeOptions('reg');
    const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
    const label = isApple ? 'iPhone / iPad' : (navigator.userAgentData && navigator.userAgentData.platform) || 'Android';
    const res = await apiCall('/api/passkey/register', { method: 'POST', body: { response: credentialJSON(cred), challengeToken, label } });
    writeJSON(BIO_KEY, { username: auth.username, credId: res.id });
    render();
    toast(`${BIO_LABEL} activé ${BIO_ICON}`);
  } catch (e) {
    toast('⚠️ ' + bioError(e).message);
    render();
  }
}

async function disableBio() {
  if (!confirm(`Désactiver ${BIO_NAME} sur cet appareil ?`)) return;
  const m = bioMarker();
  try { if (m) await apiCall('/api/passkey/delete', { method: 'POST', body: { id: m.credId } }); }
  catch (e) { toast('⚠️ ' + e.message); return; }
  writeJSON(BIO_KEY, null);
  render();
  toast(`${BIO_LABEL} désactivé`);
}

// Vérifie le visage / l'empreinte. Avec le réseau : vérifié par le serveur (renvoie une session).
// Sans réseau (déverrouillage seulement) : vérifié par le téléphone.
async function bioAuthenticate({ allowOffline = false } = {}) {
  const m = bioMarker();
  let opts;
  try { opts = await takeOptions('auth'); }
  catch (e) {
    if (!(e.offline && allowOffline && m)) throw e;
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    try {
      await navigator.credentials.get({ publicKey: { challenge, allowCredentials: [{ type: 'public-key', id: fromB64u(m.credId) }], userVerification: 'required', timeout: 60000 } });
    } catch (err) { throw bioError(err); }
    return { offline: true };
  }
  let cred;
  try { cred = await navigator.credentials.get({ publicKey: requestOptions(opts.options) }); }
  catch (err) { throw bioError(err); }
  try {
    return await apiCall('/api/passkey/login', { method: 'POST', body: { response: credentialJSON(cred), challengeToken: opts.challengeToken }, token: null });
  } catch (e) {
    // Le réseau a coupé après la vérification par le téléphone : on déverrouille quand même
    if (e.offline && allowOffline && m && cred.id === m.credId) return { offline: true };
    throw e;
  }
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
    const pin = hasPinSet(), bio = bioReady();
    // Face ID / empreinte en premier : le clavier PIN n'apparaît que sur demande
    const bioFirst = bio && !gateOpts.showPin;
    if (bioFirst) {
      gate.innerHTML = `
      <div class="gate-box">
        ${logo}
        <p class="gate-msg">${esc(gateOpts.message || 'Application verrouillée')}</p>
        <button type="button" class="bio-big" data-gate="bio-unlock" aria-label="Déverrouiller avec ${BIO_NAME}">
          <span class="bio-big-icon">${BIO_ICON}</span>
          <span>Déverrouiller avec ${BIO_NAME}</span>
        </button>
        ${pin ? '<button type="button" class="link-btn" data-gate="use-pin">Utiliser le code PIN</button>' : ''}
        <button type="button" class="link-btn" data-gate="unlock-password">Utiliser mon mot de passe</button>
      </div>`;
      if (!gateOpts.prefetched) { gateOpts.prefetched = true; prefetch('auth'); }
      if (!gateOpts.autoTried) { gateOpts.autoTried = true; setTimeout(() => gateOpts.mode === 'pin' && !gateOpts.showPin && bioUnlock(null, { auto: true }), 0); }
      return;
    }
    gate.innerHTML = `
      <div class="gate-box">
        ${logo}
        <p class="gate-msg">${waiting ? `Trop d’essais. Patientez ${Math.ceil((pinWaitUntil - Date.now()) / 1000)} s.` : esc(gateOpts.message || (pin ? 'Entrez votre code' : 'Application verrouillée'))}</p>
        ${pin ? `
        <div class="pin-dots">${[0, 1, 2, 3].map((i) => `<span class="${i < pinEntry.length ? 'on' : ''}"></span>`).join('')}</div>
        <div class="keypad">
          ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) =>
            k ? `<button type="button" data-key="${k}" ${waiting ? 'disabled' : ''} aria-label="${k === '⌫' ? 'Effacer' : k}">${k}</button>` : '<span></span>').join('')}
        </div>
        ${bio ? `<button type="button" class="link-btn" data-gate="use-bio">${BIO_ICON} Utiliser ${BIO_NAME}</button>` : ''}
        <button type="button" class="link-btn" data-gate="forgot">Code oublié ?</button>`
        : '<button type="button" class="link-btn" data-gate="unlock-password">Utiliser mon mot de passe</button>'}
      </div>`;
    if (waiting) setTimeout(() => gateOpts.mode === 'pin' && renderGate(), 1000);
    if (bio && !gateOpts.prefetched) { gateOpts.prefetched = true; prefetch('auth'); }
    return;
  }
  const isLogin = mode !== 'register';
  const marker = bioMarker();
  if (isLogin && !gateOpts.purpose && !gateOpts.showPassword && marker && window.PublicKeyCredential
      && (!gateOpts.username || gateOpts.username === marker.username)) {
    gate.innerHTML = `
      <div class="gate-box">
        ${logo}
        <p class="gate-msg">${esc(gateOpts.message || `Bonjour ${marker.username}`)}</p>
        <button type="button" class="bio-big" data-gate="bio-login" aria-label="Se connecter avec ${BIO_NAME}">
          <span class="bio-big-icon">${BIO_ICON}</span>
          <span>Se connecter avec ${BIO_NAME}</span>
        </button>
        <p class="gate-error" id="gate-error" role="alert" style="text-align:center"></p>
        <button type="button" class="link-btn" data-gate="show-password">Utiliser mon mot de passe</button>
        <button type="button" class="link-btn" data-gate="other-account">Autre compte / créer un compte</button>
      </div>`;
    if (!gateOpts.prefetched) { gateOpts.prefetched = true; prefetch('auth'); }
    if (!gateOpts.autoTried) { gateOpts.autoTried = true; setTimeout(() => gateOpts.mode === 'login' && !gateOpts.showPassword && bioLogin(gate.querySelector('[data-gate=bio-login]'), { auto: true }), 0); }
    return;
  }
  gate.innerHTML = `
    <form class="gate-box" id="gate-form" novalidate>
      ${logo}
      <p class="gate-msg">${esc(gateOpts.message || 'Votre portefeuille, vos dépenses et vos revenus, sur tous vos appareils.')}</p>
      ${gateOpts.forced ? '' : `<div class="type-switch" style="grid-template-columns:1fr 1fr">
        <button type="button" data-gate="login" class="${isLogin ? 'on' : ''}">Se connecter</button>
        <button type="button" data-gate="register" class="${!isLogin ? 'on' : ''}">Créer un compte</button>
      </div>`}
      ${isLogin && !gateOpts.purpose && bioMarker() && window.PublicKeyCredential ? `
        <button type="button" class="btn primary block bio-btn" data-gate="bio-login">${BIO_ICON} Se connecter avec ${BIO_NAME} (${esc(bioMarker().username)})</button>
        <p class="gate-or"><span>ou avec le mot de passe</span></p>` : ''}
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
      ${gateOpts.purpose ? '<button type="button" class="link-btn" data-gate="back-pin">Retour</button>' : ''}
      ${gateOpts.forced && !gateOpts.purpose ? '<button type="button" class="link-btn" data-gate="switch">Utiliser un autre compte</button>' : ''}
    </form>`;
  const showsBio = !!gate.querySelector('[data-gate=bio-login]');
  if (showsBio && !gateOpts.prefetched) { gateOpts.prefetched = true; prefetch('auth'); }
  setTimeout(() => {
    const f = $('#gate-form');
    if (f && !showsBio) (f.elements.username.value ? f.elements.password : f.elements.username).focus();
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
    if (gateOpts.purpose === 'unlock' && auth && res.username === auth.username) {
      auth.token = res.token; saveAuth(); return unlocked();
    }
    await afterLogin(res);
  } catch (e) {
    err.textContent = e.message;
    btn.disabled = false;
    btn.textContent = isLogin ? 'Se connecter' : 'Créer mon compte';
  }
}

function unlocked() {
  pinFails = 0;
  hideGate();
  if (!auth) showGate('login');
  else if (!auth.token) showGate('login', { forced: true, username: auth.username, message: 'Reconnectez-vous pour continuer.' });
  else sync();
}

let bioBusy = false;
async function bioUnlock(btn, { auto = false } = {}) {
  if (bioBusy) return;
  bioBusy = true;
  if (btn) btn.disabled = true;
  try {
    const res = await bioAuthenticate({ allowOffline: true });
    if (res.token && auth && res.username === auth.username) { auth.token = res.token; saveAuth(); }
    unlocked();
  } catch (e) {
    if (gateOpts.mode !== 'pin') return;
    // Lancement automatique refusé (sur iPhone, Face ID demande un appui) : on attend l'appui sans message d'erreur
    gateOpts.message = auto ? `Touchez l’écran pour utiliser ${BIO_NAME}` : e.message;
    gateOpts.prefetched = false;
    renderGate();
  } finally {
    bioBusy = false;
  }
}

async function bioLogin(btn, { auto = false } = {}) {
  if (bioBusy || !btn) return;
  bioBusy = true;
  btn.disabled = true;
  try {
    const res = await bioAuthenticate();
    await afterLogin(res);
  } catch (e) {
    const err = $('#gate-error');
    // Lancement automatique refusé (iPhone : Face ID demande un appui) : pas de message d'erreur
    if (err) err.textContent = auto && !e.status && !e.offline ? '' : e.message;
    const msg = gate.querySelector('.gate-msg');
    if (auto && msg && !e.status && !e.offline) msg.textContent = `Touchez l’écran pour utiliser ${BIO_NAME}`;
    btn.disabled = false;
    gateOpts.prefetched = true;
    prefetch('auth');
  } finally {
    bioBusy = false;
  }
}

async function pressPinKey(k) {
  if (pinWaitUntil > Date.now()) return;
  if (k === '⌫') pinEntry = pinEntry.slice(0, -1);
  else if (pinEntry.length < 4) pinEntry += k;
  renderGate();
  if (pinEntry.length < 4) return;
  if (await checkPin(pinEntry)) return unlocked();
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
  if (!e.target.closest('button, a, input, label, select, textarea')) {
    const big = gate.querySelector('.bio-big');
    if (big && !big.disabled) return big.click();
  }
  const key = e.target.closest('[data-key]');
  if (key) return pressPinKey(key.dataset.key);
  const g = e.target.closest('[data-gate]');
  if (!g) return;
  switch (g.dataset.gate) {
    case 'login': case 'register':
      gateOpts.mode = g.dataset.gate; gateOpts.message = ''; return renderGate();
    case 'switch':
      return showGate('login', { showPassword: true });
    case 'bio-unlock':
      return bioUnlock(g);
    case 'show-password':
      gateOpts.showPassword = true; gateOpts.message = ''; return renderGate();
    case 'other-account':
      return showGate('login', { showPassword: true });
    case 'use-pin':
      gateOpts.showPin = true; gateOpts.message = ''; return renderGate();
    case 'use-bio':
      gateOpts.showPin = false; gateOpts.message = ''; renderGate(); return bioUnlock(gate.querySelector('[data-gate=bio-unlock]'));
    case 'bio-login':
      return bioLogin(g);
    case 'unlock-password':
      return showGate('login', { forced: true, purpose: 'unlock', username: auth && auth.username, message: 'Entrez votre mot de passe pour déverrouiller.' });
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
  if (gate.hidden || gateOpts.mode !== 'pin' || !gate.querySelector('.keypad')) return;
  if (/^\d$/.test(e.key)) pressPinKey(e.key);
  if (e.key === 'Backspace') pressPinKey('⌫');
});

/* ---------- Réglages : section « Mon compte » ---------- */

function accountSettingsHTML() {
  const hasPin = !!readJSON(PIN_KEY);
  const bioOn = bioReady();
  if (auth && auth.token && bioAvailable && !bioOn && !prefetched.reg) prefetch('reg');
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
      ` : ''}
      <div class="settings-row">
        <span>🔒 Code PIN <span class="sub">${hasPin ? 'activé' : 'désactivé'}</span></span>
        <span class="btn-row" style="flex:none">
          ${pinSupported()
            ? (hasPin ? '<button class="btn" id="pin-change">Modifier</button><button class="btn danger" id="pin-off">Retirer</button>' : '<button class="btn" id="pin-on">Activer</button>')
            : '<span class="sub">Indisponible ici (connexion non sécurisée)</span>'}
        </span>
      </div>
      ${auth ? `<div class="settings-row">
        <span>${BIO_ICON} ${BIO_LABEL} <span class="sub">${bioOn ? 'activé' : 'désactivé'}</span></span>
        <span class="btn-row" style="flex:none">
          ${bioAvailable
            ? (bioOn ? '<button class="btn danger" id="bio-off">Retirer</button>' : '<button class="btn" id="bio-on">Activer</button>')
            : '<span class="sub">Non disponible sur cet appareil</span>'}
        </span>
      </div>
      <p class="sub" style="margin:4px 0 0">${BIO_LABEL} déverrouille l’app et permet de vous connecter sans mot de passe sur cet appareil.</p>` : ''}
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
    case 'pin-on': case 'pin-change': return openPinSheet();
    case 'bio-on': return enableBio();
    case 'bio-off': return disableBio();
    case 'pin-off':
      if (confirm('Retirer le code PIN ?')) { writeJSON(PIN_KEY, null); render(); toast('Code PIN retiré'); }
  }
});

/* ---------- Démarrage ---------- */

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (lockEnabled() && gate.hidden && Date.now() - hiddenAt > LOCK_AFTER_MS) showGate('pin');
  if (auth) sync();
});
window.addEventListener('online', () => auth && sync());
setInterval(() => { if (auth && !document.hidden) sync(); }, SYNC_EVERY_MS);

bioCheck.then(() => { if (ui.view === 'settings' && gate.hidden) render(); });

(function startAccount() {
  setSyncStatus(auth && auth.dirty ? 'pending' : 'idle');
  if (lockEnabled()) showGate('pin');
  else if (auth && !auth.token) showGate('login', { forced: true, username: auth.username, message: 'Reconnectez-vous pour continuer.' });
  else if (!auth) showGate('login');
  if (auth && auth.token) sync();
})();
