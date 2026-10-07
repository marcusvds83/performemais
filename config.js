/**
 * config.js — Configuracoes do middleware NFS-e/NF-e Performe+ (SPED NFS-e + NF-e SEFAZ)
 * ============================================================================
 * Fork do projeto accel-nfse, adaptado para o cliente Performe+ (venda de cursos).
 * Deploy multi-ambiente: Render (producao), Vercel (staging/backup), localhost (dev).
 * Cofre: Firebase (Firestore via REST API, sem gRPC).
 *
 * Todas as configuracoes sao lidas de variaveis de ambiente.
 *  - Render: defina em Settings > Environment
 *  - Vercel: defina em Settings > Environment Variables
 *
 * Deteccao automatica de ambiente:
 *  - RENDER=true ou RENDER_EXTERNAL_URL presente -> ambiente Render (long-running)
 *  - VERCEL=true ou VERCEL_URL presente -> ambiente Vercel (serverless)
 *  - Caso contrario -> localhost/dev
 */

// === Deteccao de ambiente ===
const IS_RENDER = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
const IS_VERCEL = !!(process.env.VERCEL || process.env.VERCEL_URL);
const AMBIENTE = IS_RENDER ? 'render' : (IS_VERCEL ? 'vercel' : 'local');

module.exports = {
  // === Servidor ===
  port: parseInt(process.env.PORT || '3000', 10),
  apiKey: process.env.API_KEY || '',
  ambiente: AMBIENTE,
  is_render: IS_RENDER,
  is_vercel: IS_VERCEL,

  // === URL publica do middleware (para auto-chamadas como baixarPdfDoPainel) ===
  // Render: RENDER_EXTERNAL_URL (ex: https://performemais.onrender.com)
  // Vercel: VERCEL_URL (ex: https://performemais.vercel.app)
  // Local: http://localhost:PORT
  public_url: (process.env.RENDER_EXTERNAL_URL || process.env.VERCEL_URL || '').replace(/\/+$/, ''),

  // === Firebase (cofre do certificado A1) ===
  firebase: {
    project_id: process.env.FIREBASE_PROJECT_ID || '',
    private_key: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL || '',
    collection: process.env.FIREBASE_CERT_COLLECTION || 'certificados',
    doc_id: process.env.FIREBASE_CERT_DOC_ID || 'performe-a1',
  },

  // === NFS-e SPED ===
  nfse: {
    uf: process.env.NFSE_UF || 'PR',
    cidade: process.env.NFSE_CIDADE || 'Curitiba',
    codigo_ibge: process.env.NFSE_CODIGO_IBGE || '4106902',
    tp_amb: parseInt(process.env.NFSE_TP_AMB || '2', 10), // 1=producao, 2=homologacao
    // Serie: NFS-e Nacional
    // Faixa 1-49999 = serie propria municipal; 50000+ = serie nacional
    // PJAM (Performe+) usa serie 11111 (municipal em Curitiba - confirmado pela ultima NF emitida)
    serie: (() => {
      const raw = process.env.NFSE_SERIE;
      // Se NFSE_SERIE nao definida OU vazia OU "0", usa default 11111
      if (!raw || raw === '0' || raw === '00000' || parseInt(raw, 10) <= 0) {
        return '11111';
      }
      return String(raw).trim();
    })(),
    versao: process.env.NFSE_VERSAO || '1.01',
    ver_aplic: process.env.NFSE_VER_APLIC || 'performemais_1.0.0',
    inscricao_municipal: process.env.NFSE_IM || '',
    // Regime tributario (Simples Nacional)
    op_simp_nac: parseInt(process.env.NFSE_OP_SIMP_NAC || '3', 10), // 3=Simples Nacional
    reg_ap_trib_sn: parseInt(process.env.NFSE_REG_AP_TRIB_SN || '1', 10),
    reg_esp_trib: parseInt(process.env.NFSE_REG_ESP_TRIB || '0', 10),
    // Codigo de servico padrao (LC 116 / NBS) - PJAM em Curitiba
    // Confirmado pela ultima NF emitida (data 07/10/2026):
    //   c_trib_nac = 170201 (Datilografia, digitacao, estenografia)
    //   c_nbs      = 118065900 (codigo municipal Curitiba)
    c_trib_nac_padrao: process.env.NFSE_C_TRIB_NAC || '170201',
    c_nbs_padrao: process.env.NFSE_C_NBS || '118065900',
    // Aliquota ISS
    aliquota_iss: parseFloat(process.env.NFSE_ALIQUOTA_ISS || '5.00'),
    // Carga tributaria total SN
    p_tot_trib_sn: parseFloat(process.env.NFSE_P_TOT_TRIB_SN || '6.00'),
  },

  // === Odoo (autenticacao via email + API Key) ===
  odoo: {
    enabled: process.env.ODOO_ENABLED === '1',
    url: process.env.ODOO_URL || '',
    db: process.env.ODOO_DB || '',
    user: process.env.ODOO_USER || '', // email de login
    api_key: process.env.ODOO_API_KEY || '',
    polling_interval_ms: parseInt(process.env.ODOO_POLLING_MS || '30000', 10), // 30s default (Render)
    // Deteccao automatica de cron_mode:
    //   - Render (long-running): setInterval persiste -> cron_mode=false (default)
    //   - Vercel (serverless): setInterval NAO persiste -> cron_mode=true (default)
    //   - Local/dev: setInterval funciona -> cron_mode=false (default)
    // Override manual: setar ODOO_CRON_MODE=1 para forcar cron HTTP externo
    cron_mode: (() => {
      if (process.env.ODOO_CRON_MODE !== undefined) {
        return process.env.ODOO_CRON_MODE === '1';
      }
      // Default automatico
      return IS_VERCEL && !IS_RENDER; // Vercel -> cron HTTP; Render/local -> setInterval
    })(),
  },

  // === API REST SEFIN NFS-e (desde 01/10/2025 — substituiu SOAP) ===
  // Homologacao (Producao Restrita): https://sefin.producaorestrita.nfse.gov.br/SefinNacional/
  // Producao: https://sefin.nfse.gov.br/SefinNacional/
  // Formato: JSON com XML DPS compactado em GZip+Base64, mTLS
  sefin: {
    homologacao: process.env.SEFIN_HOM_URL || 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    producao: process.env.SEFIN_PROD_URL || 'https://sefin.nfse.gov.br/SefinNacional',
  },

  // === Seguranca ===
  tls_insecure: process.env.NFSE_TLS_INSECURE === '1',
  status_on_error: process.env.NFSE_STATUS_ON_ERROR || 'erro',
};
