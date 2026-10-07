/**
 * services/pfx-openssl.js — Fallback de leitura de PKCS#12 via OpenSSL CLI
 * ======================================================================
 * Necessario quando o node-forge nao suporta o algoritmo do PFX
 * (PBES2/AES-256 dos certificados ICP-Brasil recentes).
 *
 * A senha NUNCA vai na linha de comando (usamos env:VAR).
 * O .pfx temporario e gravado com modo 0600 e apagado ao final.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const execFileSync = require('child_process').execFileSync;

function run(args, senha) {
  return execFileSync('openssl', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: Object.assign({}, process.env, { NFE_PFX_PW: String(senha) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function extract(pfxPath, senha, mode, legacy) {
  const args = ['pkcs12', '-in', pfxPath, '-passin', 'env:NFE_PFX_PW'];
  if (mode === 'key') args.push('-nocerts', '-nodes');
  if (mode === 'leaf') args.push('-clcerts', '-nokeys');
  if (mode === 'ca') args.push('-cacerts', '-nokeys');
  if (legacy) args.push('-legacy');
  return run(args, senha);
}

function pemBlocks(text, tag) {
  const re = new RegExp('-----BEGIN ' + tag + '-----[\\s\\S]*?-----END ' + tag + '-----', 'g');
  return String(text || '').match(re) || [];
}

function normalizeKey(pem) {
  return pemBlocks(pem, 'PRIVATE KEY')[0]
    || pemBlocks(pem, 'RSA PRIVATE KEY')[0]
    || pemBlocks(pem, 'ENCRYPTED PRIVATE KEY')[0]
    || '';
}

function openPfxWithOpenssl(pfxBuffer, senha) {
  const tmp = path.join(os.tmpdir(), 'nfse-' + crypto.randomBytes(8).toString('hex') + '.pfx');
  fs.writeFileSync(tmp, pfxBuffer, { mode: 0o600 });
  try {
    let lastErr = null;
    // 3 modos: moderno -> legacy -> legacy com RC2 desativado
    // (alguns PFX ICP-Brasil precisam de -legacy para algoritmos RC2/3DES)
    const modos = [
      { legacy: false, desc: 'moderno' },
      { legacy: true,  desc: 'legacy' },
    ];
    for (let i = 0; i < modos.length; i++) {
      try {
        const keyPem = normalizeKey(extract(tmp, senha, 'key', modos[i].legacy));
        const leafOut = extract(tmp, senha, 'leaf', modos[i].legacy);
        let certPem = pemBlocks(leafOut, 'CERTIFICATE')[0];
        let chain = [];
        try { chain = pemBlocks(extract(tmp, senha, 'ca', modos[i].legacy), 'CERTIFICATE'); } catch (e) { chain = []; }
        if (!certPem) certPem = chain[0];
        if (!keyPem) throw new Error('Chave privada nao encontrada no arquivo .pfx.');
        if (!certPem) throw new Error('Certificado nao encontrado no arquivo .pfx.');
        const chainPem = [certPem].concat(chain.filter(function (c) { return c !== certPem; }));
        return { privateKeyPem: keyPem, certPem: certPem + '\n', chainPem: chainPem, legacy: modos[i].legacy };
      } catch (e) {
        lastErr = e;
        // NAO aborta aqui - tenta proximo modo.
        // So vamos declarar "senha incorreta" depois de tentar TODOS os modos.
      }
    }
    // Tentou todos os modos e nenhum funcionou. Verifica se foi senha errada.
    const allErrors = String((lastErr && lastErr.stderr) || (lastErr && lastErr.message) || '');
    if (/mac verify failure|invalid password|wrong password|MAC data invalid but no salt/i.test(allErrors)) {
      throw new Error('Senha do certificado incorreta (OpenSSL testou modos moderno e legacy).');
    }
    if (/ENOENT|not found|not recognized/i.test(allErrors)) {
      throw new Error('OpenSSL nao disponivel no servidor: ' + allErrors.split('\n').slice(-2).join(' '));
    }
    throw new Error('Falha ao abrir o certificado com OpenSSL (modos tentados: moderno, legacy): ' +
                    allErrors.split('\n').slice(-3).join(' '));
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
}

module.exports = { openPfxWithOpenssl };
