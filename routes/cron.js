/**
 * routes/cron.js — Endpoint de Cron para Vercel
 * ===============================================
 * Vercel Serverless Functions NAO persistem setInterval entre invocacoes.
 * Para manter o polling de emissões pendentes rodando, usamos o Cron do Vercel
 * (configurado em vercel.json) que chama este endpoint a cada minuto.
 *
 * Endpoints:
 *   GET  /api/cron/process-pending  — Dispara processPendingEmissions()
 *
 * Seguranca:
 *   - Se CRON_SECRET estiver definido, exige header x-cron-secret
 *   - Senao, libera (mas loga warning recomendando configurar CRON_SECRET)
 *   - Vercel envia automaticamente o header x-vercel-cron com o nome do cron
 */

const express = require('express');
const router = express.Router();
const { processPendingEmissions } = require('../services/nfse-odoo-emit');

function cronAuth(req, res, next) {
  const expected = process.env.CRON_SECRET;
  // Header que o Vercel Cron envia automaticamente
  const vercelCron = req.headers['x-vercel-cron'];
  // Header de segredo customizado (opcional, recomendado)
  const provided = req.headers['x-cron-secret'];

  if (expected) {
    if (provided !== expected) {
      console.warn('[CRON] Rejeitado: x-cron-secret invalido');
      return res.status(401).json({ erro: 'Cron secret invalido' });
    }
  } else {
    // Sem CRON_SECRET configurado: exige header x-vercel-cron (protege contra acesso publico)
    if (!vercelCron) {
      console.warn('[CRON] Rejeitado: requisicao sem x-vercel-cron. Configure CRON_SECRET ou rode via Vercel Cron.');
      return res.status(401).json({ erro: 'Requisicao nao autorizada (defina CRON_SECRET ou rode via Vercel Cron)' });
    }
  }
  next();
}

// === Dispara polling de pendentes ===
router.get('/process-pending', cronAuth, async (req, res) => {
  const t0 = Date.now();
  console.log('[CRON] process-pending iniciado em ' + new Date().toISOString());
  try {
    const resultado = await processPendingEmissions();
    const duracao = Date.now() - t0;
    console.log('[CRON] process-pending concluido em ' + duracao + 'ms | processadas=' + (resultado.processed || 0));
    res.json({
      sucesso: true,
      duracao_ms: duracao,
      processadas: resultado.processed || 0,
      detalhes: resultado.detalhes || [],
      motivo: resultado.reason || null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[CRON] Erro:', err.message);
    res.status(500).json({
      sucesso: false,
      erro: err.message,
      duracao_ms: Date.now() - t0,
    });
  }
});

// === Health do cron (ping simples para testar) ===
router.get('/health', cronAuth, (req, res) => {
  res.json({
    ok: true,
    servico: 'performe-nfse-cron',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
