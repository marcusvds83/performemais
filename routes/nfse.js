/**
 * routes/nfse.js — Rotas de emissao, cancelamento e re-anexo de NFS-e
 * ===============================================================
 * POST /api/v1/nfse/emitir          — Emitir NFS-e por move_id
 * POST /api/v1/nfse/cancelar        — Cancelar NFS-e
 * POST /api/v1/nfse/process-pending — Processar pendentes (polling/cron)
 * POST /api/v1/nfse/re-attach       — Re-anexar XML/PDF a NF ja emitida
 */

const express = require('express');
const router = express.Router();
const config = require('../config');
const { processPendingEmissions } = require('../services/nfse-odoo-emit');
const { cancelarNfse } = require('../services/nfse-cancelamento');
const { gerarPdfDanfse } = require('../services/nfse-pdf');
const { carregarCertificado } = require('../services/firebase-cert');
const { consultarNfse, baixarPdfDanfse } = require('../services/nfse-client');
const xmlrpc = require('xmlrpc');

function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ erro: 'API key invalida' });
  }
  next();
}

// === Emitir NFS-e por move_id ===
router.post('/emitir', apiKeyAuth, async (req, res) => {
  const t0 = Date.now();
  try {
    const { move_id } = req.body;
    if (!move_id) return res.status(400).json({ erro: 'move_id obrigatorio' });

    console.log('[NFSE] Emitir solicitado para move_id=' + move_id);

    // Delega para o polling processar esta fatura
    // Marca como pendente e deixa o polling pegar
    // (reaproveita toda a logica de emitirNfseOdoo)
    // Futuro: implementar emissao direta sem depender do polling

    // Por enquanto, aciona o processamento
    const resultado = await processPendingEmissions();

    res.json({
      sucesso: true,
      processadas: resultado.processed,
      duracao_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('[NFSE] Erro ao emitir:', err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === Cancelar NFS-e ===
router.post('/cancelar', apiKeyAuth, async (req, res) => {
  const t0 = Date.now();
  try {
    const { move_id, justificativa } = req.body;
    if (!move_id) {
      console.log('[NFSE-CANCEL] Rejeitado: move_id nao informado no body');
      return res.status(400).json({ erro: 'move_id obrigatorio' });
    }

    console.log('=============================================================');
    console.log('[NFSE-CANCEL] INICIO - move_id=' + move_id + ' | justificativa: ' + (justificativa || '(padrao)'));

    // 1. Le dados da fatura no Odoo
    console.log('[NFSE-CANCEL] Etapa 1/5: Lendo fatura no Odoo...');
    const result = await odooRead(move_id);
    if (!result) {
      console.log('[NFSE-CANCEL] Fatura move_id=' + move_id + ' NAO encontrada no Odoo');
      return res.status(404).json({ sucesso: false, erro: 'Fatura nao encontrada' });
    }

    const { move, company } = result;
    console.log('[NFSE-CANCEL] Fatura encontrada: ' + move.name + ' | Status NFSe: ' + (move.x_performe_nfse_status || 'vazio') + ' | NFSe numero: ' + (move.x_performe_nfse_numero || 'n/a'));

    // 2. Verifica status
    console.log('[NFSE-CANCEL] Etapa 2/5: Verificando status da NFS-e...');
    if (move.x_performe_nfse_status !== 'autorizada') {
      const statusAtual = move.x_performe_nfse_status || 'vazio';
      console.log('[NFSE-CANCEL] BLOQUEADO: Status atual e "' + statusAtual + '", precisa ser "autorizada"');
      return res.json({
        sucesso: false,
        xMotivo: 'NFS-e precisa estar autorizada. Status atual: ' + statusAtual,
      });
    }
    console.log('[NFSE-CANCEL] Status OK: autorizada');

    // 3. Cancela no SPED
    console.log('[NFSE-CANCEL] Etapa 3/5: Enviando cancelamento para SEFIN...');
    const cnpjPrest = (company ? company.cnpj_cpf || '' : '').replace(/[^0-9]/g, '');
    const just = justificativa || 'Cancelamento solicitado pelo emitente via Odoo';

    const chaveAcesso = move.x_performe_nfse_codigo_verificacao || '';
    console.log('[NFSE-CANCEL] Chave de acesso: ' + chaveAcesso);
    console.log('[NFSE-CANCEL] CNPJ prestador: ' + cnpjPrest);
    console.log('[NFSE-CANCEL] nNFSe: ' + (move.x_performe_nfse_numero || 'n/a'));

    if (!chaveAcesso) {
      console.log('[NFSE-CANCEL] BLOQUEADO: Chave de acesso vazia no campo x_performe_nfse_codigo_verificacao');
      return res.json({
        sucesso: false,
        xMotivo: 'Chave de acesso nao encontrada no Odoo (x_performe_nfse_codigo_verificacao vazio). Reemita a nota.',
      });
    }

    const resultado = await cancelarNfse({
      nNFSe: move.x_performe_nfse_numero || '',
      chaveAcesso: chaveAcesso,
      cnpjPrest,
      justificativa: just,
    });

    console.log('[NFSE-CANCEL] Retorno SEFIN: sucesso=' + resultado.sucesso + ' | cStat=' + (resultado.cStat || 'n/a') + ' | xMotivo=' + (resultado.xMotivo || ''));

    if (resultado.sucesso) {
      // 4. Atualiza Odoo
      console.log('[NFSE-CANCEL] Etapa 4/5: Atualizando status no Odoo para "cancelada"...');
      await odooWrite(move_id, {
        x_performe_nfse_status: 'cancelada',
        x_performe_nfse_erro: false,
        x_performe_nfse_mensagem: 'Cancelada: ' + (resultado.xMotivo || ''),
      });
      console.log('[NFSE-CANCEL] Status atualizado no Odoo com sucesso');

      // 5. Posta mensagem no chatter (Odoo 19 compativel - inline com TODOS campos)
      console.log('[NFSE-CANCEL] Etapa 5/5: Postando mensagem no chatter...');
      try {
        const uid = await odooAuthenticate();
        const client = odooClient();
        const execKw = (model, method, args, kwargs) => new Promise((resolve, reject) => {
          client.methodCall('execute_kw', [config.odoo.db, uid, config.odoo.api_key, model, method, args || [], kwargs || {}], (err, r) => err ? reject(err) : resolve(r));
        });

        // Busca subtype_id mt_note (Odoo 19 exige para mensagem aparecer no chatter)
        let subtypeId = false;
        try {
          const subtypes = await execKw('ir.model.data', 'search_read', [
            [['name', '=', 'mt_note'], ['module', '=', 'mail']], ['res_id'],
          ]);
          if (subtypes.length > 0) subtypeId = subtypes[0].res_id;
        } catch (e) { /* ignore */ }

        // Busca record_name (nome da fatura - Odoo 19 usa pra mostrar no chatter)
        let recordName = 'NFS-e Cancelada';
        try {
          const moves = await execKw('account.move', 'read', [[move_id], ['name']]);
          if (moves.length > 0 && moves[0].name) recordName = moves[0].name;
        } catch (e) { /* ignore */ }

        // Busca author_id (partner_id do usuario atual)
        let authorId = false;
        try {
          const users = await execKw('res.users', 'read', [[uid], ['partner_id']]);
          if (users.length > 0 && users[0].partner_id) authorId = users[0].partner_id[0];
        } catch (e) { /* ignore */ }

        // Cria mail.message com TODOS os campos Odoo 19 (sem attachment_ids - so mensagem)
        const msgBody = '<div style="background:#dcfce7;border-left:4px solid #16a34a;padding:12px;margin:8px 0;border-radius:4px">' +
          '<b style="color:#15803d">✓ NFS-e Cancelada</b><br/>' +
          '<b>Justificativa:</b> ' + just + '<br/>' +
          '<b>Resposta SEFIN:</b> ' + (resultado.xMotivo || '') + '<br/>' +
          '<b>Ambiente:</b> ' + (config.nfse.tp_amb === 1 ? 'PRODUÇÃO' : 'HOMOLOGAÇÃO') +
          '</div>';
        const msgId = await execKw('mail.message', 'create', [{
          subject: 'NFS-e Cancelada',
          model: 'account.move',
          res_id: move_id,
          record_name: recordName,
          body: msgBody,
          message_type: 'comment',
          subtype_id: subtypeId || false,
          author_id: authorId || false,
          email_from: false,
          date: new Date().toISOString().replace('T', ' ').substring(0, 19),
          is_internal: true,
        }]);
        console.log('[NFSE-CANCEL] Mensagem postada no chatter (Odoo 19): mail.message id=' + msgId);
      } catch (e) {
        console.error('[NFSE-CANCEL] Falha ao postar mensagem no chatter:', e.message);
      }
    } else {
      console.log('[NFSE-CANCEL] Cancelamento NEGADO pela SEFIN. Nao foi atualizado o status no Odoo.');
    }

    const duracao = Date.now() - t0;
    console.log('[NFSE-CANCEL] FIM - duracao: ' + duracao + 'ms | resultado: ' + (resultado.sucesso ? 'SUCESSO' : 'FALHA'));
    console.log('=============================================================');

    res.json(resultado);
  } catch (err) {
    console.error('[NFSE-CANCEL] ERRO FATAL:', err.stack || err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === Processar pendentes (polling / cron) ===
router.post('/process-pending', apiKeyAuth, async (req, res) => {
  console.log('[NFSE] process-pending chamado');
  try {
    const resultado = await processPendingEmissions();
    res.json({
      sucesso: true,
      processadas: resultado.processed,
      detalhes: resultado.detalhes || [],
    });
  } catch (err) {
    console.error('[NFSE] Erro process-pending:', err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// === Helpers Odoo ===
function odooClient() {
  const url = config.odoo.url.replace(/\/+$/, '');
  const host = url.replace('https://', '').replace('http://', '');
  const port = url.startsWith('https') ? 443 : 80;
  const fn = url.startsWith('https') ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return fn({ host, path: '/xmlrpc/2/object', port });
}

function odooAuthClient() {
  const url = config.odoo.url.replace(/\/+$/, '');
  const host = url.replace('https://', '').replace('http://', '');
  const port = url.startsWith('https') ? 443 : 80;
  const fn = url.startsWith('https') ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return fn({ host, path: '/xmlrpc/2/common', port });
}

async function odooAuthenticate() {
  const client = odooAuthClient();
  return new Promise((resolve, reject) => {
    client.methodCall('authenticate', [config.odoo.db, config.odoo.user, config.odoo.api_key, {}], (err, uid) => {
      if (err || !uid) reject(new Error('Auth falhou'));
      else resolve(uid);
    });
  });
}

async function odooRead(moveId) {
  const uid = await odooAuthenticate();
  const client = odooClient();
  return new Promise((resolve, reject) => {
    client.methodCall('execute_kw', [config.odoo.db, uid, config.odoo.api_key, 'account.move', 'read', [[moveId]], {
      fields: ['name', 'partner_id', 'company_id', 'x_performe_nfse_status', 'x_performe_nfse_numero',
               'x_performe_nfse_codigo_verificacao', 'x_performe_nfse_protocolo'],
    }], (err, moves) => {
      if (err) reject(err);
      else if (!moves || !moves.length) resolve(null);
      else {
        const move = moves[0];
        // Le empresa
        const c = odooClient();
        c.methodCall('execute_kw', [config.odoo.db, uid, config.odoo.api_key, 'res.company', 'read',
          [[move.company_id[0]]], { fields: ['name', 'cnpj_cpf'] }], (e, companies) => {
          if (e) resolve({ move });
          else resolve({ move, company: companies[0] });
        });
      }
    });
  });
}

async function odooWrite(moveId, data) {
  const uid = await odooAuthenticate();
  const client = odooClient();
  return new Promise((resolve, reject) => {
    client.methodCall('execute_kw', [config.odoo.db, uid, config.odoo.api_key, 'account.move', 'write', [[moveId], data]], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// === Re-anexar XML/PDF a NF ja emitida ===
// Aceita move_id (Odoo internal ID) OU nfse_numero (numero da NFS-e como 91)
router.post('/re-attach', apiKeyAuth, async (req, res) => {
  try {
    let { move_id, nfse_numero, chave_acesso } = req.body;

    const uid = await odooAuthenticate();
    const client = odooClient();

    // Se nao tem move_id, busca pelo numero da NFS-e
    if (!move_id && nfse_numero) {
      console.log('[NFSE-RE-ATTACH] Buscando por nfse_numero=' + nfse_numero);
      const ids = await new Promise((resolve, reject) => {
        client.methodCall('execute_kw', [config.odoo.db, uid, config.odoo.api_key, 'account.move', 'search', [
          [['x_performe_nfse_numero', '=', String(nfse_numero)]]
        ]], (err, ids) => err ? reject(err) : resolve(ids));
      });
      if (!ids || !ids.length) {
        return res.status(404).json({ erro: 'Nenhuma fatura encontrada com x_performe_nfse_numero=' + nfse_numero });
      }
      move_id = ids[0];
      console.log('[NFSE-RE-ATTACH] Encontrado move_id=' + move_id);
    }

    if (!move_id) return res.status(400).json({ erro: 'move_id ou nfse_numero obrigatorio' });
    console.log('[NFSE-RE-ATTACH] move_id=' + move_id);

    // 1. Le a fatura
    const moves = await new Promise((resolve, reject) => {
      client.methodCall('execute_kw', [config.odoo.db, uid, config.odoo.api_key, 'account.move', 'read', [[move_id]], {
        fields: ['name', 'x_performe_nfse_status', 'x_performe_nfse_numero', 'x_performe_nfse_codigo_verificacao', 'x_performe_nfse_xml'],
      }], (err, result) => err ? reject(err) : resolve(result));
    });

    if (!moves || !moves.length) return res.status(404).json({ erro: 'Fatura nao encontrada com move_id=' + move_id });
    const move = moves[0];
    console.log('[NFSE-RE-ATTACH] Fatura: ' + move.name + ' Status: ' + move.x_performe_nfse_status);

    const chave = chave_acesso || move.x_performe_nfse_codigo_verificacao || '';
    const numNF = move.x_performe_nfse_numero || '?';
    let nfseXml = move.x_performe_nfse_xml || '';

    // 2. Se tem a chave, consulta a SEFIN para pegar o XML completo
    if (chave && !nfseXml) {
      console.log('[NFSE-RE-ATTACH] Consultando SEFIN pela chave: ' + chave);
      const cert = await carregarCertificado();
      if (cert) {
        const consulta = await consultarNfse(chave, cert);
        if (consulta.sucesso && consulta.dados && consulta.dados.nfseXml) {
          nfseXml = consulta.dados.nfseXml;
          console.log('[NFSE-RE-ATTACH] XML obtido da SEFIN: ' + nfseXml.length + ' bytes');
        }
      }
    }

    if (!nfseXml) {
      return res.json({ sucesso: false, erro: 'XML da NFS-e nao disponivel (nem no Odoo, nem na SEFIN)' });
    }

    // 3. Upload XML - usa criarAttachmentCompativel (Odoo 19: db_datas em vez de datas)
    try {
      const xmlNome = 'NFS-e-' + String(numNF).padStart(6, '0') + '.xml';
      const xmlB64 = Buffer.from(nfseXml, 'utf-8').toString('base64');
      const { criarAttachmentCompativel } = require('../services/nfse-odoo-emit');
      const execKw = (model, method, args, kwargs) => new Promise((resolve, reject) => {
        client.methodCall('execute_kw', [config.odoo.db, uid, config.odoo.api_key, model, method, args || [], kwargs || {}], (err, r) => err ? reject(err) : resolve(r));
      });
      // Helper que simula executeKw do nfse-odoo-emit
      const fakeExecuteKw = (model, method, args, kwargs) => execKw(model, method, args, kwargs);
      // Descobre campo de conteudo (datas vs db_datas) via fields_get
      let campoConteudo = 'datas';
      try {
        const fieldsInfo = await execKw('ir.attachment', 'fields_get', []);
        const campos = Object.keys(fieldsInfo);
        if (!campos.includes('datas')) {
          if (campos.includes('db_datas')) campoConteudo = 'db_datas';
          else if (campos.includes('raw')) campoConteudo = 'raw';
          else campoConteudo = 'db_datas';
          console.log('[NFSE-RE-ATTACH] Odoo 19: usando campo ' + campoConteudo + ' (datas removido)');
        }
      } catch (e) { /* default datas */ }
      const attachId = await execKw('ir.attachment', 'create', [{
        name: xmlNome,
        res_model: 'account.move', res_id: move_id, mimetype: 'application/xml',
        [campoConteudo]: xmlB64,
      }]);
      console.log('[NFSE-RE-ATTACH] ir.attachment criado (XML): id=' + attachId + ' (campo=' + campoConteudo + ')');
      const body = '<b>XML NFS-e ' + numNF + '</b> (re-anexado)';
      // Cria mail.message com TODOS os campos Odoo 19
      let subtypeId = false;
      try {
        const subtypes = await execKw('ir.model.data', 'search_read', [[['name', '=', 'mt_note'], ['module', '=', 'mail']], ['res_id']]);
        if (subtypes.length > 0) subtypeId = subtypes[0].res_id;
      } catch (e) {}
      let recordName = 'NFS-e ' + numNF;
      try {
        const moves = await execKw('account.move', 'read', [[move_id], ['name']]);
        if (moves.length > 0 && moves[0].name) recordName = moves[0].name;
      } catch (e) {}
      let authorId = false;
      try {
        const users = await execKw('res.users', 'read', [[uid], ['partner_id']]);
        if (users.length > 0 && users[0].partner_id) authorId = users[0].partner_id[0];
      } catch (e) {}
      const msgId = await execKw('mail.message', 'create', [{
        subject: xmlNome,
        model: 'account.move', res_id: move_id,
        record_name: recordName,
        body: body,
        message_type: 'comment',
        subtype_id: subtypeId || false,
        author_id: authorId || false,
        email_from: false,
        attachment_ids: [[6, 0, [attachId]]],
        date: new Date().toISOString().replace('T', ' ').substring(0, 19),
        is_internal: true,
      }]);
      console.log('[NFSE-RE-ATTACH] mail.message criada (id=' + msgId + ') - mensagem interna com XML ' + xmlNome);
      console.log('[NFSE-RE-ATTACH] XML anexado: ' + xmlNome + ' (attach_id=' + attachId + ')');
    } catch (e) {
      console.error('[NFSE-RE-ATTACH] Falha XML:', e.message);
    }

    // 4. Gera e upload PDF (PDFKit Performe+ com logo)
    try {
      const pdfNome = 'DANFSe-' + String(numNF).padStart(6, '0') + '.pdf';
      let pdfBuf = null;

      // 4a. Baixa DANFSe do painel admin (mesmo PDF que aparece no /painel)
      console.log('[NFSE-RE-ATTACH] 4a. Baixando DANFSe do painel admin...');
      try {
        const { baixarPdfDoPainel } = require('../services/nfse-odoo-emit');
        pdfBuf = await baixarPdfDoPainel(move_id);
      } catch (eLocal) {
        console.error('[NFSE-RE-ATTACH] FALHA ao baixar DANFSe do painel: ' + eLocal.message);
        // Fallback: gera localmente
        console.log('[NFSE-RE-ATTACH] Tentando gerar PDF localmente como fallback...');
        try {
          pdfBuf = await gerarPdfDanfse(nfseXml);
        } catch (e2) {
          console.error('[NFSE-RE-ATTACH] Fallback tambem falhou: ' + e2.message);
        }
      }

      // 4b. Anexa o PDF usando mail.message.create com TODOS campos Odoo 19
      if (pdfBuf && pdfBuf.length > 0) {
        const pdfB64 = pdfBuf.toString('base64');
        const header = pdfBuf.slice(0, 8).toString('ascii');
        console.log('[NFSE-RE-ATTACH] 4b. Anexando PDF: ' + pdfNome + ' (' + pdfBuf.length + ' bytes, b64=' + pdfB64.length + ' chars, header="' + header + '")');
        const execKw = (model, method, args, kwargs) => new Promise((resolve, reject) => {
          client.methodCall('execute_kw', [config.odoo.db, uid, config.odoo.api_key, model, method, args || [], kwargs || {}], (err, r) => err ? reject(err) : resolve(r));
        });
        // Odoo 19: campo 'datas' removido - detecta campo correto via fields_get
        let campoConteudo = 'datas';
        try {
          const fieldsInfo = await execKw('ir.attachment', 'fields_get', []);
          const campos = Object.keys(fieldsInfo);
          if (!campos.includes('datas')) {
            campoConteudo = campos.includes('db_datas') ? 'db_datas' : (campos.includes('raw') ? 'raw' : 'db_datas');
            console.log('[NFSE-RE-ATTACH] Odoo 19: usando campo ' + campoConteudo + ' para PDF');
          }
        } catch (e) {}
        const attachId = await execKw('ir.attachment', 'create', [{
          name: pdfNome,
          res_model: 'account.move',
          res_id: move_id,
          mimetype: 'application/pdf',
          [campoConteudo]: pdfB64,
        }]);
        console.log('[NFSE-RE-ATTACH] ir.attachment criado (PDF): id=' + attachId + ' (campo=' + campoConteudo + ', ' + Math.round(pdfB64.length * 0.75) + ' bytes)');



        const body = '<b>DANFSe ' + numNF + '</b> - re-anexado';
        // Cria mail.message com TODOS os campos Odoo 19
        let subtypeId = false;
        try {
          const subtypes = await execKw('ir.model.data', 'search_read', [[['name', '=', 'mt_note'], ['module', '=', 'mail']], ['res_id']]);
          if (subtypes.length > 0) subtypeId = subtypes[0].res_id;
        } catch (e) {}
        let recordName = 'DANFSe ' + numNF;
        try {
          const moves = await execKw('account.move', 'read', [[move_id], ['name']]);
          if (moves.length > 0 && moves[0].name) recordName = moves[0].name;
        } catch (e) {}
        let authorId = false;
        try {
          const users = await execKw('res.users', 'read', [[uid], ['partner_id']]);
          if (users.length > 0 && users[0].partner_id) authorId = users[0].partner_id[0];
        } catch (e) {}
        const msgId = await execKw('mail.message', 'create', [{
          subject: pdfNome,
          model: 'account.move', res_id: move_id,
          record_name: recordName,
          body: body,
          message_type: 'comment',
          subtype_id: subtypeId || false,
          author_id: authorId || false,
          email_from: false,
          attachment_ids: [[6, 0, [attachId]]],
          date: new Date().toISOString().replace('T', ' ').substring(0, 19),
          is_internal: true,
        }]);
        console.log('[NFSE-RE-ATTACH] mail.message criada (id=' + msgId + ') - mensagem interna com PDF ' + pdfNome);
        console.log('[NFSE-RE-ATTACH] PDF anexado: ' + pdfNome + ' (attach_id=' + attachId + ')');
      } else {
        console.error('[NFSE-RE-ATTACH] NENHUM PDF disponivel para anexar.');
      }
    } catch (e) {
      console.error('[NFSE-RE-ATTACH] Falha geral PDF:', e.message);
    }

    res.json({ sucesso: true, mensagem: 'Re-anexo concluido para ' + move.name });
  } catch (err) {
    console.error('[NFSE-RE-ATTACH] Erro:', err.message);
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

module.exports = router;