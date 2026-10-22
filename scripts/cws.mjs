#!/usr/bin/env node
// Chrome Web Store v2 API: upload the extension zip and submit it for review, signed in as a Google
// service account (a JWT signed with Node's crypto, no Google libraries). Ported from the Loqalit
// release tooling. Env: CWS_SA_KEY (the key JSON) or CWS_SA_KEY_FILE, CWS_PUBLISHER_ID,
// CWS_EXTENSION_ID, and CWS_SOURCE_PATH (the zip) for uploads. See docs/PUBLISHING-EXTENSION.md.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_AUDIENCE = 'https://oauth2.googleapis.com/token';
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const API_BASE = 'https://chromewebstore.googleapis.com/v2';
const UPLOAD_BASE = 'https://chromewebstore.googleapis.com/upload/v2';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let encoded = buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_');
  while (encoded.endsWith('=')) {
    encoded = encoded.slice(0, -1);
  }
  return encoded;
}

function getEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : null;
}

function getRequiredEnv(name) {
  const value = getEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function getPublisherId() {
  return getRequiredEnv('CWS_PUBLISHER_ID');
}

function getServiceAccount() {
  const inline = getEnv('CWS_SA_KEY');
  if (inline) {
    return JSON.parse(inline);
  }

  const filePath = getEnv('CWS_SA_KEY_FILE');
  if (filePath) {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  }

  throw new Error('Missing CWS_SA_KEY or CWS_SA_KEY_FILE');
}

async function getAccessToken() {
  const serviceAccount = getServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    scope: TOKEN_SCOPE,
    aud: TOKEN_AUDIENCE,
    exp: now + 3600,
    iat: now,
  };

  const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(serviceAccount.private_key);
  const assertion = `${unsignedToken}.${base64UrlEncode(signature)}`;

  const response = await fetch(TOKEN_AUDIENCE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const payloadJson = await response.json();
  if (!response.ok) {
    throw new Error(`Failed to fetch CWS access token: ${JSON.stringify(payloadJson)}`);
  }

  if (!payloadJson.access_token) {
    throw new Error('CWS access token response missing access_token');
  }

  return payloadJson.access_token;
}

function getResourceName() {
  const publisherId = getPublisherId();
  const extensionId = getRequiredEnv('CWS_EXTENSION_ID');
  return `publishers/${publisherId}/items/${extensionId}`;
}

function logPayload(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function getUploadErrors(payload) {
  return payload?.itemError ?? payload?.itemErrors ?? [];
}

function assertNoUploadErrors(payload) {
  const errors = getUploadErrors(payload);
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`CWS upload returned errors: ${JSON.stringify(errors)}`);
  }
}

function assertUploadState(payload, allowedStates) {
  const state = payload?.uploadState ?? payload?.lastAsyncUploadState ?? 'UNKNOWN';
  if (!allowedStates.includes(state)) {
    throw new Error(`Unexpected CWS upload state ${state}: ${JSON.stringify(payload)}`);
  }
}

async function cwsRequest(path, { method = 'GET', body, headers = {} } = {}) {
  const accessToken = await getAccessToken();
  const response = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...headers,
    },
    body,
  });

  const responseText = await response.text();
  let payload = null;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    payload = responseText;
  }

  if (!response.ok) {
    throw new Error(
      `CWS request failed (${response.status}): ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`
    );
  }

  return payload;
}

async function uploadPackage() {
  const zipPath = getRequiredEnv('CWS_SOURCE_PATH');
  const resourceName = getResourceName();
  const fileBuffer = readFileSync(zipPath);

  return cwsRequest(`${UPLOAD_BASE}/${resourceName}:upload`, {
    method: 'POST',
    body: fileBuffer,
    headers: {
      'Content-Type': 'application/zip',
    },
  });
}

async function fetchStatus() {
  const resourceName = getResourceName();
  return cwsRequest(`${API_BASE}/${resourceName}:fetchStatus`);
}

async function publishItem() {
  const resourceName = getResourceName();
  return cwsRequest(`${API_BASE}/${resourceName}:publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
}

function getAsyncUploadState(statusPayload) {
  return statusPayload?.lastAsyncUploadState ?? null;
}

async function waitForUploadCompletion() {
  const timeoutMs =
    Number.parseInt(getEnv('CWS_POLL_TIMEOUT_MS') ?? '', 10) || DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs =
    Number.parseInt(getEnv('CWS_POLL_INTERVAL_MS') ?? '', 10) || DEFAULT_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  while (true) {
    const statusPayload = await fetchStatus();
    const uploadState = getAsyncUploadState(statusPayload);
    logPayload(statusPayload);
    assertNoUploadErrors(statusPayload);

    if (uploadState !== 'UPLOAD_IN_PROGRESS') {
      assertUploadState(statusPayload, ['UPLOAD_SUCCESS', 'SUCCEEDED']);
      return statusPayload;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for upload completion after ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function uploadAndMaybeWait() {
  const uploadPayload = await uploadPackage();
  logPayload(uploadPayload);
  assertNoUploadErrors(uploadPayload);

  if (uploadPayload?.uploadState === 'UPLOAD_IN_PROGRESS') {
    return waitForUploadCompletion();
  }

  assertUploadState(uploadPayload, ['SUCCESS', 'SUCCEEDED']);
  return uploadPayload;
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'upload': {
      const payload = await uploadAndMaybeWait();
      logPayload(payload);
      return;
    }
    case 'fetch-status': {
      const payload = await fetchStatus();
      logPayload(payload);
      return;
    }
    case 'publish': {
      const payload = await publishItem();
      logPayload(payload);
      return;
    }
    case 'upload-and-publish': {
      await uploadAndMaybeWait();
      const payload = await publishItem();
      logPayload(payload);
      return;
    }
    default:
      throw new Error(
        'Usage: node scripts/cws.mjs <upload|fetch-status|publish|upload-and-publish>'
      );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
