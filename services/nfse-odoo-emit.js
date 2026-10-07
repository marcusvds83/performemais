/**
 * services/nfse-odoo-emit.js — Integracao Odoo + Emissao NFS-e (SPED)
 * =================================================================
 * Polling: busca faturas com x_performe_nfse_status = 'pendente',
 * extrai dados via XML-RPC, gera XML DPS, assina com A1,
 * envia ao SPED NFS-e, e atualiza o Odoo com o resultado.
 *
 * Descobre campos dinamicamente via ir.model.fields para compatibilidade
 * com qualquer Odoo (com ou sem l10n_br, Online, etc.)
 */

const xmlrpc = require('xmlrpc');
const https = require('https');
const http = require('http');
const config = require('../config');
const { gerarXmlDPS } = require('./nfse-xml');
const { assinarXml } = require('./nfse-signer');
const { enviarDPS, baixarPdfDanfse } = require('./nfse-client');
const { carregarCertificado } = require('./firebase-cert');
const { gerarPdfDanfse } = require('./nfse-pdf');
const { cancelarNfse } = require('./nfse-cancelamento');

// === XML-RPC Helpers ===

/**
 * Cria ir.attachment compativel com Odoo 17/18/19.
 *
 * Odoo 19 removeu o campo 'datas' de ir.attachment!
 * Erro: ValueError: Invalid field 'datas' on 'ir.attachment'
 *
 * Esta funcao detecta automaticamente qual campo de conteudo binario existe:
 * - Odoo 17/18: usa 'datas' (Binary field)
 * - Odoo 19: usa 'db_datas' (Text field, base64 direto no DB)
 *
 * @returns {number} ID do attachment criado
 */
async function criarAttachmentCompativel(client, db, uid, nome, dadosBase64, resModel, resId, mimetype) {
  // 1. Descobre quais campos existem no ir.attachment deste Odoo
  let campoConteudo = 'datas';  // default (Odoo 17/18)
  try {
    const fieldsInfo = await executeKw(client, db, uid, 'ir.attachment', 'fields_get', []);
    const camposDisponiveis = Object.keys(fieldsInfo);
    // Odoo 19 nao tem 'datas' - usa 'db_datas'
    if (!camposDisponiveis.includes('datas')) {
      if (camposDisponiveis.includes('db_datas')) {
        campoConteudo = 'db_datas';
        console.log('[NFSE-EMIT] Odoo 19 detectado: usando campo db_datas (datas removido)');
      } else if (camposDisponiveis.includes('raw')) {
        campoConteudo = 'raw';
        console.log('[NFSE-EMIT] Odoo 19 detectado: usando campo raw');
      } else {
        // Loga todos os campos pra debug
        console.warn('[NFSE-EMIT] Campos ir.attachment: ' + camposDisponiveis.join(', '));
        // Tenta db_datas mesmo assim
        campoConteudo = 'db_datas';
      }
    } else {
      console.log('[NFSE-EMIT] Odoo 17/18 detectado: usando campo datas');
    }
  } catch (e) {
    console.warn('[NFSE-EMIT] Nao foi possivel verificar campos ir.attachment: ' + e.message + ' - usando datas (default)');
  }

  // 2. Cria o attachment com o campo correto
  const attachValues = {
    name: nome,
    res_model: resModel,
    res_id: resId,
    mimetype: mimetype,
  };
  attachValues[campoConteudo] = dadosBase64;

  const attachmentId = await executeKw(client, db, uid, 'ir.attachment', 'create', [attachValues]);
  console.log('[NFSE-EMIT] ir.attachment criado: id=' + attachmentId + ' (campo=' + campoConteudo + ', ' + Math.round(dadosBase64.length * 0.75) + ' bytes)');
  return attachmentId;
}

/**
 * Posta mensagem com anexo no chatter do Odoo 19 (metodo que FUNCIONA).
 *
 * message_post e bloqueado no Odoo SaaS (forbidden opcode).
 * mail.message.create direto NAO mostra preview do PDF no chatter Odoo 19.
 *
 * Solucao: mail.message.create com TODOS os campos que Odoo 19 exige
 * para aparecer no chatter como MENSAGEM com anexo visivel:
 *   - model, res_id, body, message_type='comment'
 *   - subtype_id (mt_note = mensagem interna, aparece no chatter)
 *   - attachment_ids: [[6, 0, [attachmentId]]]
 *   - record_name, record_name_model, parent_id, author_id, email_from
 *
 * @returns {number} ID da mail.message criada
 */
async function postarMensagemComAnexo(client, db, uid, model, resId, body, attachmentId, msgType) {
  // Busca subtype_id mt_note (mensagem interna)
  let subtypeId = false;
  try {
    const subtypes = await executeKw(client, db, uid, 'ir.model.data', 'search_read', [
      [['name', '=', 'mt_note'], ['module', '=', 'mail']], ['res_id'],
    ]);
    if (subtypes.length > 0) subtypeId = subtypes[0].res_id;
  } catch (e) {
    console.warn('[NFSE-EMIT] Nao foi possivel buscar mt_note subtype:', e.message);
  }

  // Busca res_id do registro pra setar record_name (Odoo 19 usa pra mostrar no chatter)
  let recordName = msgType || 'Anexo';
  let authorId = false;
  try {
    const records = await executeKw(client, db, uid, model, 'read', [[resId], ['name']]);
    if (records.length > 0 && records[0].name) recordName = records[0].name;
  } catch (e) { /* ignore */ }

  // Busca partner_id do usuario atual (pra author_id)
  try {
    const users = await executeKw(client, db, uid, 'res.users', 'read', [[uid], ['partner_id']]);
    if (users.length > 0 && users[0].partner_id) authorId = users[0].partner_id[0];
  } catch (e) { /* ignore */ }

  // Cria mail.message com TODOS os campos Odoo 19
  const msgVals = {
    subject: msgType || 'Anexo',
    model: model,
    res_id: resId,
    record_name: recordName,
    body: body,
    message_type: 'comment',
    subtype_id: subtypeId || false,
    author_id: authorId || false,
    email_from: false,
    attachment_ids: [[6, 0, [attachmentId]]],
    date: new Date().toISOString().replace('T', ' ').substring(0, 19),
    is_internal: true,
  };

  const msgId = await executeKw(client, db, uid, 'mail.message', 'create', [msgVals]);
  return msgId;
}

/**
 * Baixa o PDF DANFSe do proprio painel admin (nosso endpoint /api/v1/nfse/dashboard/:id/pdf).
 * Esse endpoint ja gera o PDF perfeito (mesmo que aparece no painel admin).
 * Evita duplicar logica de geracao de PDF.
 *
 * @param {number} moveId - ID da fatura no Odoo
 * @returns {Promise<Buffer>} Buffer do PDF
 */
async function baixarPdfDoPainel(moveId) {
  // Descobre a URL do proprio middleware (Render, Vercel ou localhost)
  // Render usa RENDER_EXTERNAL_URL (ex: https://performemais.onrender.com)
  // Vercel usa VERCEL_URL (ex: https://performemais.vercel.app)
  // Local usa http://localhost:PORT
  const port = config.port || process.env.PORT || 10000;
  const baseUrl = config.public_url
    ? config.public_url
    : 'http://localhost:' + port;
  const url = baseUrl + '/api/v1/nfse/dashboard/' + moveId + '/pdf';

  console.log('[NFSE-PDF] Baixando PDF do painel (ambiente=' + config.ambiente + '): ' + url);

  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'X-Api-Key': process.env.API_KEY || config.apiKey },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ': ' + body.substring(0, 200))));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        console.log('[NFSE-PDF] PDF baixado do painel: ' + buf.length + ' bytes');
        resolve(buf);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout ao baixar PDF do painel')); });
  });
}

function createClient(url) {
  const base = url.replace(/\/+$/, '');
  const host = base.replace('https://', '').replace('http://', '');
  const port = base.startsWith('https') ? 443 : 80;
  const isSecure = base.startsWith('https');
  const createFn = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: createFn({ host, path: '/xmlrpc/2/common', port }),
    models: createFn({ host, path: '/xmlrpc/2/object', port }),
  };
}

function authenticate(client) {
  const db = config.odoo.db;
  const user = config.odoo.user;
  const key = config.odoo.api_key;
  return new Promise((resolve, reject) => {
    client.common.methodCall('authenticate', [db, user, key, {}], (err, uid) => {
      if (err) reject(new Error('Auth Odoo falhou: ' + (err.message || JSON.stringify(err))));
      else if (uid === false || uid === null) reject(new Error('API Key Odoo invalida.'));
      else resolve(uid);
    });
  });
}

function executeKw(client, db, uid, model, method, args, kwargs) {
  return new Promise((resolve, reject) => {
    client.models.methodCall('execute_kw', [db, uid, config.odoo.api_key, model, method, args || [], kwargs || {}], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function readFields(client, db, uid, model, ids, fields) {
  return executeKw(client, db, uid, model, 'read', [ids], { fields });
}

/**
 * Descobre quais campos de uma lista realmente existem no modelo.
 * Retorna apenas os campos existentes.
 */
async function filtrarCamposExistentes(client, db, uid, modelo, camposDesejados) {
  const camposModelo = await executeKw(client, db, uid, 'ir.model.fields', 'search_read',
    [[['model', '=', modelo], ['name', 'in', camposDesejados]]],
    { fields: ['name'] }
  );
  const existentes = new Set(camposModelo.map(f => f.name));
  const validos = camposDesejados.filter(c => existentes.has(c));
  const faltantes = camposDesejados.filter(c => !existentes.has(c));
  if (faltantes.length > 0) {
    console.log('[NFSE-EMIT] Campos ausentes em ' + modelo + ': ' + faltantes.join(', '));
  }
  return validos;
}

/**
 * Faz write em account.move filtrando apenas os campos que existem no modelo.
 * Isso evita o erro KeyError quando tentamos escrever em campos x_nfse_* que
 * o cliente nao criou no Studio.
 *
 * @param {object} client - XML-RPC client
 * @param {string} db
 * @param {number} uid
 * @param {number} moveId - ID da fatura
 * @param {object} vals - {campo: valor, ...} - campos podem ser x_performe_* ou x_nfse_*
 * @returns {object} { escritos: string[], ignorados: string[] }
 */
async function safeWriteMove(client, db, uid, moveId, vals) {
  const todosCampos = Object.keys(vals);
  const existentes = await filtrarCamposExistentes(client, db, uid, 'account.move', todosCampos);
  const valsFiltrado = {};
  const ignorados = [];
  for (const campo of todosCampos) {
    if (existentes.includes(campo)) {
      valsFiltrado[campo] = vals[campo];
    } else {
      ignorados.push(campo);
    }
  }
  if (Object.keys(valsFiltrado).length > 0) {
    await executeKw(client, db, uid, 'account.move', 'write', [[moveId], valsFiltrado]);
  }
  return {
    escritos: Object.keys(valsFiltrado),
    ignorados,
  };
}

/**
 * Descobre o melhor campo de CNPJ/CPF disponivel no modelo.
 * Prioridade: cnpj_cpf (l10n_br) > x_performe_cnpj > vat > company_registry
 */
async function descobrirCampoCnpj(client, db, uid, modelo) {
  const candidatos = ['cnpj_cpf', 'x_performe_cnpj', 'vat', 'company_registry'];
  const validos = await filtrarCamposExistentes(client, db, uid, modelo, candidatos);
  return validos[0] || null;
}

/**
 * Extrai CNPJ/CPF de um registro, retorna so digitos.
 */
function extrairCnpj(record, campoCnpj, fallback) {
  if (campoCnpj && record[campoCnpj]) {
    return String(record[campoCnpj]).replace(/[^0-9]/g, '');
  }
  if (fallback) return String(fallback).replace(/[^0-9]/g, '');
  return '';
}

// === Processar emissões pendentes ===
async function processPendingEmissions() {
  if (!config.odoo.enabled || !config.odoo.url) {
    return { processed: 0, reason: 'odoo_not_configured' };
  }
  if (!config.odoo.api_key || !config.odoo.user) {
    console.error('[NFSE-EMIT] ODOO_USER ou ODOO_API_KEY nao configurados.');
    return { processed: 0, reason: 'no_api_key' };
  }

  const client = createClient(config.odoo.url);
  let uid;
  try {
    uid = await authenticate(client);
  } catch (e) {
    console.error('[NFSE-EMIT] Autenticacao Odoo falhou:', e.message);
    return { processed: 0, reason: 'auth_failed' };
  }
  const db = config.odoo.db;

  try {
    // 1. Processar cancelamentos solicitados
    await processarCancelamentosSolicitados(client, db, uid);

    // 2. Processar emissões pendentes
    const moveIds = await executeKw(client, db, uid, 'account.move', 'search', [[
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['x_performe_nfse_status', 'in', ['pendente', 'processando']],
    ]]);

    if (!moveIds || !moveIds.length) return { processed: 0 };

    console.log('[NFSE-EMIT] ' + moveIds.length + ' fatura(s) pendente(s).');
    const detalhes = [];

    for (const moveId of moveIds) {
      try {
        const resultado = await emitirNfseOdoo(client, db, uid, moveId);
        detalhes.push({ move_id: moveId, ...resultado });
      } catch (e) {
        console.error('[NFSE-EMIT] Erro move_id=' + moveId + ':', e.message);
        await safeUpdateError(client, db, uid, moveId, e.message);
        detalhes.push({ move_id: moveId, sucesso: false, erro: e.message });
      }
    }

    return { processed: moveIds.length, detalhes };
  } catch (e) {
    console.error('[NFSE-EMIT] Erro no polling:', e.message);
    return { processed: 0, reason: e.message };
  }
}

// === Emissao completa ===
async function emitirNfseOdoo(client, db, uid, moveId) {
  // 1. Marca como processando
  await safeWriteMove(client, db, uid, moveId, {
    x_performe_nfse_status: 'processando',
  });

  // 2. Carrega certificado A1 do Firebase
  const cert = await carregarCertificado();
  if (!cert || (!cert.pfx && !cert.privateKeyPem)) {
    throw new Error('Certificado A1 nao encontrado no Firebase. Faca upload via POST /api/v1/nfse/certificado');
  }

  // 3. Descobrir campos CNPJ
  const campoCnpjCompany = await descobrirCampoCnpj(client, db, uid, 'res.company');
  const campoCnpjPartner = await descobrirCampoCnpj(client, db, uid, 'res.partner');
  console.log('[NFSE-EMIT] CNPJ: company=' + campoCnpjCompany + ' partner=' + campoCnpjPartner);

  // 4. Leitura da fatura
  const moves = await readFields(client, db, uid, 'account.move', [moveId], [
    'name', 'partner_id', 'company_id', 'invoice_date', 'amount_total', 'amount_untaxed',
    'amount_tax', 'narration', 'payment_reference', 'invoice_line_ids',
  ]);
  const move = moves[0];

  // 5. Leitura da empresa — descobre campos existentes dinamicamente
  const camposCompanyDesejados = [
    'name', 'street', 'street2', 'city', 'city_id', 'state_id', 'state',
    'zip', 'phone', 'email', 'district', 'country_id', 'l10n_br_city_id',
    'company_registry', 'vat', 'website',
    'x_performe_nfse_dados_prestador_im', 'x_performe_nfse_numero',
  ];
  const camposCompany = await filtrarCamposExistentes(client, db, uid, 'res.company', camposCompanyDesejados);
  const companies = await readFields(client, db, uid, 'res.company', [move.company_id[0]], camposCompany);
  const company = companies[0];

  // Extrai CNPJ da empresa (fallback: CNPJ Performe+ da config)
  company._cnpj = extrairCnpj(company, campoCnpjCompany, '06696225000100');
  // Validacao critica: CNPJ do prestador nao pode ser vazio
  if (!company._cnpj || company._cnpj.length !== 14) {
    console.error('[NFSE-EMIT] CNPJ do prestador invalido: "' + company._cnpj + '" (campo=' + campoCnpjCompany + ')');
    console.error('[NFSE-EMIT] Conteudo do campo: "' + (campoCnpjCompany ? company[campoCnpjCompany] : '(null)') + '"');
    throw new Error('CNPJ do prestador invalido ou vazio. Campo usado: ' + campoCnpjCompany + '. Verifique o cadastro da empresa no Odoo (Definicoes > Empresas).');
  }

  // Extrai cidade da empresa (city || city_id || config)
  if (company.city_id) {
    company._cidade = company.city_id[1] || '';
  } else if (company.city) {
    company._cidade = company.city;
  } else {
    company._cidade = config.nfse.cidade;
  }

  // Extrai UF da empresa (state_id || state || config)
  if (company.state_id) {
    company._uf = company.state_id[1] || config.nfse.uf;
  } else if (company.state) {
    company._uf = company.state;
  } else {
    company._uf = config.nfse.uf;
  }

  console.log('[NFSE-EMIT] Empresa: ' + company.name + ' CNPJ=' + company._cnpj + ' Cidade=' + company._cidade);

  // 6. Leitura do parceiro (tomador)
  const camposPartnerDesejados = [
    'name', 'street', 'street2', 'city', 'city_id', 'state_id', 'state',
    'zip', 'phone', 'email', 'district', 'country_id', 'country_code',
    'legal_name', 'company_name', 'vat', 'cnpj_cpf', 'l10n_br_city_id',
  ];
  const camposPartner = await filtrarCamposExistentes(client, db, uid, 'res.partner', camposPartnerDesejados);
  const partners = await readFields(client, db, uid, 'res.partner', [move.partner_id[0]], camposPartner);
  const partner = partners[0];

  // Extrai CNPJ do tomador
  partner._cnpj = extrairCnpj(partner, campoCnpjPartner, null);

  // Extrai cidade do tomador
  if (partner.city_id) {
    partner._cidade = partner.city_id[1] || '';
  } else if (partner.city) {
    partner._cidade = partner.city;
  } else {
    partner._cidade = '';
  }

  console.log('[NFSE-EMIT] Tomador: ' + partner.name + ' CNPJ=' + partner._cnpj + ' Cidade=' + partner._cidade);

  // 7. Leitura das linhas de servico
  const allLines = await readFields(client, db, uid, 'account.move.line', move.invoice_line_ids, [
    'name', 'quantity', 'price_unit', 'price_subtotal', 'product_id', 'tax_ids', 'display_type',
  ]);
  const serviceLines = allLines.filter(l => !l.display_type && l.price_subtotal > 0);

  // 8. Leitura dos produtos
  const productIds = serviceLines.filter(l => l.product_id).map(l => l.product_id[0]).filter(Boolean);
  const camposProdutoDesejados = [
    'name', 'default_code',
    'x_performe_codigo_tributacao', 'x_performe_c_nbs',
    'x_performe_aliquota_iss', 'x_performe_iss_retido', 'x_performe_descricao_nfse',
  ];
  const camposProduto = await filtrarCamposExistentes(client, db, uid, 'product.product', camposProdutoDesejados);
  const products = productIds.length
    ? await readFields(client, db, uid, 'product.product', productIds, camposProduto)
    : [];
  const productMap = {};
  products.forEach(p => { productMap[p.id] = p; });

  // 9. Incrementa numeracao na empresa
  const ultimoNumero = company.x_performe_nfse_numero || 0;
  const proximoNumero = ultimoNumero + 1;
  await executeKw(client, db, uid, 'res.company', 'write', [[company.id], {
    x_performe_nfse_numero: proximoNumero,
  }]);

  console.log('=============================================================');
  console.log('[NFSE-EMIT] INICIO EMISSAO - Fatura ' + move.name + ' (move_id=' + moveId + ')');
  console.log('[NFSE-EMIT]   nDPS: ' + proximoNumero + ' (ultimo=' + ultimoNumero + ')');
  console.log('[NFSE-EMIT]   Empresa: ' + company.name + ' CNPJ=' + company._cnpj);
  console.log('[NFSE-EMIT]   Tomador: ' + partner.name + ' CNPJ=' + partner._cnpj);
  console.log('[NFSE-EMIT]   Valor: R$ ' + (move.amount_total || move.amount_untaxed));
  console.log('[NFSE-EMIT]   Ambiente: ' + (config.nfse.tp_amb === 1 ? 'PRODUCAO' : 'HOMOLOGACAO'));

  // 10. Gera XML DPS
  console.log('[NFSE-EMIT] Etapa 1/4: Gerando XML DPS...');
  const { xml: dpsXml, infDpsId } = await gerarXmlDPS({
    move, company, partner,
    lines: serviceLines,
    products: productMap,
    nDPS: proximoNumero,
  });
  console.log('[NFSE-EMIT] XML DPS gerado: ' + dpsXml.length + ' bytes | infDpsId=' + infDpsId);

  // 11. Assina o XML
  console.log('[NFSE-EMIT] Etapa 2/4: Assinando XML DPS...');
  const dpsAssinado = await assinarXml(dpsXml, {
    privateKeyPem: cert.privateKeyPem,
    certPem: cert.certPem,
  });
  console.log('[NFSE-EMIT] XML assinado: ' + dpsAssinado.length + ' bytes');

  // 12. Envia para o SPED
  console.log('[NFSE-EMIT] Etapa 3/4: Enviando DPS para SEFIN...');
  const resultado = await enviarDPS(dpsAssinado, cert);
  console.log('[NFSE-EMIT] Etapa 4/4: Resultado SEFIN: sucesso=' + resultado.sucesso + ' | cStat=' + (resultado.cStat || 'n/a'));

  // 13. Atualiza o Odoo com o resultado
  if (resultado.sucesso) {
    // Formata data para o formato Odoo: YYYY-MM-DD HH:MM:SS (sem timezone/microssegundos)
    let dataEmissao = '';
    if (resultado.dataHoraProcessamento) {
      try {
        const dt = new Date(resultado.dataHoraProcessamento);
        dataEmissao = dt.getFullYear() + '-' +
          String(dt.getMonth() + 1).padStart(2, '0') + '-' +
          String(dt.getDate()).padStart(2, '0') + ' ' +
          String(dt.getHours()).padStart(2, '0') + ':' +
          String(dt.getMinutes()).padStart(2, '0') + ':' +
          String(dt.getSeconds()).padStart(2, '0');
      } catch (_) {
        dataEmissao = new Date().toISOString().replace('T', ' ').substring(0, 19);
      }
    } else {
      dataEmissao = new Date().toISOString().replace('T', ' ').substring(0, 19);
    }
    const updateData = {
      x_performe_nfse_status: 'autorizada',
      x_performe_nfse_numero: resultado.nNFSe || String(proximoNumero),
      x_performe_nfse_codigo_verificacao: resultado.chaveAcesso || resultado.nDFSe || '',
      x_performe_nfse_protocolo: resultado.idDps || '',
      x_performe_nfse_data_emissao: dataEmissao,
      x_performe_nfse_erro: false,
      x_performe_nfse_mensagem: false,
    };
    if (resultado.xmlRetorno && resultado.xmlRetorno.length < 50000) {
      updateData.x_performe_nfse_xml = resultado.xmlRetorno;
    }

    // Compatibilidade: tambem escreve nos campos x_nfse_* (sem _performe_) que
    // existem na view de fatura do cliente Performe+ (criados via Studio).
    // Usa try/catch para cada campo - se o campo nao existir no Odoo, ignora.
    // Nomes dos campos confirmados via GET /admin/performe/status em 03/09/2026.
    //
    // VALORES DA NFS-e:
    // - NFS-e NAO soma imposto no total (ISS nao retido = cliente paga so vServ)
    // - vServ = valor do serviço (amount_untaxed do Odoo, SEM ICMS/ISS)
    // - vLiq = valor liquido = vServ - deducoes - descontos - retencoes
    // - Se ISS nao retido: vLiq = vServ (nao soma imposto)
    const vServOdoo = move.amount_untaxed || move.amount_total || 0;
    const aliquotaIss = config.nfse.aliquota_iss || 0;
    const vISS = (vServOdoo * aliquotaIss) / 100;

    // Extrai vLiq da NFS-e retornada pela SEFIN (se disponivel)
    let vLiqNfse = vServOdoo;  // default = vServ (se ISS nao retido)
    if (resultado.xmlRetorno) {
      const vLiqMatch = resultado.xmlRetorno.match(/<vLiq>([^<]+)<\/vLiq>/);
      if (vLiqMatch) vLiqNfse = parseFloat(vLiqMatch[1]) || vServOdoo;
    }

    // Extrai dados do XML DPS enviado (para preencher campos da view do Odoo)
    // xDescServ do XML, cTribNac, competencia
    let xDescServCompleto = 'Servico prestado conforme contrato';
    let cTribNac = config.nfse.c_trib_nac_padrao || '080201';
    let competenciaFmt = '';
    try {
      if (dpsXml) {
        const xDescMatch = dpsXml.match(/<xDescServ>([^<]*)<\/xDescServ>/);
        if (xDescMatch) xDescServCompleto = xDescMatch[1];
        const cTribMatch = dpsXml.match(/<cTribNac>([^<]*)<\/cTribNac>/);
        if (cTribMatch) cTribNac = cTribMatch[1];
        const dCompetMatch = dpsXml.match(/<dCompet>([^<]*)<\/dCompet>/);
        if (dCompetMatch) {
          // Converte YYYY-MM-DD para MMAAAA
          const dt = dCompetMatch[1];
          if (dt.length >= 7) {
            competenciaFmt = dt.substring(5, 7) + dt.substring(0, 4);
          }
        }
      }
    } catch (e) {
      console.warn('[NFSE-EMIT] Erro ao extrair dados do DPS pra view: ' + e.message);
    }
    console.log('[NFSE-EMIT] Campos view: xDescServ="' + xDescServCompleto.substring(0, 60) + '..." cTribNac=' + cTribNac + ' competencia=' + competenciaFmt);

    const xCompat = {
      x_nfse_numero: String(resultado.nNFSe || proximoNumero),
      x_nfse_codigo_verificacao: resultado.chaveAcesso || resultado.nDFSe || '',
      x_nfse_protocolo: resultado.idDps || '',
      x_nfse_data_emissao: dataEmissao,
      x_nfse_status_emissao: 'autorizada',
      x_nfse_situacao: '1',  // 1=Normal, 2=Cancelada
      x_nfse_mensagem: false,
      // x_nfse_erro nao existe no Odoo Performe+ - removido
      x_nfse_url_pdf: resultado.chaveAcesso ? ('https://adn.nfse.gov.br/danfse/' + resultado.chaveAcesso) : '',
      x_nfse_sim_nao: true,  // marcar como "Gerar NFS-e = Sim"
      // Campos de SERVICO (discriminacao completa com produto + qtd + valor)
      x_nfse_discriminacao: xDescServCompleto,        // NFS-e Discriminacao
      x_nfse_codigo_servico: cTribNac,                 // NFS-e Codigo Servico Municipal
      x_nfse_cnae_codigo: '',                          // NFS-e CNAE (preencher se tiver)
      x_nfse_item_lista: cTribNac,                     // NFS-e Item Lista Servico
      x_nfse_municipio_prestacao: '4106902',           // NFS-e Municipio Prestacao (Curitiba)
      x_nfse_natureza_operacao: '1',                   // NFS-e Natureza Operacao (1=Tributacao no municipio)
      x_nfse_optante_simples: true,                    // NFS-e Optante Simples Nacional
      x_nfse_incentivador_cultural: false,             // NFS-e Incentivador Cultural
      // RPS (usamos DPS direto, mas preenche campos RPS para compatibilidade)
      x_nfse_rps_numero: String(proximoNumero),        // NFS-e RPS Numero
      x_nfse_rps_serie: '1',                           // NFS-e RPS Serie
      x_nfse_rps_tipo: '1',                            // NFS-e RPS Tipo (1=RPS)
      // Competencia (MMAAAA da data da fatura)
      x_nfse_competencia: competenciaFmt,              // NFS-e Competencia
      // Campos de VALOR - usar vServ (sem imposto) nao amount_total (com imposto)
      x_nfse_base_calculo: vServOdoo,         // NFS-e Base Calculo = valor do servico
      x_nfse_valor_liquido: vLiqNfse,         // NFS-e Valor Liquido = vLiq da SEFIN (ou vServ se nao retido)
      x_nfse_iss_base: vServOdoo,             // NFS-e Base Calculo ISS
      x_nfse_iss_aliquota: aliquotaIss,       // NFS-e Aliquota ISS (%)
      x_nfse_iss_valor: vISS,                 // NFS-e Valor ISS
      // Impostos federais (zeros - Simples Nacional nao detalha)
      x_nfse_pis_valor: 0,
      x_nfse_cofins_valor: 0,
      x_nfse_inss_valor: 0,
      x_nfse_ir_valor: 0,
      x_nfse_csll_valor: 0,
      x_nfse_outras_retencoes: 0,
      x_nfse_desconto_incond: 0,
      x_nfse_desconto_cond: 0,
      // IBS/CBS (NT 004/2025 - nao enviamos no XML, mas preenche zeros na view)
      x_nfse_ibs_base: 0,
      x_nfse_ibs_aliquota: 0,
      x_nfse_ibs_valor: 0,
      x_nfse_cbs_base: 0,
      x_nfse_cbs_aliquota: 0,
      x_nfse_cbs_valor: 0,
    };
    if (resultado.xmlRetorno && resultado.xmlRetorno.length < 50000) {
      xCompat.x_nfse_xml_retorno = resultado.xmlRetorno;
    }
    Object.assign(updateData, xCompat);
    console.log('[NFSE-EMIT] Valores Odoo: vServ=' + vServOdoo + ' vLiq=' + vLiqNfse + ' vISS=' + vISS + ' (ISS ' + (config.nfse.aliquota_iss) + '%)');

    await safeWriteMove(client, db, uid, moveId, updateData);

    const msgBody = '<div style="background:#dcfce7;border-left:4px solid #16a34a;padding:12px;margin:8px 0;border-radius:4px">' +
      '<b style="color:#15803d">✓ NFS-e Emitida com Sucesso!</b><br/>' +
      '<b>Número:</b> ' + (resultado.nNFSe || proximoNumero) + '<br/>' +
      '<b>Chave de Acesso:</b> ' + (resultado.chaveAcesso || '-') + '<br/>' +
      '<b>DFSe:</b> ' + (resultado.nDFSe || '-') + '<br/>' +
      '<b>IdDPS:</b> ' + (resultado.idDps || '-') + '<br/>' +
      '<b>Ambiente:</b> ' + (config.nfse.tp_amb === 1 ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO') + '<br/>' +
      (resultado.chaveAcesso ? '<br/><a href="https://adn.nfse.gov.br/danfse/' + resultado.chaveAcesso + '" target="_blank">📄 Ver DANFSe oficial</a>' : '') +
      '</div>';
    await executeKw(client, db, uid, 'mail.message', 'create', [{
      model: 'account.move',
      res_id: moveId,
      body: msgBody,
      message_type: 'comment',
    }]);

    console.log('[NFSE-EMIT] NFS-e ' + (resultado.nNFSe || proximoNumero) + ' autorizada para ' + move.name);

    // 14. Anexa XML da NFS-e ao chatter
    try {
      if (resultado.xmlRetorno) {
        const numNF = resultado.nNFSe || proximoNumero;
        const xmlNome = 'NFS-e-' + String(numNF).padStart(6, '0') + '.xml';
        console.log('[NFSE-EMIT] Anexando XML: ' + xmlNome + ' (' + resultado.xmlRetorno.length + ' chars)...');
        await uploadAnexo(client, db, uid, 'account.move', moveId,
          xmlNome, resultado.xmlRetorno, 'application/xml',
          '<b>XML NFS-e ' + numNF + '</b>');
      } else {
        console.warn('[NFSE-EMIT] xmlRetorno vazio/nulo — nao e possivel anexar XML nem gerar PDF');
      }
    } catch (e) {
      console.error('[NFSE-EMIT] Falha ao anexar XML:', e.message, e.stack);
    }

    // 15. Gera e anexa PDF DANFSE ao chatter
    // Estrategia: 1) Tenta baixar PDF oficial da SEFIN, 2) Fallback gera local
    try {
      if (resultado.xmlRetorno) {
        const numNF = resultado.nNFSe || proximoNumero;
        const pdfNome = 'DANFSe-' + String(numNF).padStart(6, '0') + '.pdf';
        const chaveAcesso = resultado.chaveAcesso || '';
        let pdfBuf = null;
        let pdfOrigem = '';

        // 15a. Baixa PDF DANFSe do painel admin (mesmo PDF que aparece no /painel)
        // O endpoint /api/v1/nfse/dashboard/:id/pdf ja gera o PDF perfeito.
        console.log('[NFSE-EMIT] 15a. Baixando DANFSe do painel admin...');
        try {
          pdfBuf = await baixarPdfDoPainel(moveId);
          if (pdfBuf) {
            pdfOrigem = 'painel_admin';
            console.log('[NFSE-EMIT] DANFSe baixado do painel: ' + pdfBuf.length + ' bytes');
          }
        } catch (eLocal) {
          console.error('[NFSE-EMIT] FALHA ao baixar DANFSe do painel: ' + eLocal.message);
          // Fallback: tenta gerar localmente
          if (resultado.xmlRetorno) {
            console.log('[NFSE-EMIT] Tentando gerar PDF localmente como fallback...');
            try {
              pdfBuf = await gerarPdfDanfse(resultado.xmlRetorno);
              pdfOrigem = 'danfse_local_fallback';
              console.log('[NFSE-EMIT] DANFSe gerado localmente (fallback): ' + pdfBuf.length + ' bytes');
            } catch (e2) {
              console.error('[NFSE-EMIT] Fallback tambem falhou: ' + e2.message);
            }
          }
        }

        // 15b. Anexa o PDF ao chatter
        if (pdfBuf && pdfBuf.length > 0) {
          // Log dos primeiros bytes pra confirmar que e PDF valido
          const header = pdfBuf.slice(0, 8).toString('ascii');
          console.log('[NFSE-EMIT] 15b. Anexando PDF: ' + pdfNome + ' (' + pdfBuf.length + ' bytes, origem=' + pdfOrigem + ', header="' + header + '")...');
          await uploadAnexo(client, db, uid, 'account.move', moveId,
            pdfNome, pdfBuf, 'application/pdf',
            '<b>DANFSe ' + numNF + '</b>');
          console.log('[NFSE-EMIT] PDF anexado com sucesso no chatter!');
        } else {
          console.error('[NFSE-EMIT] NENHUM PDF gerado (nem oficial, nem local). Chatter tera apenas XML.');
        }
      } else {
        console.warn('[NFSE-EMIT] xmlRetorno vazio — nao e possivel gerar PDF');
      }
    } catch (e) {
      console.error('[NFSE-EMIT] Falha geral ao anexar PDF DANFSE:', e.message, e.stack);
    }

    return { sucesso: true, nNFSe: resultado.nNFSe, chaveAcesso: resultado.chaveAcesso, nDFSe: resultado.nDFSe };

  } else {
    const motivo = resultado.xMotivo || 'Erro desconhecido';
    await safeUpdateError(client, db, uid, moveId,
      'NFS-e rejeitada: ' + motivo + ' (cStat=' + (resultado.cStat || 0) + ')');
    return { sucesso: false, erro: motivo, cStat: resultado.cStat };
  }
}

// === Atualiza erro no Odoo ===
async function safeUpdateError(client, db, uid, moveId, errMsg) {
  try {
    const updateData = {
      x_performe_nfse_status: config.nfse.status_on_error || 'erro',
      x_performe_nfse_erro: true,
      x_performe_nfse_mensagem: errMsg.substring(0, 1000),
    };
    // Compatibilidade: tambem atualiza campos x_nfse_* da view do cliente
    // Nomes confirmados via GET /admin/performe/status em 03/09/2026
    Object.assign(updateData, {
      x_nfse_status_emissao: 'erro',
      x_nfse_mensagem: errMsg.substring(0, 1000),
      // x_nfse_erro nao existe no Odoo Performe+ - removido
    });
    await safeWriteMove(client, db, uid, moveId, updateData);

    // Extrai codigo do erro se presente (ex: "E0116" -> badge)
    const codigoMatch = errMsg.match(/(?:E\d{4}|cStat=\d+)/);
    const codigoBadge = codigoMatch ? codigoMatch[0] : 'ERRO';

    const msgBody = '<div style="background:#fef2f2;border-left:4px solid #dc2626;padding:12px;margin:8px 0;border-radius:4px">' +
      '<b style="color:#b91c1c">✗ Erro na Emissão de NFS-e</b><br/>' +
      '<b>Código:</b> <code style="background:#fee2e2;padding:2px 6px;border-radius:3px">' + codigoBadge + '</code><br/>' +
      '<b>Mensagem:</b> ' + errMsg.substring(0, 800).replace(/</g, '&lt;') + '<br/>' +
      '<b>Ambiente:</b> ' + (config.nfse.tp_amb === 1 ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO') + '<br/>' +
      '<b>Próximo passo:</b> Corrija o problema e clique novamente em "Emitir NFS-e"' +
      '</div>';
    await executeKw(client, db, uid, 'mail.message', 'create', [{
      model: 'account.move',
      res_id: moveId,
      body: msgBody,
      message_type: 'comment',
    }]);
  } catch (e) {
    console.error('[NFSE-EMIT] Falha ao registrar erro:', e.message);
  }
}

// === Upload de anexos ao chatter do Odoo ===
/**
 * Cria um ir.attachment no Odoo e vincula a uma mail.message no chatter.
 * No Odoo 17+, apenas criar ir.attachment com res_model/res_id pode nao
 * exibir no chatter. A solucao e criar o anexo e depois vincular a uma mensagem.
 *
 * @param {object} client - XML-RPC client
 * @param {string} db - Odoo database
 * @param {number} uid - User ID
 * @param {string} model - res_model (ex: 'account.move')
 * @param {number} resId - ID do registro
 * @param {string} nome - Nome do arquivo (ex: 'NFS-e-19.xml')
 * @param {string|Buffer} conteudo - Conteudo do arquivo
 * @param {string} mimetype - MIME type
 * @param {string} [msgBody] - Texto HTML da mensagem (opcional)
 * @returns {number} ID do attachment criado
 */
async function uploadAnexo(client, db, uid, model, resId, nome, conteudo, mimetype, msgBody) {
  const dados = Buffer.isBuffer(conteudo)
    ? conteudo.toString('base64')
    : Buffer.from(conteudo, 'utf-8').toString('base64');

  const header = Buffer.isBuffer(conteudo) ? conteudo.slice(0, 8).toString('ascii') : '';
  console.log('[NFSE-EMIT] Criando anexo: ' + nome + ' (' + Math.round(dados.length * 0.75) + ' bytes, header="' + header + '")...');

  // 1. Cria o attachment usando funcao compativel Odoo 17/18/19
  const attachmentId = await criarAttachmentCompativel(client, db, uid, nome, dados, model, resId, mimetype);

  // 2. Posta no chatter usando postarMensagemComAnexo (Odoo 19 compativel)
  const body = msgBody || ('Anexo: ' + nome);
  try {
    const msgId = await postarMensagemComAnexo(client, db, uid, model, resId, body, attachmentId, nome);
    console.log('[NFSE-EMIT] mail.message criada (id=' + msgId + ') - mensagem interna com anexo ' + nome);
  } catch (e) {
    console.warn('[NFSE-EMIT] postarMensagemComAnexo falhou: ' + String(e.message || e).substring(0, 200));
    console.warn('[NFSE-EMIT] Anexo existe como ir.attachment id=' + attachmentId + ' (visivel na aba Anexos do Odoo)');
  }

  return attachmentId;
}

// === Processar cancelamentos solicitados via botao Odoo ===
async function processarCancelamentosSolicitados(client, db, uid) {
  try {
    const cancelIds = await executeKw(client, db, uid, 'account.move', 'search', [[
      ['x_performe_nfse_status', '=', 'cancelar_solicitado'],
    ]]);

    if (!cancelIds || !cancelIds.length) return;

    console.log('[NFSE-CANCEL-POLL] ' + cancelIds.length + ' cancelamento(s) solicitado(s).');

    for (const moveId of cancelIds) {
      try {
        console.log('=============================================================');
        console.log('[NFSE-CANCEL-POLL] INICIO - move_id=' + moveId);

        // Le dados da fatura
        const moves = await readFields(client, db, uid, 'account.move', [moveId], [
          'name', 'x_performe_nfse_status', 'x_performe_nfse_numero',
          'x_performe_nfse_codigo_verificacao', 'company_id',
        ]);
        if (!moves || !moves.length) {
          console.log('[NFSE-CANCEL-POLL] Fatura nao encontrada');
          continue;
        }
        const move = moves[0];
        const chaveAcesso = move.x_performe_nfse_codigo_verificacao || '';

        console.log('[NFSE-CANCEL-POLL] Fatura: ' + move.name + ' | Chave: ' + chaveAcesso);

        if (!chaveAcesso) {
          console.log('[NFSE-CANCEL-POLL] Chave vazia, marcando como erro');
          await safeUpdateError(client, db, uid, moveId, 'Chave de acesso vazia. Nao e possivel cancelar.');
          continue;
        }

        // Busca CNPJ da empresa
        const campoCnpj = await descobrirCampoCnpj(client, db, uid, 'res.company');
        const companies = await readFields(client, db, uid, 'res.company', [move.company_id[0]], [campoCnpj || 'name', 'name']);
        const cnpjPrest = campoCnpj ? String(companies[0][campoCnpj] || '').replace(/[^0-9]/g, '') : '';

        // Cancela na SEFIN
        console.log('[NFSE-CANCEL-POLL] Enviando cancelamento para SEFIN...');
        const resultado = await cancelarNfse({
          nNFSe: move.x_performe_nfse_numero || '',
          chaveAcesso: chaveAcesso,
          cnpjPrest: cnpjPrest,
          justificativa: 'Cancelamento solicitado pelo emitente via Odoo',
        });

        console.log('[NFSE-CANCEL-POLL] Resultado: sucesso=' + resultado.sucesso + ' | xMotivo=' + (resultado.xMotivo || ''));

        if (resultado.sucesso) {
          await safeWriteMove(client, db, uid, moveId, {
            x_performe_nfse_status: 'cancelada',
            x_performe_nfse_erro: false,
            x_performe_nfse_mensagem: 'Cancelada: ' + (resultado.xMotivo || ''),
            // Compatibilidade com x_nfse_* (nomes confirmados 03/09/2026)
            x_nfse_status_emissao: 'cancelada',
            x_nfse_situacao: '2',
            x_nfse_mensagem: 'Cancelada: ' + (resultado.xMotivo || ''),
          });
          await executeKw(client, db, uid, 'mail.message', 'create', [{
            model: 'account.move',
            res_id: moveId,
            body: '<b>NFS-e Cancelada com Sucesso</b><br/>Justificativa: Cancelamento solicitado pelo emitente via Odoo<br/>Resposta SEFIN: ' + (resultado.xMotivo || ''),
            message_type: 'comment',
          }]);
          console.log('[NFSE-CANCEL-POLL] SUCESSO - Fatura ' + move.name + ' cancelada');
        } else {
          // Falha no cancelamento: volta o status para 'autorizada' (nao marca como erro)
          const motivo = resultado.xMotivo || 'Erro desconhecido';
          console.log('[NFSE-CANCEL-POLL] FALHA - ' + motivo);
          await safeWriteMove(client, db, uid, moveId, {
            x_performe_nfse_status: 'autorizada',
            x_performe_nfse_erro: false,
            x_performe_nfse_mensagem: 'Falha ao cancelar: ' + motivo.substring(0, 500),
            // Compatibilidade com x_nfse_* (nomes confirmados 03/09/2026)
            x_nfse_status_emissao: 'autorizada',
            x_nfse_mensagem: 'Falha ao cancelar: ' + motivo.substring(0, 500),
          });
          await executeKw(client, db, uid, 'mail.message', 'create', [{
            model: 'account.move',
            res_id: moveId,
            body: '<b>Falha no Cancelamento da NFS-e</b><br/>A nota continua <b>autorizada</b>.<br/>Erro: ' + motivo.substring(0, 500),
            message_type: 'comment',
          }]);
        }
        console.log('=============================================================');
      } catch (e) {
        console.error('[NFSE-CANCEL-POLL] Erro move_id=' + moveId + ':', e.stack || e.message);
        await safeUpdateError(client, db, uid, moveId, 'Erro ao cancelar: ' + e.message);
      }
    }
  } catch (e) {
    console.error('[NFSE-CANCEL-POLL] Erro geral:', e.message);
  }
}

module.exports = { processPendingEmissions, baixarPdfDoPainel, postarMensagemComAnexo, criarAttachmentCompativel };
