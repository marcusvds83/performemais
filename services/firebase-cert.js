/**
 * services/firebase-cert.js — Cofre do certificado A1 no Firebase
 * ==============================================================
 * Armazena o certificado digital (.pfx em base64) + senha cifrada (AES-256-GCM)
 * no Firestore do Firebase. O certificado e carregado em memoria (cache) e
 * o PEM da chave privada + cadeia sao extraidos via node-forge ou OpenSSL.
 *
 * Fluxo:
 *   1. Certificado e enviado via POST /api/v1/nfse/certificado
 *   2. Senha e cifrada client-side antes de enviar (ou server-side aqui)
 *   3. Armazenado no Firestore (documento unico)
 *   4. Em memoria: cache do PFX + PEM extraido
 *
 * Vantagens do Firebase como cofre:
 *   - Sobrevive deploys/reinicios no Render
 *   - Nao precisa de disco persistente
 *   - Acesso seguro via service account
 *   - Regras de seguranca do Firestore
 */

const crypto = require('crypto');
const forge = require('node-forge');
const config = require('../config');
const openPfxWithOpenssl = require('./pfx-openssl').openPfxWithOpenssl;
// Usa Firestore REST API em vez do firebase-admin SDK (evita erro OpenSSL gRPC)
const fbRest = require('./firebase-rest');

// === Cache em memoria ===
let cache = null;
// { pfx: Buffer, senha: string, privateKeyPem, certPem, chainPem[], info: {...} }

// === Inicializacao do Firebase ===
function initFirebase() {
  // Nao precisa inicializar nada - firebase-rest usa REST API stateless
  if (!config.firebase.project_id || !config.firebase.client_email || !config.firebase.private_key) {
    console.warn('[FIREBASE-CERT] Firebase nao configurado. Defina FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY.');
    return false;
  }
  return true;
}

// === Cifragem da senha (AES-256-GCM) ===
function deriveKey() {
  const base = process.env.NFSE_CERT_KEK || process.env.API_KEY || 'performe-nfse-local-kek';
  return crypto.createHash('sha256').update(String(base)).digest();
}

function encryptSenha(senha) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([c.update(String(senha), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decryptSenha(blob) {
  const buf = Buffer.from(String(blob), 'base64');
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.slice(28)), d.final()]).toString('utf8');
}

// === Extracao de informacoes do certificado ===
function onlyNum(s) { return String(s || '').replace(/\D/g, ''); }

function infoFromCertPem(certPem) {
  const leaf = forge.pki.certificateFromPem(certPem);
  let cn = '';
  try { cn = (leaf.subject.getField('CN') || {}).value || ''; } catch (e) { cn = ''; }
  const cnpj = onlyNum((cn.split(':')[1] || ''));
  return {
    titular: cn.split(':')[0] || cn,
    cnpj: cnpj.length === 14 ? cnpj : (cn.match(/(\d{14})/) || [])[1] || '',
    emissor: (function () { try { return (leaf.issuer.getField('CN') || {}).value || ''; } catch (e) { return ''; } })(),
    validoDe: leaf.validity.notBefore.toISOString(),
    validoAte: leaf.validity.notAfter.toISOString(),
    diasRestantes: Math.floor((leaf.validity.notAfter.getTime() - Date.now()) / 86400000),
    expirado: leaf.validity.notAfter.getTime() < Date.now(),
    serial: leaf.serialNumber,
  };
}

// === Leitura do PFX ===
function openPfxForge(pfxBuffer, senha) {
  const der = forge.util.createBuffer(pfxBuffer.toString('binary'));
  const asn1 = forge.asn1.fromDer(der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, String(senha));
  let keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  if (!keyBags.length) keyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [];
  if (!keyBags.length || !keyBags[0].key) throw new Error('Chave privada nao encontrada no certificado A1.');
  const privateKeyPem = forge.pki.privateKeyToPem(keyBags[0].key);
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!certBags.length) throw new Error('Certificado nao encontrado no arquivo .pfx.');
  let leaf = null;
  const chainPem = [];
  for (let i = 0; i < certBags.length; i++) {
    const c = certBags[i].cert;
    if (!c) continue;
    chainPem.push(forge.pki.certificateToPem(c));
    let isCa = false;
    try { const bc = c.getExtension('basicConstraints'); isCa = !!(bc && bc.cA); } catch (e) { isCa = false; }
    if (!isCa && !leaf) leaf = c;
  }
  if (!leaf) leaf = certBags[0].cert;
  const certPem = forge.pki.certificateToPem(leaf);
  return { privateKeyPem, certPem, chainPem, info: infoFromCertPem(certPem) };
}

function openPfx(pfxBuffer, senha) {
  if (!Buffer.isBuffer(pfxBuffer) || !pfxBuffer.length) throw new Error('Arquivo de certificado invalido.');

  // Tenta node-forge primeiro (rapido, mas nao suporta PFX com AES-256-GCM moderno)
  let forgeError = null;
  try {
    return openPfxForge(pfxBuffer, senha);
  } catch (e) {
    forgeError = e;
    const msg = String((e && e.message) || e);
    console.warn('[FIREBASE-CERT] node-forge falhou (' + msg + '). Tentando OpenSSL...');
  }

  // Fallback OpenSSL (suporta todos os algoritmos, inclusive PBES2/AES-256-GCM dos certificados ICP-Brasil recentes)
  try {
    const viaSsl = openPfxWithOpenssl(pfxBuffer, senha);
    return {
      privateKeyPem: viaSsl.privateKeyPem,
      certPem: viaSsl.certPem,
      chainPem: viaSsl.chainPem,
      info: infoFromCertPem(viaSsl.certPem),
    };
  } catch (e2) {
    const msg2 = String((e2 && e2.message) || e2);
    // So agora, depois de OpenSSL tambem falhar, podemos dizer que a senha esta errada
    if (/mac verify failure|invalid password|wrong password|Senha do certificado incorreta/i.test(msg2)) {
      throw new Error('Senha do certificado incorreta (validada via OpenSSL). Verifique a senha e tente novamente.');
    }
    throw new Error('Falha ao abrir o certificado: ' + msg2);
  }
}

// === CRUD do Firestore ===

/** Salva o certificado no Firebase e carrega em memoria. */
async function salvarCertificado(pfxBuffer, senha) {
  if (!pfxBuffer || !pfxBuffer.length) throw new Error('Arquivo .pfx vazio.');
  if (!senha) throw new Error('Senha do certificado obrigatoria.');
  if (!initFirebase()) throw new Error('Firebase nao configurado. Configure as variaveis de ambiente.');

  // Valida a senha antes de persistir
  const aberto = openPfx(pfxBuffer, senha);

  // Monta documento para o Firestore
  const doc = {
    pfxBase64: pfxBuffer.toString('base64'),
    senhaCifrada: encryptSenha(senha),
    info: JSON.stringify(aberto.info),  // REST API guarda strings; fazemos JSON do objeto info
    uploadEm: new Date().toISOString(),
    atualizadoEm: new Date().toISOString(),
  };

  await fbRest.setDoc(config.firebase.collection, config.firebase.doc_id, doc);

  // Atualiza cache
  cache = {
    pfx: pfxBuffer,
    senha: String(senha),
    privateKeyPem: aberto.privateKeyPem,
    certPem: aberto.certPem,
    chainPem: aberto.chainPem,
    info: aberto.info,
  };

  console.log('[FIREBASE-CERT] Certificado salvo no Firebase. Titular: ' + aberto.info.titular + ' | CNPJ: ' + aberto.info.cnpj);
  return aberto.info;
}

/** Carrega o certificado do Firebase (ou cache em memoria). */
async function carregarCertificado() {
  if (cache) return cache;
  if (!initFirebase()) {
    console.warn('[FIREBASE-CERT] Firebase nao configurado.');
    return null;
  }

  try {
    const doc = await fbRest.getDoc(config.firebase.collection, config.firebase.doc_id);
    if (!doc || !doc.pfxBase64 || !doc.senhaCifrada) {
      console.warn('[FIREBASE-CERT] Nenhum certificado encontrado no Firebase.');
      return null;
    }

    const pfx = Buffer.from(doc.pfxBase64, 'base64');
    const senha = decryptSenha(doc.senhaCifrada);
    const aberto = openPfx(pfx, senha);

    cache = {
      pfx: pfx,
      senha: senha,
      privateKeyPem: aberto.privateKeyPem,
      certPem: aberto.certPem,
      chainPem: aberto.chainPem,
      info: aberto.info,
    };
    console.log('[FIREBASE-CERT] Certificado carregado do Firebase. Titular: ' + aberto.info.titular);
    return cache;
  } catch (e) {
    console.error('[FIREBASE-CERT] Erro ao carregar do Firebase:', e.message);
    return null;
  }
}

/** Retorna o status do certificado (nao carrega o PEM, so as infos). */
async function statusCertificado() {
  if (!initFirebase()) return { configurado: false, erro: 'Firebase nao configurado' };

  // Se tem cache, usa o cache
  if (cache) return Object.assign({ configurado: true, origem: 'cache' }, cache.info);

  try {
    const doc = await fbRest.getDoc(config.firebase.collection, config.firebase.doc_id);
    if (!doc || !doc.info) return { configurado: false, mensagem: 'Nenhum certificado A1 no Firebase.' };
    // info foi salvo como JSON string
    let info = doc.info;
    if (typeof info === 'string') {
      try { info = JSON.parse(info); } catch (e) { info = {}; }
    }
    return Object.assign({ configurado: true, origem: 'firebase', uploadEm: doc.uploadEm }, info);
  } catch (e) {
    return { configurado: false, erro: e.message };
  }
}

/** Remove o certificado do Firebase e do cache. */
async function removerCertificado() {
  if (initFirebase()) {
    try {
      await fbRest.deleteDoc(config.firebase.collection, config.firebase.doc_id);
    } catch (e) { /* ignore */ }
  }
  cache = null;
  console.log('[FIREBASE-CERT] Certificado removido do Firebase e cache.');
  return true;
}

module.exports = { salvarCertificado, carregarCertificado, statusCertificado, removerCertificado, testFirebaseConnection: () => fbRest.testConnection() };
