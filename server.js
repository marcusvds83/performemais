/**
 * server.js — Servidor Express do middleware NFS-e/NF-e Performe+
 * ==============================================================
 * Performe+ (cursos) | SPED NFS-e v1.01 | NF-e SEFAZ | Certificado A1 | Firebase (cofre)
 * Deploy: Render (producao, free, long-running + pinger externo)
 *         Vercel (alternativo, serverless + cron HTTP externo)
 *         localhost (dev)
 *
 * Rotas:
 *   GET  /                                        — Painel Dashboard (SPA)
 *   GET  /health                                  — Health check
 *   POST /api/v1/nfse/certificado                — Upload do certificado A1
 *   GET  /api/v1/nfse/certificado                — Status do certificado
 *   DELETE /api/v1/nfse/certificado              — Remover certificado
 *   GET  /api/v1/nfse/prefeitura/status          — Status webservice prefeitura
 *   POST /api/v1/nfse/emitir                     — Emitir NFS-e (por move_id Odoo)
 *   POST /api/v1/nfse/cancelar                   — Cancelar NFS-e
 *   POST /api/v1/nfse/process-pending           — Processar emissões pendentes (manual)
 *   GET  /api/v1/nfse/dashboard                  — Dados do painel BI
 *   GET  /api/v1/nfse/dashboard/cert-status     — Status do certificado
 *   GET  /api/v1/nfse/dashboard/sefin-status    — Status conexao SEFIN
 *   GET  /api/v1/nfse/dashboard/:id/xml         — Download XML
 *   GET  /api/v1/nfse/dashboard/:id/pdf         — Download PDF DANFSe
 *   GET  /api/v1/nfse/dashboard/:id/consultar   — Consulta NFS-e na SEFIN
 *   GET  /api/cron/process-pending              — Cron HTTP (Vercel Cron, cron-job.org, GitHub Actions)
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');

const path = require('path');
const certRoutes = require('./routes/nfse-cert');
const nfseRoutes = require('./routes/nfse');
const dashboardRoutes = require('./routes/dashboard');
const adminToolsRoutes = require('./routes/admin-tools');
const cronRoutes = require('./routes/cron');
const { processPendingEmissions } = require('./services/nfse-odoo-emit');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// === Serve frontend estatico ===
app.use(express.static(path.join(__dirname, 'public')));

// === Health Check ===
app.get('/health', (req, res) => {
  res.json({
    servico: 'nfse-performe',
    versao: '1.0.0',
    ambiente: config.ambiente, // render | vercel | local
    cidade: config.nfse.cidade,
    uf: config.nfse.uf,
    tp_amb: config.nfse.tp_amb,
    serie: config.nfse.serie,
    c_trib_nac: config.nfse.c_trib_nac_padrao,
    c_nbs: config.nfse.c_nbs_padrao,
    aliquota_iss: config.nfse.aliquota_iss,
    incluir_im: process.env.NFSE_INCLUIR_IM === '1',
    odoo: config.odoo.enabled,
    firebase_configurado: !!(config.firebase.project_id && config.firebase.client_email),
    public_url: config.public_url || '(local)',
    polling_ativo: !config.odoo.cron_mode,
    polling_interval_ms: config.odoo.polling_interval_ms,
    timestamp: new Date().toISOString(),
  });
});

// === Rotas da API ===
app.use('/api/v1/nfse/certificado', certRoutes);
app.use('/api/v1/nfse', nfseRoutes);
app.use('/api/v1/nfse', dashboardRoutes);
app.use('/api/v1/nfse', adminToolsRoutes);
app.use('/api/cron', cronRoutes);

// === Polling de emissões pendentes ===
// - Render (long-running): setInterval persiste enquanto o processo estiver vivo.
//   Render free dorme apos 15 min sem incoming HTTP. Use pinger externo
//   (cron-job.org) batendo no /health a cada 5 min para manter acordado.
// - Vercel (serverless): setInterval NAO persiste. Use cron HTTP externo
//   (Vercel Cron Pro, cron-job.org, GitHub Actions) chamando /api/cron/process-pending.
// - localhost/dev: setInterval funciona normalmente.
let pollingTimer = null;

function startPolling() {
  if (!config.odoo.enabled || pollingTimer) return;
  if (config.odoo.cron_mode) {
    console.log('[POLLING] Modo cron HTTP ativado (setInterval desativado).');
    console.log('[POLLING] Configure um pinger/cron externo chamando:');
    console.log('[POLLING]   GET ' + (config.public_url || '<public_url>') + '/api/cron/process-pending');
    console.log('[POLLING]   com header: x-cron-secret: <CRON_SECRET>');
    console.log('[POLLING] Opcoes: Vercel Cron, GitHub Actions, cron-job.org');
    return;
  }
  const interval = config.odoo.polling_interval_ms;
  console.log('[POLLING] Modo setInterval ativado (ambiente: ' + config.ambiente + ')');
  console.log('[POLLING] Iniciando polling a cada ' + interval + 'ms (' + (interval/1000) + 's)...');
  pollingTimer = setInterval(async () => {
    try {
      await processPendingEmissions();
    } catch (err) {
      console.error('[POLLING] Erro:', err.message);
    }
  }, interval);
}

// === 404 (apenas para API) ===
app.use('/api', (req, res) => {
  res.status(404).json({ erro: 'Rota nao encontrada' });
});

// === 404 para demais rotas — fallback para index.html (SPA) ===
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === Erro global ===
app.use((err, req, res, _next) => {
  console.error('[ERRO]', err.message);
  res.status(500).json({ erro: err.message });
});

// === Inicializar ===
// Render e localhost: sobem o servidor Express normalmente (long-running).
// Vercel: o handler exportado abaixo e usado; o listen nao roda em serverless.
const isServerless = process.env.VERCEL && !process.env.RENDER;
if (!isServerless) {
  app.listen(config.port, () => {
    console.log('=== NFS-e/NF-e Performe+ Middleware ===');
    console.log('Ambiente: ' + config.ambiente.toUpperCase());
    console.log('Porta: ' + config.port);
    console.log('Cidade: ' + config.nfse.cidade + '/' + config.nfse.uf);
    console.log('Tp Amb: ' + config.nfse.tp_amb + ' (' + (config.nfse.tp_amb === 1 ? 'PRODUCAO' : 'HOMOLOGACAO') + ')');
    console.log('Serie: ' + config.nfse.serie + ' (NFSE_SERIE="' + (process.env.NFSE_SERIE || '(vazio)') + '")');
    console.log('C Trib Nac: ' + config.nfse.c_trib_nac_padrao);
    console.log('C NBS: ' + config.nfse.c_nbs_padrao);
    console.log('Aliquota ISS: ' + config.nfse.aliquota_iss + '%');
    console.log('Incluir IM: ' + (process.env.NFSE_INCLUIR_IM === '1' ? 'SIM' : 'NAO'));
    console.log('API SEFIN: ' + (config.nfse.tp_amb === 1 ? config.sefin.producao : config.sefin.homologacao));
    console.log('Firebase: ' + (config.firebase.project_id || 'NAO configurado'));
    console.log('Odoo: ' + (config.odoo.enabled ? config.odoo.url : 'desabilitado'));
    console.log('Public URL: ' + (config.public_url || 'http://localhost:' + config.port));
    console.log('Dashboard: ' + (config.public_url || 'http://localhost:' + config.port));
    console.log('============================================');
    startPolling();
  });
}

// === Export (para Vercel Serverless e testes) ===
module.exports = app;
module.exports.startPolling = startPolling;
