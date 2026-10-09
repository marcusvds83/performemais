/**
 * services/bot-odoo.js — Cliente Odoo JSON-RPC para o bot WhatsApp IA
 * ================================================================
 * Usado pelo serviço unificado performemais (NF-e + Bot) no Render.
 * 
 * Funcoes:
 *   - getUid(env): autentica no Odoo e retorna uid
 *   - searchRead(env, model, domain, fields, limit, order): busca registros
 *   - executeKw(env, model, method, args): executa metodo qualquer
 *   - sendWhatsAppReply(env, opts): cria msg outbound no Odoo (via discuss.channel)
 *   - findWaChannelForPartner(env, partnerId): busca canal WA do partner
 *   - createCrmLead(env, opts): cria lead no CRM
 *   - findLeadByPhone(env, phone): busca lead existente por telefone
 *   - updateLeadDescription(env, leadId, desc): atualiza descricao do lead
 *   - notifyPartnerChatter(env, partnerId, msg): posta no chatter do partner
 *   - convertLeadToOpportunity(env, leadId, opts): converte lead para oportunidade
 */

async function rpc(env, endpoint, params) {
  const body = {
    jsonrpc: '2.0',
    method: 'call',
    params,
    id: Date.now(),
  };
  const res = await fetch(`${env.url}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Performe+Bot/1.0',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Odoo HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.error) {
    const msg = json.error?.data?.message || json.error?.message || 'Unknown Odoo error';
    throw new Error(`Odoo: ${msg}`);
  }
  return json.result;
}

let _uidCache = new Map(); // cache por env.url+username

async function getUid(env) {
  const cacheKey = `${env.url}|${env.username}`;
  if (_uidCache.has(cacheKey)) return _uidCache.get(cacheKey);
  const uid = await rpc(env, '/jsonrpc', {
    service: 'common',
    method: 'authenticate',
    args: [env.db, env.username, env.apiKey, {}],
  });
  if (!uid || typeof uid !== 'number') {
    throw new Error('Odoo auth failed');
  }
  _uidCache.set(cacheKey, uid);
  return uid;
}

async function searchRead(env, model, domain, fields, limit = 80, order = 'id desc') {
  const uid = await getUid(env);
  const result = await rpc(env, '/jsonrpc', {
    service: 'object',
    method: 'execute',
    args: [env.db, uid, env.apiKey, model, 'search_read', domain, fields, 0, limit, order],
  });
  return result || [];
}

async function executeKw(env, model, method, args, kwargs) {
  const uid = await getUid(env);
  // IMPORTANTE: Em Odoo 19.4, execute_kw recebe args e kwargs SEPARADOS:
  //   execute_kw(db, uid, key, model, method, args_list, kwargs_dict)
  // NAO uma lista unica [args, kwargs] (que era o formato antigo)
  const body = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: kwargs
        ? [env.db, uid, env.apiKey, model, method, args, kwargs]
        : [env.db, uid, env.apiKey, model, method, args],
    },
    id: Date.now(),
  };
  const res = await fetch(`${env.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Performe+Bot/1.0' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`Odoo HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.error) {
    const msg = json.error?.data?.message || json.error?.message || 'Unknown Odoo error';
    throw new Error(`Odoo: ${msg}`);
  }
  return json.result;
}

async function sendWhatsAppReply(env, opts) {
  console.log(`[Bot-Odoo] sendWhatsAppReply partnerId=${opts.partnerId} accountId=${opts.waAccountId}`);

  // 1. Achar o canal WA do partner
  let channelId = null;
  try {
    const channels = await searchRead(env, 'discuss.channel', [
      ['channel_type', '=', 'whatsapp'],
      ['whatsapp_partner_id', '=', opts.partnerId],
    ], ['id', 'name', 'whatsapp_number'], 1, 'id asc');
    if (channels && channels.length > 0) {
      channelId = channels[0].id;
    }
  } catch (e) {
    console.log(`[Bot-Odoo] Channel search failed: ${e}`);
  }

  // 1b. Se nao tem canal, criar
  if (!channelId) {
    const phone = opts.partnerPhone || '';
    const digits = String(phone).replace(/\D/g, '');
    const name = opts.partnerName || `Partner ${opts.partnerId}`;
    const channelName = digits ? `${name} (${digits})` : name;
    const now = new Date();
    const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const validUntilStr = validUntil.toISOString().replace('T', ' ').substring(0, 19);
    try {
      const newChannelId = await executeKw(env, 'discuss.channel', 'create', [{
        name: channelName,
        channel_type: 'whatsapp',
        whatsapp_partner_id: opts.partnerId,
        whatsapp_number: digits || false,
        wa_account_id: opts.waAccountId,
        whatsapp_channel_active: true,
        whatsapp_channel_valid_until: validUntilStr,
      }]);
      channelId = Array.isArray(newChannelId) ? newChannelId[0] : newChannelId;
      console.log(`[Bot-Odoo] Created WhatsApp channel id=${channelId} for partner ${opts.partnerId}`);
    } catch (e) {
      return { ok: false, error: `Could not find or create WhatsApp channel: ${e}` };
    }
  }

  if (!channelId) {
    return { ok: false, error: `No WhatsApp channel for partner ${opts.partnerId}` };
  }

  // 2. Postar msg no canal (message_type=whatsapp_message para Odoo enviar via Meta)
  // IMPORTANTE: em Odoo 19.4, message_post(self, *, body='', ...) — so aceita kwargs!
  // Chamada: execute(db, uid, key, 'discuss.channel', 'message_post', [channelId], kwargs_dict)
  // OU: execute_kw com args=[ids, kwargs] e kwargs separados
  try {
    const uid = await getUid(env);
    // Tentativa 1: passando record_id como lista e kwargs separados (padrao Odoo 17+)
    const result = await rpc(env, '/jsonrpc', {
      service: 'object',
      method: 'execute',
      args: [
        env.db, uid, env.apiKey,
        'discuss.channel', 'message_post',
        [channelId],  // lista de record_ids
        // kwargs:
        {
          body: opts.body,
          message_type: 'whatsapp_message',
          subtype_xmlid: 'mail.mt_comment',
        },
      ],
      kwargs: {
        context: { allowed_company_ids: [1] },
      },
    });
    let messageId;
    if (Array.isArray(result) && result.length > 0) messageId = result[0];
    else if (typeof result === 'number') messageId = result;
    else if (result && typeof result === 'object') messageId = result.id || result[0];
    return { ok: true, messageId };
  } catch (e) {
    console.log(`[Bot-Odoo] message_post attempt 1 failed: ${e}`);
    // Tentativa 2: usando execute_kw com kwargs
    try {
      const uid = await getUid(env);
      const result = await rpc(env, '/jsonrpc', {
        service: 'object',
        method: 'execute_kw',
        args: [
          env.db, uid, env.apiKey,
          'discuss.channel', 'message_post',
          [channelId],
          {
            body: opts.body,
            message_type: 'whatsapp_message',
            subtype_xmlid: 'mail.mt_comment',
          },
        ],
      });
      let messageId;
      if (Array.isArray(result) && result.length > 0) messageId = result[0];
      else if (typeof result === 'number') messageId = result;
      return { ok: true, messageId };
    } catch (e2) {
      console.log(`[Bot-Odoo] message_post attempt 2 failed: ${e2}`);
      // Tentativa 3: chamar no recordset (browse) - method alternative
      try {
        const uid = await getUid(env);
        // message_post com body como kwarg explicito (sem message_type forca fallback)
        const result = await rpc(env, '/jsonrpc', {
          service: 'object',
          method: 'execute',
          args: [
            env.db, uid, env.apiKey,
            'discuss.channel', 'message_post',
            [channelId],
            { body: opts.body, message_type: 'comment', subtype_xmlid: 'mail.mt_comment' },
          ],
        });
        let messageId;
        if (Array.isArray(result) && result.length > 0) messageId = result[0];
        else if (typeof result === 'number') messageId = result;
        return { ok: true, messageId };
      } catch (e3) {
        return { ok: false, error: `message_post failed (3 attempts): ${e} | ${e2} | ${e3}` };
      }
    }
  }
}

async function createCrmLead(env, opts) {
  return executeKw(env, 'crm.lead', 'create', [{
    name: opts.name,
    partner_name: opts.partnerName || false,
    contact_name: opts.partnerName || false,
    email_from: opts.email || false,
    phone: opts.phone || false,
    type: 'lead',
    description: opts.description || '',
  }]);
}

async function findLeadByPhone(env, phoneDigits) {
  const digits = String(phoneDigits || '').replace(/\D/g, '').slice(-8);
  if (!digits) return null;
  try {
    const leads = await searchRead(env, 'crm.lead',
      [['phone', 'ilike', digits]],
      ['id', 'name', 'type', 'phone', 'description', 'partner_id'],
      1, 'create_date desc');
    if (leads && leads.length > 0) return leads[0];
    // Tenta por partner.phone
    const partners = await searchRead(env, 'res.partner',
      [['phone', 'ilike', digits]], ['id'], 1, 'id desc');
    if (partners && partners.length > 0) {
      const partnerLeads = await searchRead(env, 'crm.lead',
        [['partner_id', '=', partners[0].id]],
        ['id', 'name', 'type', 'phone', 'description', 'partner_id'],
        1, 'create_date desc');
      if (partnerLeads && partnerLeads.length > 0) return partnerLeads[0];
    }
    return null;
  } catch {
    return null;
  }
}

async function updateLeadDescription(env, leadId, description) {
  try {
    await executeKw(env, 'crm.lead', 'write', [[leadId], { description }]);
    return true;
  } catch {
    return false;
  }
}

async function notifyPartnerChatter(env, partnerId, message) {
  try {
    // message_post aceita só kwargs - usar args=[partnerId], kwargs={body,...}
    await executeKw(env, 'res.partner', 'message_post', [partnerId], {
      body: message,
      message_type: 'notification',
      subtype_xmlid: 'mail.mt_comment',
    });
    return true;
  } catch {
    return false;
  }
}

async function convertLeadToOpportunity(env, leadId, opts) {
  try {
    const vals = { type: 'opportunity' };
    const salespersonId = parseInt(process.env.PERFORME_DEFAULT_SALESPERSON_ID || '2', 10);
    if (salespersonId > 0) vals.user_id = salespersonId;
    const teamId = parseInt(process.env.PERFORME_DEFAULT_TEAM_ID || '1', 10);
    if (teamId > 0) vals.team_id = teamId;
    // Busca stage inicial
    try {
      const stages = await executeKw(env, 'crm.stage', 'search_read', [[], ['id', 'name', 'sequence'], 0, 10, 'sequence asc']);
      if (stages && stages.length > 0) vals.stage_id = stages[0].id;
    } catch (e) {
      console.log(`[Bot-Odoo] Stage lookup failed: ${e}`);
    }
    await executeKw(env, 'crm.lead', 'write', [[leadId], vals]);
    return { ok: true, opportunityId: leadId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function stripHtml(html) {
  let text = html || '';
  while (text.includes('<') && text.includes('>')) {
    const start = text.indexOf('<');
    const end = text.indexOf('>', start);
    if (end < 0) break;
    text = text.slice(0, start) + ' ' + text.slice(end + 1);
  }
  return text.split(/\s+/).join(' ').trim();
}

module.exports = {
  getUid,
  searchRead,
  executeKw,
  sendWhatsAppReply,
  createCrmLead,
  findLeadByPhone,
  updateLeadDescription,
  notifyPartnerChatter,
  convertLeadToOpportunity,
  stripHtml,
};
