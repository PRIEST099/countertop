/**
 * Account linking, the way Alexa+ does it for MCP add-ons:
 * unauthenticated probe → Protected Resource Metadata (RFC 9728) → Authorization Server Metadata
 * (RFC 8414) → client registration → authorization code + PKCE S256 with `resource` (RFC 8707) → tokens.
 */
export interface Discovery {
  mcpUrl: string;
  unauthStatus: number;
  wwwAuthenticate: string | null;
  prmUrl?: string;
  prm?: any;
  /** Alexa+ reads PRM from exactly /.well-known/oauth-protected-resource at the origin. */
  rootPrm?: boolean;
  asMeta?: any;
  errors: string[];
}

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  clientId: string;
}

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function discover(mcpUrl: string): Promise<Discovery> {
  const d: Discovery = { mcpUrl, unauthStatus: 0, wwwAuthenticate: null, errors: [] };
  try {
    const probe = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'countertop-probe', version: '0.1.0' } } }),
    });
    d.unauthStatus = probe.status;
    d.wwwAuthenticate = probe.headers.get('www-authenticate');
  } catch (e) {
    d.errors.push(`Could not reach ${mcpUrl}: ${e}`);
    return d;
  }
  if (d.unauthStatus !== 401) return d; // no auth required

  const u = new URL(mcpUrl);
  const fromHeader = d.wwwAuthenticate?.match(/resource_metadata="([^"]+)"/)?.[1];
  const candidates = [fromHeader, `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[];
  for (const url of candidates) {
    const r = await fetch(url).catch(() => undefined);
    if (r?.ok) {
      d.prmUrl = url;
      d.prm = await r.json();
      break;
    }
  }
  if (!d.prm) {
    d.errors.push('No Protected Resource Metadata found');
    return d;
  }
  d.rootPrm = (await fetch(`${u.origin}/.well-known/oauth-protected-resource`).catch(() => undefined))?.ok ?? false;
  const issuer = new URL(d.prm.authorization_servers?.[0] ?? u.origin);
  const asCandidates = [
    `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname === '/' ? '' : issuer.pathname}`,
    `${issuer.origin}/.well-known/openid-configuration${issuer.pathname === '/' ? '' : issuer.pathname}`,
  ];
  for (const url of asCandidates) {
    const r = await fetch(url).catch(() => undefined);
    if (r?.ok) {
      d.asMeta = await r.json();
      break;
    }
  }
  if (!d.asMeta) d.errors.push('No Authorization Server Metadata found');
  return d;
}

const redirectUri = () => `${location.origin}/oauth/callback`;

/**
 * Like Alexa+: a pre-registered client_id (`?client_id=`) if you give one, else Dynamic Client
 * Registration when the server offers it (a fresh client per linking attempt: servers forget
 * clients; a simulator shouldn't care), else ask for a client_id.
 */
async function clientIdFor(d: Discovery): Promise<string> {
  const preset = new URLSearchParams(location.search).get('client_id');
  if (preset) return preset;
  if (d.asMeta.registration_endpoint) {
    const r = await fetch(d.asMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Countertop (Alexa+-style simulator)',
        redirect_uris: [redirectUri()],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    if (r.ok) return (await r.json()).client_id as string;
  }
  return prompt('This server has no dynamic client registration. Enter a client_id registered for ' + redirectUri()) ?? '';
}

export async function link(d: Discovery): Promise<Tokens> {
  if (!d.asMeta || !d.prm) throw new Error('Discovery incomplete');
  const clientId = await clientIdFor(d);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const url = new URL(d.asMeta.authorization_endpoint);
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource: d.prm.resource,
  };
  if (d.prm.scopes_supported?.length) params.scope = d.prm.scopes_supported.join(' ');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  // If the browser can't open a popup (or opens it in the same tab), the callback page redirects
  // back to Countertop and completeRedirect() finishes the exchange from sessionStorage.
  sessionStorage.setItem(
    'countertop:pending',
    JSON.stringify({ verifier, state, clientId, redirectUri: redirectUri(), tokenEndpoint: d.asMeta.token_endpoint, resource: d.prm.resource }),
  );
  const popup = window.open(url.toString(), 'countertop-link', 'width=480,height=720');
  if (!popup) {
    // Popup blocked: sign in in this tab instead. The callback comes back here and completeRedirect() finishes.
    location.assign(url.toString());
    return new Promise<Tokens>(() => {});
  }
  const code = await new Promise<string>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== 'countertop-oauth') return;
      window.removeEventListener('message', onMsg);
      if (e.data.error) return reject(new Error(`Linking declined: ${e.data.error}`));
      if (e.data.state !== state) return reject(new Error('OAuth state mismatch'));
      resolve(e.data.code);
    };
    window.addEventListener('message', onMsg);
    const closed = setInterval(() => {
      if (popup?.closed) {
        clearInterval(closed);
        setTimeout(() => reject(new Error('Linking window closed')), 800);
      }
    }, 500);
  });

  sessionStorage.removeItem('countertop:pending');
  return exchange(d.asMeta.token_endpoint, { code, redirectUri: redirectUri(), clientId, verifier, resource: d.prm.resource });
}

async function exchange(tokenEndpoint: string, p: { code: string; redirectUri: string; clientId: string; verifier: string; resource: string }): Promise<Tokens> {
  const r = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: p.resource }),
  });
  const t = await r.json();
  if (!r.ok) throw new Error(`Token exchange failed: ${t.error_description ?? t.error}`);
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000, clientId: p.clientId };
}

/** Finish linking after a same-tab redirect (no popup available). */
export async function completeRedirect(code: string, state: string): Promise<Tokens> {
  const pending = JSON.parse(sessionStorage.getItem('countertop:pending') ?? 'null');
  sessionStorage.removeItem('countertop:pending');
  if (!pending || pending.state !== state) throw new Error('OAuth state mismatch');
  return exchange(pending.tokenEndpoint, { code, ...pending });
}

export async function refresh(d: Discovery, tokens: Tokens): Promise<Tokens> {
  if (!tokens.refreshToken) throw new Error('No refresh token');
  const r = await fetch(d.asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: tokens.clientId }),
  });
  const t = await r.json();
  if (!r.ok) throw new Error(`Refresh failed: ${t.error_description ?? t.error}`);
  return { ...tokens, accessToken: t.access_token, refreshToken: t.refresh_token ?? tokens.refreshToken, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
}
