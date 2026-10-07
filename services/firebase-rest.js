/**
 * services/firebase-rest.js — Cliente Firestore via REST API (sem gRPC)
 * ====================================================================
 * Evita o erro OpenSSL "1E08010C:DECODER routines::unsupported" que acontece
 * no firebase-admin SDK via gRPC em alguns ambientes (Render free tier).
 *
 * Usa a REST API oficial do Firestore:
 *   https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents/...
 *
 * Autenticacao: OAuth2 Bearer token obtido via JWT assinado com a private key
 * do service account (Google OAuth2 JWT flow - 1 hora de validade).
 */

const crypto = require('crypto');
const https = require('https');
const config = require('../config');
// node-forge: biblioteca JS pura para assinar JWT sem depender do OpenSSL do Node
// (evita erro 1E08010C:DECODER routines::unsupported em OpenSSL 3.x sem provider legacy)
const forge = require('node-forge');

let cachedToken = null;  // { token, expiresAt }

// === JWT para OAuth2 do Google ===
function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Assina o signInput com a private key do service account usando node-forge.
 * node-forge e JavaScript puro, nao depende do OpenSSL do sistema.
 * Retorna a signature em base64url.
 */
function signJwtWithForge(signInput, privateKeyPem) {
  // Limpa a private key (remove aspas extras e converte \n literal)
  let pk = privateKeyPem;
  if (typeof pk === 'string') {
    pk = pk.replace(/\\n/g, '\n').replace(/^"|"$/g, '');
  }
  // Converte PEM para objeto private key do forge
  const forgePrivateKey = forge.pki.privateKeyFromPem(pk);
  // Cria message digest SHA-256 do signInput
  const md = forge.md.sha256.create();
  md.update(signInput, 'utf8');
  // Assina com PKCS#1 v1.5 (padrao RS256)
  const signatureBytes = forgePrivateKey.sign(md);
  // Converte para base64
  const signatureB64 = forge.util.encode64(signatureBytes);
  // Converte para base64url
  return signatureB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return Promise.resolve(cachedToken.token);
  }

  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: config.firebase.client_email,
      scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const header = { alg: 'RS256', typ: 'JWT' };
    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const signInput = encodedHeader + '.' + encodedPayload;

    // Assina com node-forge (JavaScript puro, sem OpenSSL)
    let signature;
    try {
      signature = signJwtWithForge(signInput, config.firebase.private_key);
    } catch (e) {
      reject(new Error('Falha ao assinar JWT com node-forge: ' + e.message));
      return;
    }
    const jwt = signInput + '.' + signature;

    const postData = 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt);
    const reqOpts = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            cachedToken = {
              token: parsed.access_token,
              expiresAt: Date.now() + (parsed.expires_in || 3600) * 1000,
            };
            resolve(parsed.access_token);
          } else {
            reject(new Error('OAuth2 falhou: ' + (parsed.error_description || parsed.error || data)));
          }
        } catch (e) {
          reject(new Error('Resposta OAuth2 invalida: ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// === Helpers Firestore REST API ===
// Documento Firestore no formato REST tem fields com tipo wrapper:
//   { stringValue: "..." } | { integerValue: "123" } | { bytesValue: "<base64>" } | { booleanValue: true } ...

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Buffer.isBuffer(value)) return { bytesValue: value.toString('base64') };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  // Strings e objetos viram string (usamos JSON para objetos complexos)
  if (typeof value === 'object') return { stringValue: JSON.stringify(value) };
  return { stringValue: String(value) };
}

function fromFirestoreValue(field) {
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return parseInt(field.integerValue, 10);
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.bytesValue !== undefined) return Buffer.from(field.bytesValue, 'base64');
  if (field.timestampValue !== undefined) return new Date(field.timestampValue);
  if (field.nullValue !== undefined) return null;
  if (field.mapValue) {
    const obj = {};
    for (const k in field.mapValue.fields) {
      obj[k] = fromFirestoreValue(field.mapValue.fields[k]);
    }
    return obj;
  }
  return null;
}

function docPath(collection, docId) {
  const project = config.firebase.project_id;
  return `/v1/projects/${project}/databases/(default)/documents/${collection}/${docId}`;
}

// === Operacoes CRUD ===

async function getDoc(collection, docId) {
  const token = await getAccessToken();
  const path = docPath(collection, docId);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: path,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) {
          resolve(null);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('Firestore GET falhou (' + res.statusCode + '): ' + data));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (!parsed.fields) {
            resolve({});
            return;
          }
          const result = {};
          for (const k in parsed.fields) {
            result[k] = fromFirestoreValue(parsed.fields[k]);
          }
          resolve(result);
        } catch (e) {
          reject(new Error('JSON invalido do Firestore: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function setDoc(collection, docId, data) {
  const token = await getAccessToken();
  const path = docPath(collection, docId);

  const fields = {};
  for (const k in data) {
    fields[k] = toFirestoreValue(data[k]);
  }

  const postData = JSON.stringify({ fields: fields });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: path,  // PATCH cria/atualiza documento inteiro
      method: 'PATCH',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200 && res.statusCode !== 201) {
          reject(new Error('Firestore PATCH falhou (' + res.statusCode + '): ' + data));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const result = {};
          if (parsed.fields) {
            for (const k in parsed.fields) {
              result[k] = fromFirestoreValue(parsed.fields[k]);
            }
          }
          resolve(result);
        } catch (e) {
          resolve({});
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function deleteDoc(collection, docId) {
  const token = await getAccessToken();
  const path = docPath(collection, docId);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: path,
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200 && res.statusCode !== 404) {
          reject(new Error('Firestore DELETE falhou (' + res.statusCode + '): ' + data));
          return;
        }
        resolve(true);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// === Teste de conexao (escreve um doc de teste e apaga) ===
async function testConnection() {
  try {
    const testId = '__test_' + Date.now();
    await setDoc(config.firebase.collection, testId, {
      ping: 'pong',
      timestamp: new Date().toISOString(),
    });
    const read = await getDoc(config.firebase.collection, testId);
    await deleteDoc(config.firebase.collection, testId);
    return {
      ok: true,
      project: config.firebase.project_id,
      collection: config.firebase.collection,
      wroteAndRead: read && read.ping === 'pong',
    };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

module.exports = {
  getDoc,
  setDoc,
  deleteDoc,
  testConnection,
  getAccessToken,
};
