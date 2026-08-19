// Cognito Hosted UI login (Authorization Code + PKCE). The password never
// touches this app's JS — it's typed on Cognito's own page. Tokens live in
// localStorage (standard for SPAs); a leaked XSS bug could read them, but
// nothing here ever handles the password itself.
const cfg = window.SLIDES_EDITOR_CONFIG;
const TOKENS_KEY = 'slides-editor:tokens';
const VERIFIER_KEY = 'slides-editor:pkce-verifier';

function b64url(bytes) {
  let str = btoa(String.fromCharCode(...bytes));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
}

function clearTokens() {
  localStorage.removeItem(TOKENS_KEY);
}

async function beginLogin() {
  const verifier = randomVerifier();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const challenge = await challengeFor(verifier);
  const url = new URL(`${cfg.cognitoDomain}/oauth2/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.userPoolClientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', challenge);
  window.location.assign(url.toString());
}

function logout() {
  clearTokens();
  const url = new URL(`${cfg.cognitoDomain}/logout`);
  url.searchParams.set('client_id', cfg.userPoolClientId);
  url.searchParams.set('logout_uri', cfg.redirectUri);
  window.location.assign(url.toString());
}

async function exchangeCodeForTokens(code) {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.userPoolClientId,
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier || '',
  });
  const res = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('falha ao trocar código por token');
  const data = await res.json();
  saveTokens({
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    obtainedAt: Date.now(),
    expiresIn: data.expires_in,
  });
}

async function refreshTokens() {
  const tokens = loadTokens();
  if (!tokens?.refreshToken) return false;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.userPoolClientId,
    refresh_token: tokens.refreshToken,
  });
  const res = await fetch(`${cfg.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) return false;
  const data = await res.json();
  saveTokens({
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: tokens.refreshToken, // Cognito doesn't rotate it by default
    obtainedAt: Date.now(),
    expiresIn: data.expires_in,
  });
  return true;
}

function isExpired(tokens) {
  if (!tokens) return true;
  const ageMs = Date.now() - tokens.obtainedAt;
  return ageMs > (tokens.expiresIn - 60) * 1000; // refresh a minute early
}

// Called once on page load. Handles the `?code=...` redirect back from
// Hosted UI, then guarantees a usable id_token (refreshing if needed).
// Returns the id_token, or null if the user needs to log in.
async function ensureAuthenticated() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    await exchangeCodeForTokens(code);
    window.history.replaceState({}, '', window.location.pathname);
  }

  let tokens = loadTokens();
  if (!tokens) return null;
  if (isExpired(tokens)) {
    const ok = await refreshTokens();
    if (!ok) {
      clearTokens();
      return null;
    }
    tokens = loadTokens();
  }
  return tokens.idToken;
}

// Wraps fetch() with the current id_token, refreshing once on a 401 before
// giving up — covers the case where a token expired mid-session.
async function authedFetch(url, options = {}) {
  let tokens = loadTokens();
  if (!tokens) throw new Error('não autenticado');
  const doFetch = () =>
    fetch(url, { ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${tokens.idToken}` } });

  let res = await doFetch();
  if (res.status === 401) {
    const ok = await refreshTokens();
    if (ok) {
      tokens = loadTokens();
      res = await doFetch();
    }
  }
  return res;
}

window.SlidesEditorAuth = { beginLogin, logout, ensureAuthenticated, authedFetch };
