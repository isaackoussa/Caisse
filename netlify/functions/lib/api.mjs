// API de Caisse : comptes utilisateurs et stockage des données.
// Indépendante de Netlify : on lui fournit une fabrique de « stores »
// (Netlify Blobs en production, un stockage local pour le développement).

import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const TOKEN_DAYS = 180;
const MAX_FAILS = 5;
const LOCK_MINUTES = 5;
const MAX_DATA_BYTES = 4 * 1024 * 1024;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const CRED_ID_RE = /^[A-Za-z0-9_-]{16,1400}$/;
const MAX_PASSKEYS = 10;
const CHALLENGE_MINUTES = 5;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function scrypt(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))));
}

export function makeHandler(getStore) {
  const users = () => getStore({ name: 'caisse-users', consistency: 'strong' });
  const vaults = () => getStore({ name: 'caisse-data', consistency: 'strong' });
  const config = () => getStore({ name: 'caisse-config', consistency: 'strong' });
  const passkeyIndex = () => getStore({ name: 'caisse-passkeys', consistency: 'strong' });

  // Clé de signature des jetons : variable d'environnement, sinon générée une fois et conservée.
  let secretCache = process.env.CAISSE_SECRET || null;
  async function secret() {
    if (secretCache) return secretCache;
    const store = config();
    await store.set('secret', crypto.randomBytes(32).toString('hex'), { onlyIfNew: true });
    secretCache = await store.get('secret');
    return secretCache;
  }

  async function sign(payload) {
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', await secret()).update(body).digest());
    return `${body}.${sig}`;
  }

  async function verify(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    const expected = b64url(crypto.createHmac('sha256', await secret()).update(body).digest());
    const a = Buffer.from(sig || ''), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      return p.exp > Date.now() ? p : null;
    } catch { return null; }
  }

  // Vérifie le jeton et renvoie l'utilisateur (le changement de mot de passe invalide les anciens jetons)
  async function authUser(req) {
    const h = req.headers.get('authorization') || '';
    const p = await verify(h.replace(/^Bearer\s+/i, ''));
    if (!p || p.k) return null; // un jeton de défi n'est pas une session
    const user = await users().get(p.u, { type: 'json' });
    if (!user || user.tv !== p.tv) return null;
    return { name: p.u, user };
  }

  const issue = async (name, user) => ({
    username: name,
    token: await sign({ u: name, tv: user.tv, exp: Date.now() + TOKEN_DAYS * 864e5 }),
  });

  async function readBody(req) {
    const text = await req.text();
    if (text.length > MAX_DATA_BYTES) throw Object.assign(new Error('Données trop volumineuses'), { status: 413 });
    try { return JSON.parse(text || '{}'); }
    catch { throw Object.assign(new Error('Requête invalide'), { status: 400 }); }
  }

  function cleanCredentials(body) {
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    return { username, password };
  }

  /* ---------- Routes ---------- */

  async function register(req) {
    const { username, password } = cleanCredentials(await readBody(req));
    if (!USERNAME_RE.test(username)) {
      return json({ error: 'Identifiant invalide : 3 à 30 caractères (lettres, chiffres, point, tiret, tiret bas).' }, 400);
    }
    if (password.length < 6) return json({ error: 'Le mot de passe doit faire au moins 6 caractères.' }, 400);
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt)).toString('hex');
    const user = { salt, hash, tv: 1, fails: 0, lockUntil: 0, created: new Date().toISOString() };
    const res = await users().setJSON(username, user, { onlyIfNew: true });
    if (res && res.modified === false) return json({ error: 'Cet identifiant est déjà pris.' }, 409);
    return json(await issue(username, user), 201);
  }

  async function login(req) {
    const { username, password } = cleanCredentials(await readBody(req));
    const store = users();
    const user = USERNAME_RE.test(username) ? await store.get(username, { type: 'json' }) : null;
    const wrong = json({ error: 'Identifiant ou mot de passe incorrect.' }, 401);
    if (!user) {
      await scrypt(password, 'leurre'); // même durée de réponse qu'un mauvais mot de passe
      return wrong;
    }
    if (user.lockUntil > Date.now()) {
      const min = Math.ceil((user.lockUntil - Date.now()) / 60000);
      return json({ error: `Trop d’essais. Réessayez dans ${min} minute${min > 1 ? 's' : ''}.` }, 429);
    }
    const hash = await scrypt(password, user.salt);
    if (!crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) {
      user.fails = (user.fails || 0) + 1;
      if (user.fails >= MAX_FAILS) { user.fails = 0; user.lockUntil = Date.now() + LOCK_MINUTES * 60000; }
      await store.setJSON(username, user);
      return wrong;
    }
    if (user.fails || user.lockUntil) { user.fails = 0; user.lockUntil = 0; await store.setJSON(username, user); }
    return json(await issue(username, user));
  }

  async function changePassword(req, auth) {
    const body = await readBody(req);
    const { user, name } = auth;
    const current = await scrypt(String(body.current || ''), user.salt);
    if (!crypto.timingSafeEqual(current, Buffer.from(user.hash, 'hex'))) {
      return json({ error: 'Mot de passe actuel incorrect.' }, 403);
    }
    const next = String(body.password || '');
    if (next.length < 6) return json({ error: 'Le mot de passe doit faire au moins 6 caractères.' }, 400);
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = (await scrypt(next, user.salt)).toString('hex');
    user.tv = (user.tv || 1) + 1; // déconnecte les autres appareils
    await users().setJSON(name, user);
    return json(await issue(name, user));
  }

  async function getData(auth) {
    const entry = await vaults().get(auth.name, { type: 'json' });
    return json(entry || { rev: 0, data: null, updatedAt: null });
  }

  async function putData(req, auth) {
    const body = await readBody(req);
    const d = body.data;
    if (!d || typeof d !== 'object' || !Array.isArray(d.transactions) || !Array.isArray(d.accounts) || !Array.isArray(d.categories)) {
      return json({ error: 'Format de données invalide.' }, 400);
    }
    const store = vaults();
    const current = await store.getWithMetadata(auth.name, { type: 'json' });
    const rev = current ? current.data.rev : 0;
    // Un autre appareil a écrit entre-temps : le client doit fusionner puis renvoyer
    if (body.baseRev !== rev) return json({ conflict: true, ...(current ? current.data : { rev: 0, data: null }) }, 409);
    const entry = { rev: rev + 1, data: d, updatedAt: new Date().toISOString() };
    const res = await store.setJSON(auth.name, entry, current ? { onlyIfMatch: current.etag } : { onlyIfNew: true });
    if (res && res.modified === false) {
      const latest = await store.get(auth.name, { type: 'json' });
      return json({ conflict: true, ...latest }, 409);
    }
    return json({ rev: entry.rev, updatedAt: entry.updatedAt });
  }

  /* ---------- Face ID / empreinte (WebAuthn) ---------- */

  // Le site (domaine) auquel la clé est liée : celui qui reçoit la requête
  function site(req) {
    const u = new URL(req.url);
    return { rpID: u.hostname, origin: u.origin };
  }

  async function challengeToken(challenge, kind, username) {
    return sign({ k: kind, c: challenge, u: username || null, exp: Date.now() + CHALLENGE_MINUTES * 60000 });
  }

  async function readChallenge(token, kind) {
    const p = await verify(token);
    if (!p || p.k !== kind) throw Object.assign(new Error('Demande expirée, réessayez.'), { status: 400 });
    return p;
  }

  async function passkeyRegisterOptions(req, auth) {
    const { rpID } = site(req);
    const list = auth.user.passkeys || [];
    const options = await generateRegistrationOptions({
      rpName: 'Caisse', rpID, userName: auth.name, userDisplayName: auth.name,
      userID: new TextEncoder().encode(auth.name),
      attestationType: 'none',
      excludeCredentials: list.map((k) => ({ id: k.id, transports: k.transports })),
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
    });
    return json({ options, challengeToken: await challengeToken(options.challenge, 'reg', auth.name) });
  }

  async function passkeyRegister(req, auth) {
    const body = await readBody(req);
    const ch = await readChallenge(body.challengeToken, 'reg');
    if (ch.u !== auth.name) return json({ error: 'Demande invalide.' }, 400);
    const { rpID, origin } = site(req);
    let v;
    try {
      v = await verifyRegistrationResponse({
        response: body.response, expectedChallenge: ch.c, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      });
    } catch (e) { return json({ error: 'Vérification impossible : ' + e.message }, 400); }
    if (!v.verified) return json({ error: 'Vérification refusée.' }, 400);
    const cred = v.registrationInfo.credential;
    const user = (await users().get(auth.name, { type: 'json' })) || auth.user;
    user.passkeys = (user.passkeys || []).filter((k) => k.id !== cred.id);
    if (user.passkeys.length >= MAX_PASSKEYS) return json({ error: 'Trop d’appareils enregistrés. Retirez-en un d’abord.' }, 400);
    user.passkeys.push({
      id: cred.id, publicKey: Buffer.from(cred.publicKey).toString('base64url'), counter: cred.counter,
      transports: cred.transports || body.response?.response?.transports || [],
      label: String(body.label || 'Appareil').slice(0, 40), created: new Date().toISOString(),
    });
    await users().setJSON(auth.name, user);
    await passkeyIndex().setJSON(cred.id, { username: auth.name });
    return json({ id: cred.id });
  }

  async function passkeyLoginOptions(req) {
    const body = await readBody(req);
    const { rpID } = site(req);
    const hint = CRED_ID_RE.test(String(body.credentialId || '')) ? [{ id: body.credentialId }] : [];
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: hint });
    return json({ options, challengeToken: await challengeToken(options.challenge, 'auth') });
  }

  async function passkeyLogin(req) {
    const body = await readBody(req);
    const ch = await readChallenge(body.challengeToken, 'auth');
    const credId = String(body.response?.id || '');
    const refused = json({ error: 'Face ID / empreinte non reconnu pour ce site. Connectez-vous avec votre mot de passe.' }, 401);
    if (!CRED_ID_RE.test(credId)) return refused;
    const link = await passkeyIndex().get(credId, { type: 'json' });
    if (!link) return refused;
    const store = users();
    const user = await store.get(link.username, { type: 'json' });
    const key = user && (user.passkeys || []).find((k) => k.id === credId);
    if (!key) return refused;
    const { rpID, origin } = site(req);
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: body.response, expectedChallenge: ch.c, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: key.id, publicKey: Buffer.from(key.publicKey, 'base64url'), counter: key.counter, transports: key.transports },
      });
    } catch (e) { return refused; }
    if (!v.verified) return refused;
    key.counter = v.authenticationInfo.newCounter;
    key.lastUsed = new Date().toISOString();
    user.fails = 0; user.lockUntil = 0;
    await store.setJSON(link.username, user);
    return json(await issue(link.username, user));
  }

  async function passkeyDelete(req, auth) {
    const body = await readBody(req);
    const user = (await users().get(auth.name, { type: 'json' })) || auth.user;
    const before = (user.passkeys || []).length;
    user.passkeys = (user.passkeys || []).filter((k) => k.id !== body.id);
    if (user.passkeys.length !== before) {
      await users().setJSON(auth.name, user);
      await passkeyIndex().delete(String(body.id));
    }
    return json({ ok: true });
  }

  return async function handler(req) {
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'POST' && path === '/api/register') return await register(req);
      if (req.method === 'POST' && path === '/api/login') return await login(req);
      if (req.method === 'POST' && path === '/api/passkey/login-options') return await passkeyLoginOptions(req);
      if (req.method === 'POST' && path === '/api/passkey/login') return await passkeyLogin(req);

      const auth = await authUser(req);
      if (!auth) return json({ error: 'Session expirée, reconnectez-vous.' }, 401);

      if (req.method === 'GET' && path === '/api/me') return json({ username: auth.name, created: auth.user.created });
      if (req.method === 'POST' && path === '/api/password') return await changePassword(req, auth);
      if (req.method === 'GET' && path === '/api/data') return await getData(auth);
      if (req.method === 'PUT' && path === '/api/data') return await putData(req, auth);
      if (req.method === 'POST' && path === '/api/passkey/register-options') return await passkeyRegisterOptions(req, auth);
      if (req.method === 'POST' && path === '/api/passkey/register') return await passkeyRegister(req, auth);
      if (req.method === 'POST' && path === '/api/passkey/delete') return await passkeyDelete(req, auth);
      return json({ error: 'Introuvable' }, 404);
    } catch (e) {
      if (e.status) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Erreur du serveur' }, 500);
    }
  };
}
