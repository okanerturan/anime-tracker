// Passkey (WebAuthn) helpers shared by the sign-in and account pages. The server sends options as
// JSON with base64url fields; the browser API wants bytes, and the answer goes back as base64url.
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** POST JSON to an auth endpoint; throws the server's message. */
export async function authPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tracker-Client': 'app' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Something went wrong (${r.status}).`), { status: r.status, body: j });
  return j;
}

/** Create a passkey from registration options. */
export async function makePasskey(o) {
  const c = await navigator.credentials.create({ publicKey: { ...o, challenge: unb64(o.challenge), user: { ...o.user, id: unb64(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((x) => ({ ...x, id: unb64(x.id) })) } });
  return { id: c.id, rawId: b64(c.rawId), type: c.type, clientExtensionResults: {}, response: { clientDataJSON: b64(c.response.clientDataJSON), attestationObject: b64(c.response.attestationObject), transports: c.response.getTransports?.() || [] } };
}

/** Use a passkey for authentication options (any passkey for this site). */
export async function usePasskey(o) {
  const c = await navigator.credentials.get({ publicKey: { ...o, challenge: unb64(o.challenge), allowCredentials: [] } });
  return { id: c.id, rawId: b64(c.rawId), type: c.type, clientExtensionResults: {}, response: { clientDataJSON: b64(c.response.clientDataJSON), authenticatorData: b64(c.response.authenticatorData), signature: b64(c.response.signature), userHandle: c.response.userHandle ? b64(c.response.userHandle) : undefined } };
}

/** A dismissed browser prompt is not an error worth alarming anyone about. */
export const cancelled = (err) => err?.name === 'NotAllowedError' || err?.name === 'AbortError';

/** Recovery codes as a downloadable text file. */
export const codesFile = (codes) => URL.createObjectURL(new Blob([`Anime Tracker recovery codes\n${location.host}\n\n${codes.join('\n')}\n`], { type: 'text/plain' }));
