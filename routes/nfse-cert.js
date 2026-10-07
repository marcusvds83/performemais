/**
 * routes/nfse-cert.js — Rotas de gerenciamento do certificado A1
 * =================================================================
 * Upload, status e remocao do certificado via Firebase.
 * Todas as rotas exigem o header x-api-key.
 */

const express = require('express');
const router = express.Router();
const { salvarCertificado, carregarCertificado, statusCertificado, removerCertificado } = require('../services/firebase-cert');

// === Autenticacao ===
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ erro: 'API key invalida' });
  }
  next();
}

// === Upload do certificado ===
router.post('/', apiKeyAuth, async (req, res) => {
  try {
    const { pfxBase64, senha } = req.body;
    if (!pfxBase64) return res.status(400).json({ erro: 'pfxBase64 obrigatorio' });
    if (!senha) return res.status(400).json({ erro: 'senha obrigatoria' });

    // Limpa whitespace/newlines que podem vir no base64
    const b64clean = String(pfxBase64).replace(/\s+/g, '');
    const pfx = Buffer.from(b64clean, 'base64');

    // Validacoes do buffer antes de chamar OpenSSL
    if (pfx.length < 100) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Arquivo .pfx muito pequeno (' + pfx.length + ' bytes). Verifique se o upload foi concluido.',
      });
    }
    // PKCS12 valido comeca com 0x30 (SEQUENCE) e segundo byte geralmente 0x82 ou 0x83 (long form length)
    if (pfx[0] !== 0x30) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Arquivo nao parece ser um PKCS12 valido (primeiro byte: 0x' + pfx[0].toString(16) + ', esperado 0x30). ' +
              'Verifique se o arquivo .pfx nao esta corrompido e se foi enviado como binario (nao texto).',
      });
    }

    const info = await salvarCertificado(pfx, senha);
    res.json({ sucesso: true, info });
  } catch (err) {
    console.error('[CERT] Erro ao salvar:', err.message);
    res.status(400).json({ sucesso: false, erro: err.message });
  }
});

// === Status do certificado ===
router.get('/', apiKeyAuth, async (req, res) => {
  try {
    const status = await statusCertificado();
    res.json(status);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// === Remover certificado ===
router.delete('/', apiKeyAuth, async (req, res) => {
  try {
    await removerCertificado();
    res.json({ sucesso: true, mensagem: 'Certificado removido do Firebase.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// === Testar conexao com prefeitura (usa o certificado) ===
router.get('/prefeitura/status', apiKeyAuth, async (req, res) => {
  try {
    const cert = await carregarCertificado();
    if (!cert) return res.status(400).json({ erro: 'Nenhum certificado carregado.' });
    const { testarConexao } = require('../services/nfse-client');
    const resultado = await testarConexao(cert);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// === Upload da logo Performe+ para o Firebase ===
// Persiste a logo entre deploys do Vercel.
// Body: { logoBase64: '<base64 do PNG>' }
router.post('/logo', apiKeyAuth, async (req, res) => {
  try {
    const { logoBase64 } = req.body;
    if (!logoBase64) return res.status(400).json({ erro: 'logoBase64 obrigatorio' });

    // Valida que e uma imagem valida
    const buf = Buffer.from(logoBase64, 'base64');
    if (buf.length < 100) return res.status(400).json({ erro: 'Logo muito pequena' });

    // Usa Firestore REST API (sem firebase-admin SDK, sem gRPC)
    const config = require('../config');
    const fbRest = require('../services/firebase-rest');
    await fbRest.setDoc(config.firebase.collection, 'logo', {
      logoBase64: logoBase64,
      tamanho: buf.length,
      uploadEm: new Date().toISOString(),
    });

    // Invalida cache da logo no nfse-pdf.js
    try {
      const nfsePdf = require('../services/nfse-pdf');
      if (nfsePdf.resetLogoCache) nfsePdf.resetLogoCache();
    } catch (_) { /* ignore */ }

    console.log('[CERT-LOGO] Logo salva no Firebase: ' + buf.length + ' bytes');
    res.json({ sucesso: true, tamanho: buf.length, mensagem: 'Logo salva no Firebase.' });
  } catch (err) {
    console.error('[CERT-LOGO] Erro:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// === Testar conexao Firebase ===
router.get('/firebase/test', apiKeyAuth, async (req, res) => {
  try {
    const fbRest = require('../services/firebase-rest');
    const result = await fbRest.testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
});

module.exports = router;
