/**
 * routes/admin-tools.js — Ferramentas Administrativas
 * ==================================================
 * POST /api/v1/nfse/admin/impostos/push      — Enviar config de impostos ao Odoo
 * GET  /api/v1/nfse/admin/campos/status       — Verificar campos x_performe_* no Odoo
 * POST /api/v1/nfse/admin/campos/criar          — Criar campos x_performe_* no Odoo
 * POST /api/v1/nfse/admin/campos/server-actions — Criar Server Actions no Odoo
 * POST /api/v1/nfse/admin/xml/preview          — Preview do XML DPS com dados atuais
 */

const express = require('express');
const router = express.Router();
const config = require('../config');
const xmlrpc = require('xmlrpc');
const { getIbsCbsConfig, saveIbsCbsConfig, getMeta } = require('../services/trib-config');

// === Auth ===
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ erro: 'API key invalida' });
  }
  next();
}

// === Odoo XML-RPC Helpers ===
function createClient(url) {
  const base = (url || config.odoo.url).replace(/\/+$/, '');
  const host = base.replace('https://', '').replace('http://', '');
  const port = base.startsWith('https') ? 443 : 80;
  const isSecure = base.startsWith('https');
  const createFn = isSecure ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return {
    common: createFn({ host, path: '/xmlrpc/2/common', port }),
    models: createFn({ host, path: '/xmlrpc/2/object', port }),
  };
}

async function authenticate(client) {
  return new Promise((resolve, reject) => {
    client.common.methodCall('authenticate', [config.odoo.db, config.odoo.user, config.odoo.api_key, {}], (err, uid) => {
      if (err || !uid) reject(new Error('Auth falhou'));
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

// ==========================================================
// 1. IMPOSTOS — Configurar e enviar ao Odoo
// ==========================================================

/** Campos x_performe_* necessarios no Odoo */
const CAMPOS_NECESSARIOS = [
  { modelo: 'account.move', nome: 'x_performe_nfse_status', tipo: 'selection', selecoes: "[('pendente','Pendente'),('processando','Processando'),('autorizada','Autorizada'),('cancelada','Cancelada'),('cancelar_solicitado','Cancel. Solicitado'),('erro','Erro')]", label: 'NFS-e Status (Performe+)' },
  { modelo: 'account.move', nome: 'x_performe_nfse_numero', tipo: 'char', kwargs: { size: 20 }, label: 'NFS-e Numero (Performe+)' },
  { modelo: 'account.move', nome: 'x_performe_nfse_codigo_verificacao', tipo: 'char', kwargs: { size: 60 }, label: 'NFS-e Codigo Verificacao (Performe+)' },
  { modelo: 'account.move', nome: 'x_performe_nfse_protocolo', tipo: 'char', kwargs: { size: 80 }, label: 'NFS-e Protocolo (Performe+)' },
  { modelo: 'account.move', nome: 'x_performe_nfse_data_emissao', tipo: 'datetime', label: 'NFS-e Data Emissao (Performe+)' },
  { modelo: 'account.move', nome: 'x_performe_nfse_xml', tipo: 'text', label: 'NFS-e XML (Performe+)' },
  { modelo: 'account.move', nome: 'x_performe_nfse_url', tipo: 'char', kwargs: { size: 300 }, label: 'NFS-e URL (Performe+)' },
  { modelo: 'account.move', nome: 'x_performe_nfse_erro', tipo: 'boolean', label: 'NFS-e Erro (Performe+)' },
  { modelo: 'account.move', nome: 'x_performe_nfse_mensagem', tipo: 'text', label: 'NFS-e Mensagem Erro (Performe+)' },
  { modelo: 'res.company', nome: 'x_performe_nfse_numero', tipo: 'integer', label: 'NFS-e Contador (Performe+)' },
  { modelo: 'res.company', nome: 'x_performe_nfse_dados_prestador_im', tipo: 'char', kwargs: { size: 20 }, label: 'NFS-e Insc. Municipal Prestador (Performe+)' },
  { modelo: 'product.product', nome: 'x_performe_codigo_tributacao', tipo: 'char', kwargs: { size: 20 }, label: 'Codigo Tributacao Performe+' },
  { modelo: 'product.product', nome: 'x_performe_c_nbs', tipo: 'char', kwargs: { size: 20 }, label: 'Codigo NBS Performe+' },
  { modelo: 'product.product', nome: 'x_performe_aliquota_iss', tipo: 'float', label: 'Aliquota ISS Performe+' },
  { modelo: 'product.product', nome: 'x_performe_iss_retido', tipo: 'selection', selecoes: "[('1','Sim'),('2','Nao')]", label: 'ISS Retido Performe+' },
  { modelo: 'product.product', nome: 'x_performe_descricao_nfse', tipo: 'text', label: 'Descricao NFS-e Performe+' },
];

// GET — Verificar quais campos existem
router.get('/admin/campos/status', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    const resultados = [];
    for (const campo of CAMPOS_NECESSARIOS) {
      const existing = await executeKw(client, db, uid, 'ir.model.fields', 'search', [
        [['model', '=', campo.modelo], ['name', '=', campo.nome]],
      ]);
      resultados.push({
        modelo: campo.modelo,
        nome: campo.nome,
        label: campo.label,
        tipo: campo.tipo,
        existe: existing.length > 0,
      });
    }

    const existentes = resultados.filter(r => r.existe).length;
    res.json({
      total: resultados.length,
      existentes,
      faltantes: resultados.length - existentes,
      campos: resultados,
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST — Criar campos que faltam
router.post('/admin/campos/criar', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    // Busca os model IDs
    const modelosNecessarios = [...new Set(CAMPOS_NECESSARIOS.map(c => c.modelo))];
    const modelIds = {};
    for (const modelo of modelosNecessarios) {
      const ids = await executeKw(client, db, uid, 'ir.model', 'search', [[['model', '=', modelo]]]);
      modelIds[modelo] = ids.length > 0 ? ids[0] : null;
    }

    const criados = [];
    const pulados = [];
    const erros = [];

    for (const campo of CAMPOS_NECESSARIOS) {
      // Verifica se ja existe
      const existing = await executeKw(client, db, uid, 'ir.model.fields', 'search', [
        [['model', '=', campo.modelo], ['name', '=', campo.nome]],
      ]);
      if (existing.length > 0) {
        pulados.push(campo.nome + ' (ja existe)');
        continue;
      }

      const modelId = modelIds[campo.modelo];
      if (!modelId) {
        erros.push(campo.nome + ' (modelo ' + campo.modelo + ' nao encontrado)');
        continue;
      }

      try {
        const vals = {
          name: campo.nome,
          model_id: modelId,
          field_type: campo.tipo,
          label: campo.label,
          ttype: campo.tipo,
        };
        if (campo.selecoes) {
          vals.selection = campo.selecoes;
        }
        if (campo.kwargs) {
          Object.assign(vals, campo.kwargs);
        }
        await executeKw(client, db, uid, 'ir.model.fields', 'create', [vals]);
        criados.push(campo.nome);
      } catch (e) {
        erros.push(campo.nome + ' (' + e.message + ')');
      }
    }

    res.json({ sucesso: true, criados, pulados, erros });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST — Criar Server Actions prontas
router.post('/admin/campos/server-actions', apiKeyAuth, async (req, res) => {
  // Codigo Python das Server Actions - sempre retornado para o usuario colar no Odoo Studio
  // (Odoo Online SaaS bloqueia create/write de ir.actions.server com codigo via XML-RPC)
  const codigoEmitir = `# Emitir NFS-e - Performe+ (integra middleware Vercel via polling)
# Cole este codigo no Odoo: Configuracao > Tecnico > Acoes do Servidor > Nova
#   Nome: Emitir NFS-e
#   Modelo: account.move
#   Estado: Executar codigo Python
for rec in records:
    if rec.state != 'posted':
        raise UserError('A fatura deve estar confirmada (Posted) antes de emitir a NFS-e.')
    status_atual = (rec.x_performe_nfse_status or 'vazio')
    if status_atual in ('pendente', 'processando', 'autorizada'):
        raise UserError('Esta fatura ja tem NFS-e em andamento ou emitida. Status: %s' % status_atual)
    vals = {
        'x_performe_nfse_status': 'pendente',
        'x_performe_nfse_erro': False,
        'x_performe_nfse_mensagem': False,
    }
    try:
        rec.write(vals)
    except Exception as e:
        raise UserError('Erro ao marcar fatura como pendente: %s' % str(e))`;

  const codigoCancelar = `# Cancelar NFS-e - Performe+ (integra middleware Vercel via polling)
# Cole este codigo no Odoo: Configuracao > Tecnico > Acoes do Servidor > Nova
#   Nome: Cancelar NFS-e
#   Modelo: account.move
#   Estado: Executar codigo Python
for rec in records:
    status_atual = (rec.x_performe_nfse_status or 'vazio')
    if status_atual not in ('autorizada',):
        raise UserError('Apenas NFS-e autorizadas podem ser canceladas. Status atual: %s' % status_atual)
    if not rec.x_performe_nfse_numero:
        raise UserError('Nenhuma NFS-e vinculada a esta fatura.')
    vals = {
        'x_performe_nfse_status': 'cancelar_solicitado',
        'x_performe_nfse_mensagem': 'Cancelamento solicitado via Odoo. Aguardando processamento pelo middleware.',
    }
    try:
        rec.write(vals)
    except Exception as e:
        raise UserError('Erro ao solicitar cancelamento: %s' % str(e))`;

  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    const acoes = [
      {
        nome: 'Emitir NFS-e',
        model: 'account.move',
        tipo: 'code',
        codigo: codigoEmitir,
      },
      {
        nome: 'Cancelar NFS-e',
        model: 'account.move',
        tipo: 'code',
        codigo: codigoCancelar,
      },
    ];

    const resultados = [];
    let encontrouRestricaoSaaS = false;

    for (const acao of acoes) {
      // Busca por nome exato
      let existing = [];
      try {
        existing = await executeKw(client, db, uid, 'ir.actions.server', 'search', [
          [['name', '=', acao.nome]],
        ]);
      } catch (e) {
        // Search nunca da "forbidden opcode" - se der erro aqui e outra coisa
      }

      if (existing.length > 0) {
        // Tenta atualizar (provavelmente vai falhar com forbidden opcode)
        try {
          await executeKw(client, db, uid, 'ir.actions.server', 'write', [[existing[0]], {
            state: 'code',
            code: acao.codigo,
          }]);
          resultados.push({ nome: acao.nome, status: 'atualizada', id: existing[0] });
        } catch (e) {
          // Erro esperado em Odoo SaaS: forbidden opcode(s)
          resultados.push({
            nome: acao.nome,
            status: 'manual_required',
            id: existing[0],
            erro: e.message,
            codigo_python: acao.codigo,
            instrucoes: 'Odoo Online bloqueia create/write de Server Actions com codigo via XML-RPC. Cole o codigo manualmente no Odoo Studio.',
          });
          if (/forbidden opcode|STORE_ATTR|ir\.actions\.server/i.test(e.message)) {
            encontrouRestricaoSaaS = true;
          }
        }
        continue;
      }

      // Tenta criar nova
      try {
        const id = await executeKw(client, db, uid, 'ir.actions.server', 'create', [{
          name: acao.nome,
          model_id: await getModelId(client, db, uid, acao.model),
          binding_model_id: await getModelId(client, db, uid, acao.model),
          binding_view_types: 'form',
          state: acao.tipo,
          code: acao.codigo,
        }]);
        resultados.push({ nome: acao.nome, status: 'criada', id });
      } catch (e) {
        // Erro esperado em Odoo SaaS: forbidden opcode(s)
        resultados.push({
          nome: acao.nome,
          status: 'manual_required',
          erro: e.message,
          codigo_python: acao.codigo,
          instrucoes: 'Odoo Online bloqueia create/write de Server Actions com codigo via XML-RPC. Cole o codigo manualmente no Odoo Studio.',
        });
        if (/forbidden opcode|STORE_ATTR|ir\.actions\.server/i.test(e.message)) {
          encontrouRestricaoSaaS = true;
        }
      }
    }

    res.json({
      acoes: resultados,
      saas_restriction: encontrouRestricaoSaaS,
      mensagem_saas: encontrouRestricaoSaaS
        ? 'Odoo Online bloqueia criacao/atualizacao de Server Actions via API. Cada acao abaixo tem o codigo Python pronto - abra o Odoo Studio, crie as acoes manualmente e cole o codigo.'
        : null,
      // Sempre envia codigos para o front-end ter tudo num lugar so
      codigos_prontos: {
        emitir: codigoEmitir,
        cancelar: codigoCancelar,
      },
    });
  } catch (err) {
    // Erro geral - ainda retorna os codigos pra colar manualmente
    res.status(200).json({
      erro: err.message,
      saas_restriction: /forbidden opcode|STORE_ATTR/i.test(err.message),
      codigos_prontos: {
        emitir: codigoEmitir,
        cancelar: codigoCancelar,
      },
      mensagem_saas: 'Odoo Online bloqueia operacao. Use os codigos abaixo no Odoo Studio.',
    });
  }
});

async function getModelId(client, db, uid, model) {
  const ids = await executeKw(client, db, uid, 'ir.model', 'search', [[['model', '=', model]]]);
  return ids.length > 0 ? ids[0] : 0;
}

// ==========================================================
// 2. IMPOSTOS — Push de configuracao tributaria ao Odoo
// ==========================================================

router.post('/admin/impostos/push', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });

    const {
      aliquota_iss,
      iss_retido,
      codigo_tributacao,
      c_nbs,
      descricao_servico,
      p_tot_trib_sn,
      op_simp_nac,
      reg_ap_trib_sn,
    } = req.body;

    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    const resultados = [];

    // 1. Atualiza campos da empresa (res.company)
    const companyId = (await executeKw(client, db, uid, 'res.company', 'search', [], { limit: 1 }))[0];
    if (companyId) {
      const companyUpdates = {};
      if (req.body.inscricao_municipal) {
        const camposExistentes = await executeKw(client, db, uid, 'ir.model.fields', 'search', [
          [['model', '=', 'res.company'], ['name', '=', 'x_performe_nfse_dados_prestador_im']]
        ]);
        if (camposExistentes.length) companyUpdates.x_performe_nfse_dados_prestador_im = req.body.inscricao_municipal;
      }
      if (Object.keys(companyUpdates).length) {
        await executeKw(client, db, uid, 'res.company', 'write', [[companyId], companyUpdates]);
        resultados.push('Empresa atualizada: ' + Object.keys(companyUpdates).join(', '));
      }
    }

    // 2. Atualiza produtos com campos de impostos
    if (req.body.produto_ids && req.body.produto_ids.length > 0) {
      const camposProduto = {};
      const camposDisponiveis = await executeKw(client, db, uid, 'ir.model.fields', 'search_read',
        [['model', '=', 'product.product'], ['name', 'in', ['x_performe_codigo_tributacao', 'x_performe_c_nbs', 'x_performe_aliquota_iss', 'x_performe_iss_retido', 'x_performe_descricao_nfse']]],
        { fields: ['name'] }
      );
      const cpSet = new Set(camposDisponiveis.map(f => f.name));

      if (cpSet.has('x_performe_codigo_tributacao') && codigo_tributacao) camposProduto.x_performe_codigo_tributacao = codigo_tributacao;
      if (cpSet.has('x_performe_c_nbs') && c_nbs) camposProduto.x_performe_c_nbs = c_nbs;
      if (cpSet.has('x_performe_aliquota_iss') && aliquota_iss) camposProduto.x_performe_aliquota_iss = parseFloat(aliquota_iss);
      if (cpSet.has('x_performe_iss_retido') && iss_retido) camposProduto.x_performe_iss_retido = iss_retido;
      if (cpSet.has('x_performe_descricao_nfse') && descricao_servico) camposProduto.x_performe_descricao_nfse = descricao_servico;

      if (Object.keys(camposProduto).length) {
        await executeKw(client, db, uid, 'product.product', 'write', [req.body.produto_ids, camposProduto]);
        resultados.push(req.body.produto_ids.length + ' produto(s) atualizado(s) com campos de impostos');
      }
    }

    res.json({ sucesso: true, resultados });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET — Listar produtos disponiveis para configurar impostos
router.get('/admin/impostos/produtos', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    // Verifica se campos x_performe existem
    const camposExistentes = await executeKw(client, db, uid, 'ir.model.fields', 'search_read',
      [['model', '=', 'product.product'], ['name', 'like', 'x_performe_%']],
      { fields: ['name', 'field_type', 'ttype'] }
    );

    const produtos = await executeKw(client, db, uid, 'product.product', 'search_read',
      [['sale_ok', '=', true]],
      { fields: ['id', 'name', 'default_code', 'list_price'], limit: 100, order: 'name asc' }
    );

    // Traz valores atuais dos campos x_performe
    if (camposExistentes.length > 0 && produtos.length > 0) {
      const campoNames = camposExistentes.map(f => f.name);
      const camposProduto = await executeKw(client, db, uid, 'product.product', 'read',
        [produtos.map(p => p.id)], { fields: campoNames }
      );
      const prodMap = {};
      camposProduto.forEach(p => { prodMap[p.id] = p; });
      produtos.forEach(p => {
        const data = prodMap[p.id] || {};
        p.x_performe = {};
        campoNames.forEach(c => { p.x_performe[c] = data[c] || ''; });
      });
    }

    res.json({ produtos, campos_disponiveis: camposExistentes.map(f => f.name) });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ==========================================================
// 3. DOCUMENTACAO — Dados para o frontend
// ==========================================================

router.get('/admin/docs', apiKeyAuth, async (req, res) => {
  const ibsCbs = getIbsCbsConfig();
  res.json({
    versao: '1.01',
    ambiente: config.nfse.tp_amb === 1 ? 'Producao' : 'Homologacao',
    config: {
      cidade: config.nfse.cidade,
      uf: config.nfse.uf,
      codigo_ibge: config.nfse.codigo_ibge,
      aliquota_iss: config.nfse.aliquota_iss,
      c_trib_nac: config.nfse.c_trib_nac_padrao,
      c_nbs: config.nfse.c_nbs_padrao,
      op_simp_nac: config.nfse.op_simp_nac,
      p_tot_trib_sn: config.nfse.p_tot_trib_sn,
      ver_aplic: config.nfse.ver_aplic,
      serie: config.nfse.serie,
      sefin_producao: config.sefin.producao,
      sefin_homologacao: config.sefin.homologacao,
      ibs_cbs: ibsCbs,
    },
  });
});

// ==========================================================
// 4. IBS/CBS — Configuracao Tributaria (NT 004/2025 v2.0)
// ==========================================================

// GET — Ler config IBS/CBS atual
router.get('/admin/tributacao', apiKeyAuth, async (req, res) => {
  try {
    const ibsCbs = getIbsCbsConfig();
    const meta = getMeta();
    res.json({
      sucesso: true,
      ibs_cbs: ibsCbs,
      meta: meta,
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST — Salvar config IBS/CBS
router.post('/admin/tributacao', apiKeyAuth, async (req, res) => {
  try {
    const resultado = saveIbsCbsConfig(req.body);
    res.json({
      sucesso: true,
      ibs_cbs: resultado,
      mensagem: 'Configuracao IBS/CBS salva. Nova emissao ja usara estes valores.',
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ==========================================================
// ACEL SETUP COMPLETO
// ==========================================================
// POST /api/v1/nfse/admin/performe/setup-completo
//   - Garante todos os campos x_performe_nfse_* no Odoo (account.move + res.company)
//   - Seta valor inicial 1 em x_performe_nfse_numero (res.company) em todas as empresas
//   - Atualiza (ou cria) as Server Actions "Emitir NFS-e" e "Cancelar NFS-e"
//     com codigo que dispara o polling do middleware (seta x_performe_nfse_status='pendente')
//   - Mantem compatibilidade com os campos x_nfse_* ja existentes (write em ambos)
// ==========================================================

router.post('/admin/performe/setup-completo', apiKeyAuth, async (req, res) => {
  const log = [];
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    // ----- 1. Campos x_performe_nfse_* necessarios no Odoo -----
    const camposNecessarios = [
      { modelo: 'account.move', nome: 'x_performe_nfse_status', tipo: 'selection', selecoes: "[('vazio','Vazio'),('pendente','Pendente'),('processando','Processando'),('autorizada','Autorizada'),('cancelada','Cancelada'),('cancelar_solicitado','Cancel. Solicitado'),('erro','Erro')]", label: 'NFS-e Status (Performe+)', default: 'vazio' },
      { modelo: 'account.move', nome: 'x_performe_nfse_numero', tipo: 'char', kwargs: { size: 20 }, label: 'NFS-e Numero (Performe+)' },
      { modelo: 'account.move', nome: 'x_performe_nfse_codigo_verificacao', tipo: 'char', kwargs: { size: 60 }, label: 'NFS-e Codigo Verificacao (Performe+)' },
      { modelo: 'account.move', nome: 'x_performe_nfse_protocolo', tipo: 'char', kwargs: { size: 80 }, label: 'NFS-e Protocolo (Performe+)' },
      { modelo: 'account.move', nome: 'x_performe_nfse_data_emissao', tipo: 'datetime', label: 'NFS-e Data Emissao (Performe+)' },
      { modelo: 'account.move', nome: 'x_performe_nfse_xml', tipo: 'text', label: 'NFS-e XML (Performe+)' },
      { modelo: 'account.move', nome: 'x_performe_nfse_url', tipo: 'char', kwargs: { size: 300 }, label: 'NFS-e URL (Performe+)' },
      { modelo: 'account.move', nome: 'x_performe_nfse_erro', tipo: 'boolean', label: 'NFS-e Erro (Performe+)' },
      { modelo: 'account.move', nome: 'x_performe_nfse_mensagem', tipo: 'text', label: 'NFS-e Mensagem Erro (Performe+)' },
      { modelo: 'account.move', nome: 'x_performe_nfse_dados_prestador_im', tipo: 'char', kwargs: { size: 20 }, label: 'NFS-e IM Prestador (Performe+)' },
      { modelo: 'res.company', nome: 'x_performe_nfse_numero', tipo: 'integer', label: 'NFS-e Ultimo Numero (Performe+)', help: 'Contador/sequencial de NFS-e. O middleware le este valor, soma 1 para a proxima DPS, e grava de volta.' },
      { modelo: 'res.company', nome: 'x_performe_nfse_dados_prestador_im', tipo: 'char', kwargs: { size: 20 }, label: 'NFS-e IM Prestador (Performe+)' },
    ];

    // Cache de model IDs
    const modelIds = {};
    for (const m of [...new Set(camposNecessarios.map(c => c.modelo))]) {
      const ids = await executeKw(client, db, uid, 'ir.model', 'search', [[['model', '=', m]]]);
      modelIds[m] = ids.length ? ids[0] : null;
    }

    const camposResult = [];
    for (const c of camposNecessarios) {
      const existing = await executeKw(client, db, uid, 'ir.model.fields', 'search', [[['model', '=', c.modelo], ['name', '=', c.nome]]]);
      if (existing.length) {
        camposResult.push({ campo: c.nome, modelo: c.modelo, status: 'ja_existe', id: existing[0] });
        continue;
      }
      try {
        const vals = {
          name: c.nome,
          field_description: c.label,
          model_id: modelIds[c.modelo],
          ttype: c.tipo,
          state: 'manual',
          store: true,
        };
        if (c.selecoes) vals.selection = c.selecoes;
        if (c.default) vals.default = c.default;
        if (c.help) vals.help = c.help;
        const id = await executeKw(client, db, uid, 'ir.model.fields', 'create', [vals]);
        camposResult.push({ campo: c.nome, modelo: c.modelo, status: 'criado', id });
      } catch (e) {
        camposResult.push({ campo: c.nome, modelo: c.modelo, status: 'erro', erro: e.message });
      }
    }
    log.push('Campos: ' + camposResult.filter(c => c.status === 'criado').length + ' criados, ' + camposResult.filter(c => c.status === 'ja_existe').length + ' ja existiam');

    // ----- 2. Setar x_performe_nfse_numero = 1 em todas as empresas -----
    const companyIds = await executeKw(client, db, uid, 'res.company', 'search', [[]]);
    const companies = await executeKw(client, db, uid, 'res.company', 'read', [companyIds, ['name', 'x_performe_nfse_numero']]);
    const empresasAtualizadas = [];
    for (const c of companies) {
      const atual = c.x_performe_nfse_numero || 0;
      // So seta 1 se estiver vazio/null/zero
      if (!atual) {
        await executeKw(client, db, uid, 'res.company', 'write', [[c.id], { x_performe_nfse_numero: 1 }]);
        empresasAtualizadas.push({ id: c.id, name: c.name, antes: atual, depois: 1 });
      } else {
        empresasAtualizadas.push({ id: c.id, name: c.name, antes: atual, depois: atual, status: 'ja_tinha_valor' });
      }
    }
    log.push('Empresas: ' + empresasAtualizadas.filter(e => e.depois === 1 && !e.status).length + ' setadas para 1');

    // ----- 3. Atualizar/Criar Server Actions -----
    // Codigo novo: dispara polling do middleware (seta x_performe_nfse_status='pendente')
    // e mantem compatibilidade com x_nfse_status_emissao (campo existente do cliente)
    const codigoEmitir = `# Emitir NFS-e - Performe+ (integra middleware Vercel via polling)
# Server Action criada/atualizada pelo endpoint /admin/performe/setup-completo
for rec in records:
    if rec.state != 'posted':
        raise UserError('A fatura deve estar confirmada (Posted) antes de emitir a NFS-e.')
    status_atual = (rec.x_performe_nfse_status or 'vazio')
    if status_atual in ('pendente', 'processando', 'autorizada'):
        raise UserError('Esta fatura ja tem NFS-e em andamento ou emitida. Status: %s' % status_atual)

    vals = {
        'x_performe_nfse_status': 'pendente',
        'x_performe_nfse_erro': False,
        'x_performe_nfse_mensagem': False,
    }
    # Compatibilidade com campo x_nfse_status_emissao (se existir)
    try:
        rec.write(vals)
        # Tenta escrever no campo do cliente (se existir) - safe fallback
        try:
            rec.write({'x_nfse_status_emissao': 'pendente', 'x_nfse_mensagem': False})
        except Exception:
            pass  # campo nao existe, ignora
    except Exception as e:
        raise UserError('Erro ao marcar fatura como pendente: %s' % str(e))`;

    const codigoCancelar = `# Cancelar NFS-e - Performe+ (integra middleware Vercel via polling)
# Server Action criada/atualizada pelo endpoint /admin/performe/setup-completo
for rec in records:
    status_atual = (rec.x_performe_nfse_status or 'vazio')
    if status_atual not in ('autorizada',):
        raise UserError('Apenas NFS-e autorizadas podem ser canceladas. Status atual: %s' % status_atual)
    if not rec.x_performe_nfse_numero:
        raise UserError('Nenhuma NFS-e vinculada a esta fatura.')

    vals = {
        'x_performe_nfse_status': 'cancelar_solicitado',
        'x_performe_nfse_mensagem': 'Cancelamento solicitado via Odoo. Aguardando processamento pelo middleware.',
    }
    try:
        rec.write(vals)
        # Compatibilidade com campo x_nfse_status_emissao (se existir) - safe fallback
        try:
            rec.write({'x_nfse_status_emissao': 'cancelar_solicitado', 'x_nfse_mensagem': 'Cancelamento solicitado via Odoo.'})
        except Exception:
            pass
    except Exception as e:
        raise UserError('Erro ao solicitar cancelamento: %s' % str(e))`;

    const acoes = [
      { nome: 'Emitir NFS-e', codigo: codigoEmitir },
      { nome: 'Cancelar NFS-e', codigo: codigoCancelar },
    ];

    const acoesResult = [];
    const accountMoveModelId = modelIds['account.move'];

    for (const acao of acoes) {
      // Busca por nome exato OU por ID 1041/1042 (legacy)
      let existing = await executeKw(client, db, uid, 'ir.actions.server', 'search', [
        ['|', ['name', '=', acao.nome], ['name', 'ilike', acao.nome]]
      ], { limit: 5 });

      // Tambem tenta buscar pelos IDs antigos 1041/1042
      const legacyIds = acao.nome === 'Emitir NFS-e' ? [1041] : [1042];
      const legacyById = await executeKw(client, db, uid, 'ir.actions.server', 'search', [
        [['id', 'in', legacyIds]]
      ]);
      const todosIds = [...new Set([...existing, ...legacyById])];

      if (todosIds.length === 0) {
        // Cria nova
        try {
          const id = await executeKw(client, db, uid, 'ir.actions.server', 'create', [{
            name: acao.nome,
            model_id: accountMoveModelId,
            binding_model_id: accountMoveModelId,
            binding_view_types: 'form',
            state: 'code',
            code: acao.codigo,
          }]);
          acoesResult.push({ nome: acao.nome, status: 'criada', id });
        } catch (e) {
          acoesResult.push({ nome: acao.nome, status: 'erro_criar', erro: e.message });
        }
      } else {
        // Atualiza todas as encontradas (pode ter mais de uma com nome parecido)
        for (const id of todosIds) {
          try {
            await executeKw(client, db, uid, 'ir.actions.server', 'write', [[id], {
              state: 'code',
              code: acao.codigo,
              name: acao.nome,
            }]);
            acoesResult.push({ nome: acao.nome, status: 'atualizada', id });
          } catch (e) {
            acoesResult.push({ nome: acao.nome, status: 'erro_atualizar', id, erro: e.message });
          }
        }
      }
    }
    log.push('Server Actions: ' + acoesResult.filter(a => a.status === 'atualizada' || a.status === 'criada').length + ' processadas');

    res.json({
      sucesso: true,
      log,
      campos: camposResult,
      empresas: empresasAtualizadas,
      acoes: acoesResult,
      proximos_passos: [
        '1. No Odoo, abra uma fatura de cliente (out_invoice) confirmada',
        '2. Clique em Acao > Emitir NFS-e - isso seta x_performe_nfse_status=pendente',
        '3. Aguarde 15s (polling do middleware)',
        '4. Atualize a fatura - os campos x_performe_nfse_numero, x_performe_nfse_xml, etc estarao preenchidos',
        '5. Para cancelar: Acao > Cancelar NFS-e (so funciona se status=autorizada)',
      ],
    });
  } catch (err) {
    console.error('[PERFORME-SETUP] Erro:', err.message);
    res.status(500).json({ erro: err.message, log });
  }
});

// GET /api/v1/nfse/admin/performe/status - le o status atual do setup no Odoo
router.get('/admin/performe/status', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    // 1. Lista campos x_* em account.move, res.company e res.partner
    const camposReport = {};
    for (const modelo of ['account.move', 'res.company', 'res.partner']) {
      const fields = await executeKw(client, db, uid, 'ir.model.fields', 'search_read', [
        [['model', '=', modelo], ['name', 'like', 'x_']],
        ['name', 'field_description', 'ttype'],
        0, 100,
        'name'
      ]);
      camposReport[modelo] = fields.map(f => ({ name: f.name, type: f.ttype, label: f.field_description }));
    }

    // 2. Lista Server Actions relacionadas a NFS-e
    const actions = await executeKw(client, db, uid, 'ir.actions.server', 'search_read', [
      [['name', 'ilike', 'NFS']],
      ['id', 'name', 'state'],
      0, 20,
      'id'
    ]);

    // 3. Lista empresas com TODOS os campos x_* (valores reais) - pra debugar IM
    const companyIds = await executeKw(client, db, uid, 'res.company', 'search', [[]]);
    const camposCompanyParaLer = ['name', 'vat', 'city', ...camposReport['res.company'].map(f => f.name)];
    let companies = [];
    try {
      companies = await executeKw(client, db, uid, 'res.company', 'read', [companyIds, camposCompanyParaLer]);
    } catch (e) {
      // Se falhar (algum campo nao existe), tenta so com campos basicos
      companies = await executeKw(client, db, uid, 'res.company', 'read', [companyIds, ['name', 'vat', 'city']]);
    }

    // 4. Diagnostico especifico da IM - mostra todos os campos que parecem IM
    const imDiag = companies.map(c => {
      const imFields = {};
      for (const k of Object.keys(c)) {
        if (/im|insc.*munic|prestador/i.test(k) && c[k]) {
          imFields[k] = c[k];
        }
      }
      return {
        id: c.id,
        name: c.name,
        vat: c.vat,
        city: c.city,
        imFields,
        // Mostra TODOS os campos x_* com valor != false
        xFieldsWithValue: Object.keys(c).filter(k => k.startsWith('x_') && c[k] !== false && c[k] !== null && c[k] !== '').reduce((acc, k) => { acc[k] = c[k]; return acc; }, {}),
      };
    });

    res.json({
      odoo_url: config.odoo.url,
      odoo_db: db,
      total_campos_account_move: camposReport['account.move'].length,
      total_campos_res_company: camposReport['res.company'].length,
      total_campos_res_partner: camposReport['res.partner'].length,
      tem_x_performe_nfse_status_em_account_move: camposReport['account.move'].some(f => f.name === 'x_performe_nfse_status'),
      tem_x_performe_nfse_numero_em_res_company: camposReport['res.company'].some(f => f.name === 'x_performe_nfse_numero'),
      tem_x_performe_nfse_dados_prestador_im_em_res_company: camposReport['res.company'].some(f => f.name === 'x_performe_nfse_dados_prestador_im'),
      server_actions: actions,
      diagnostico_im: imDiag,
      config_nfse_im: config.nfse.inscricao_municipal,
      empresas: companies.map(c => ({ id: c.id, name: c.name, x_performe_nfse_numero: c.x_performe_nfse_numero || 0 })),
      campos_account_move: camposReport['account.move'],
      campos_res_company: camposReport['res.company'],
      campos_res_partner: camposReport['res.partner'],
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ==========================================================
// PREVIEW DO XML DPS - gera o XML sem enviar pra SEFIN
// ==========================================================
// POST /api/v1/nfse/admin/xml/preview?move_id=2
// Retorna o XML DPS que seria enviado pra SEFIN
// ==========================================================
router.post('/admin/xml/preview', apiKeyAuth, async (req, res) => {
  try {
    if (!config.odoo.enabled) return res.json({ erro: 'Odoo nao configurado' });
    const client = createClient();
    const uid = await authenticate(client);
    const db = config.odoo.db;

    const moveId = parseInt(req.query.move_id || req.body.move_id || '0', 10);
    if (!moveId) return res.status(400).json({ erro: 'move_id obrigatorio (query ou body)' });

    // Reusa a logica de emissao mas para antes de enviar
    const { emitirNfseOdoo } = require('../services/nfse-odoo-emit');
    const { gerarXmlDPS } = require('../services/nfse-xml');

    // Carrega dados da fatura (mesma logica do nfse-odoo-emit)
    const moveFields = ['name', 'partner_id', 'company_id', 'invoice_date', 'amount_total', 'amount_untaxed', 'state', 'move_type', 'invoice_line_ids'];
    const moves = await executeKw(client, db, uid, 'account.move', 'read', [[moveId], moveFields]);
    if (!moves.length) return res.status(404).json({ erro: 'Fatura nao encontrada' });
    const move = moves[0];

    // Company - le campos disponiveis (fallback se algum nao existir)
    const companyFields = ['name', 'vat', 'city', 'state_id', 'street', 'street2', 'zip', 'phone', 'email', 'district', 'x_performe_nfse_dados_prestador_im', 'x_performe_nfse_numero'];
    let company = {};
    try {
      const companies = await executeKw(client, db, uid, 'res.company', 'read', [[move.company_id[0]], companyFields]);
      company = companies[0] || {};
    } catch (e) {
      // Tenta so com campos basicos
      const companies = await executeKw(client, db, uid, 'res.company', 'read', [[move.company_id[0]], ['name', 'vat', 'city']]);
      company = companies[0] || {};
    }

    // Partner
    const partnerFields = ['name', 'legal_name', 'vat', 'city', 'state_id', 'street', 'street2', 'zip', 'phone', 'email', 'district', 'country_id'];
    let partner = {};
    try {
      const partners = await executeKw(client, db, uid, 'res.partner', 'read', [[move.partner_id[0]], partnerFields]);
      partner = partners[0] || {};
    } catch (e) {
      const partners = await executeKw(client, db, uid, 'res.partner', 'read', [[move.partner_id[0]], ['name', 'vat']]);
      partner = partners[0] || {};
    }

    // Lines
    const lineFields = ['name', 'quantity', 'price_unit', 'price_subtotal', 'product_id', 'account_id'];
    const lines = await executeKw(client, db, uid, 'account.move.line', 'read', [move.invoice_line_ids || [], lineFields]);

    // Gera XML - precisa setar _cnpj em company e partner (igual nfse-odoo-emit faz)
    const nDPS = (company.x_performe_nfse_numero || 0) + 1;
    company._cnpj = String(company.vat || '').replace(/[^0-9]/g, '') || '06696225000100';
    partner._cnpj = String(partner.vat || '').replace(/[^0-9]/g, '');
    const { xml, infDpsId } = await gerarXmlDPS({
      move, company, partner, lines, products: {}, nDPS,
    });

    // Extrai so o bloco prest pra debug
    const prestMatch = xml.match(/<prest>[\s\S]*?<\/prest>/);
    const prestBlock = prestMatch ? prestMatch[0] : '(nao encontrado)';

    res.json({
      sucesso: true,
      move_id: moveId,
      move_name: move.name,
      nDPS_proximo: nDPS,
      infDpsId,
      xml_completo: xml,
      bloco_prest: prestBlock,
      company_im: company.x_performe_nfse_dados_prestador_im,
      config_nfse_im: config.nfse.inscricao_municipal,
    });
  } catch (err) {
    console.error('[XML-PREVIEW] Erro:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
