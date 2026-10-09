/**
 * routes/bot.js — Rotas do Bot WhatsApp IA Performe+
 * ====================================================
 * Montado em /bot no Express server.js
 * 
 * Endpoints:
 *   GET  /bot/health                          — Health check do bot
 *   POST /bot/whatsapp-on-create               — Chamado pela base.automation #22 do Odoo
 *   GET  /bot/whatsapp-webhook                 — Verificacao do Meta (nao usado neste fluxo)
 *   POST /bot/whatsapp-webhook                 — Recebe webhook do Meta (nao usado neste fluxo)
 *   POST /bot/cron-check-inactivity            — Cron para criar oportunidades
 *   POST /bot/redrive-search                   — Busca contato Redrive por phone/email
 *   POST /bot/redrive-update-odoo              — Busca Redrive + atualiza partner/lead no Odoo
 *   POST /bot/redrive-upload-history           — Upload PDF/txt de conversa -> posta como attachment no chatter Odoo
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB
const { getUid, searchRead, executeKw, sendWhatsAppReply, createCrmLead, findLeadByPhone, updateLeadDescription, convertLeadToOpportunity, stripHtml } = require('../services/bot-odoo');
const { replyWhatsApp } = require('../services/bot-ai');
const redrive = require('../services/redrive');

// === Helpers ===
function getOdooEnv() {
  const url = (process.env.ODOO_URL || '').replace(/\/$/, '');
  const db = process.env.ODOO_DB || '';
  const username = process.env.ODOO_USERNAME || process.env.ODOO_USER || '';
  const apiKey = process.env.ODOO_API_KEY || '';
  if (!url || !db || !username || !apiKey) {
    throw new Error('Missing Odoo env vars (ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY)');
  }
  return { url, db, username, apiKey };
}

// === Health ===
router.get('/health', (req, res) => {
  const required = ['ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_API_KEY', 'GEMINI_API_KEY', 'WHATSAPP_VERIFY_TOKEN'];
  const missing = required.filter(v => !process.env[v]);
  res.json({
    ok: missing.length === 0,
    service: 'performe-bot',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    env: {
      odooConfigured: !!process.env.ODOO_URL,
      odooDb: process.env.ODOO_DB ? '(set)' : '(missing)',
      geminiKey: process.env.GEMINI_API_KEY ? '(set)' : '(missing)',
      whatsappToken: process.env.WHATSAPP_VERIFY_TOKEN ? '(set)' : '(missing)',
      operatorIds: process.env.PERFORME_OPERATOR_USER_IDS || '2,5 (default)',
      missing: missing.length === 0 ? null : missing,
    },
  });
});

// === POST /bot/whatsapp-on-create ===
// Chamado pela base.automation #22 do Odoo quando msg WA chega.
// Payload: { _action, _id, _model, id, body, mail_message_id, wa_account_id, mobile_number, message_type, state, create_date }
router.post('/whatsapp-on-create', async (req, res) => {
  let payload = req.body || {};
  console.log(`[Bot-OnCreate] msg id=${payload.id} mobile=${payload.mobile_number} body="${(payload.body || '').slice(0, 60)}"`);

  // Filtra: so processa msgs inbound
  if (payload.message_type && payload.message_type !== 'inbound') {
    return res.json({ ok: true, skipped: 'not inbound' });
  }

  try {
    const env = getOdooEnv();

    // 1. Buscar author_id via mail_message_id
    let authorId = 0;
    let authorName = '';
    let channelId = null;
    try {
      const mm = await searchRead(env, 'mail.message',
        [['id', '=', payload.mail_message_id]],
        ['id', 'author_id', 'model', 'res_id'], 1);
      if (mm && mm.length > 0) {
        const authorArr = mm[0].author_id;
        if (Array.isArray(authorArr)) {
          authorId = authorArr[0];
          authorName = authorArr[1] || '';
        }
        if (mm[0].model === 'discuss.channel' && mm[0].res_id) {
          channelId = mm[0].res_id;
        }
      }
    } catch (e) {
      console.log(`[Bot-OnCreate] mail.message lookup failed: ${e}`);
    }

    if (!authorId) {
      console.log(`[Bot-OnCreate] No author found for msg ${payload.id}`);
      return res.json({ ok: false, error: 'no author' });
    }

    // 2. Verifica se autor e operador (nao responde a si mesmo)
    const operatorIdsStr = process.env.PERFORME_OPERATOR_USER_IDS || '2,5';
    const operatorIds = operatorIdsStr.split(',').map(x => parseInt(x.trim(), 10)).filter(Boolean);
    let isOperator = false;
    try {
      const opUsers = await searchRead(env, 'res.users',
        [['id', 'in', operatorIds]],
        ['id', 'name', 'partner_id'], 10);
      for (const op of opUsers) {
        const pId = Array.isArray(op.partner_id) ? op.partner_id[0] : op.partner_id;
        if (pId === authorId) {
          isOperator = true;
          break;
        }
      }
    } catch (e) {
      console.log(`[Bot-OnCreate] operator lookup failed: ${e}`);
    }

    if (isOperator) {
      console.log(`[Bot-OnCreate] Author is operator — skip`);
      return res.json({ ok: true, skipped: 'operator' });
    }

    // 3. Limpar body
    const text = stripHtml(payload.body || '');

    // 4. Verificar handoff
    const handoffWordsStr = process.env.PERFORME_HANDOFF_WORDS || 'humano,atendente,operador,falar com pessoa';
    const handoffWords = handoffWordsStr.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
    const wantsHuman = handoffWords.some(w => text.toLowerCase().includes(w));

    if (wantsHuman) {
      console.log(`[Bot-OnCreate] Handoff solicitado`);
      try {
        await executeKw(env, 'res.partner', 'message_post', [
          [authorId],
          {
            body: `<p><b>🔔 Handoff solicitado via WhatsApp</b></p><p><b>Cliente:</b> ${authorName || '-'}</p><p><b>Mensagem:</b> ${text.slice(0, 500)}</p><p>Um operador humano precisa assumir esta conversa.</p>`,
            message_type: 'notification',
            subtype_xmlid: 'mail.mt_comment',
          },
        ]);
      } catch (e) {
        console.log(`[Bot-OnCreate] Handoff notify failed: ${e}`);
      }
      return res.json({ ok: true, action: 'handoff' });
    }

    // 5. Buscar historico + verifica se humano respondeu nas ultimas 2h
    let historyText = '';
    let humanRepliedRecently = false;
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const nowMs = Date.now();
    if (channelId) {
      try {
        const channelMsgs = await searchRead(env, 'mail.message',
          [['model', '=', 'discuss.channel'], ['res_id', '=', channelId]],
          ['id', 'body', 'author_id', 'create_date', 'message_type'],
          24, 'create_date asc');
        const systemPartnerIds = [3, 22, 23, 553, 68865];
        for (const m of channelMsgs) {
          const authorArr = m.author_id;
          const mAuthorId = Array.isArray(authorArr) ? authorArr[0] : 0;
          const role = mAuthorId === authorId ? 'Cliente' : (systemPartnerIds.includes(mAuthorId) ? 'Bot' : 'Operador');
          const mtext = stripHtml(m.body || '');
          if (mtext) historyText += `${role}: ${mtext}\n`;
          if (role === 'Operador') {
            try {
              const dt = new Date((m.create_date || '').replace(' ', 'T') + 'Z');
              if (nowMs - dt.getTime() < TWO_HOURS_MS) {
                humanRepliedRecently = true;
              }
            } catch {}
          }
        }
      } catch (e) {
        console.log(`[Bot-OnCreate] history lookup failed: ${e}`);
      }
    }

    // Se humano respondeu nas ultimas 2h, bot fica em silencio
    if (humanRepliedRecently) {
      console.log(`[Bot-OnCreate] Human replied in last 2h — bot staying silent`);
      return res.json({ ok: true, skipped: 'human_replied_recently' });
    }

    // 6. Construir mensagens para Gemini
    const history = [];
    if (historyText) {
      const lines = historyText.split('\n').filter(Boolean);
      for (const line of lines) {
        const m = line.match(/^(Cliente|Bot|Operador):\s*(.*)$/);
        if (m) {
          const role = m[1] === 'Cliente' ? 'user' : 'assistant';
          history.push({ role, content: m[2] });
        }
      }
    }
    if (history.length === 0 || history[history.length - 1].content !== text) {
      history.push({ role: 'user', content: text });
    }

    // 7. Gerar resposta IA
    console.log(`[Bot-OnCreate] Calling Gemini (history len=${history.length})...`);
    const botReply = await replyWhatsApp(env, {
      messages: history,
      channel: 'whatsapp',
      contactName: authorName,
    });
    console.log(`[Bot-OnCreate] Reply generated (len=${botReply.content.length})`);

    // 8. Enviar resposta via Odoo
    const result = await sendWhatsAppReply(env, {
      partnerId: authorId,
      body: botReply.content,
      waAccountId: payload.wa_account_id,
      partnerName: authorName,
    });

    if (result.ok) {
      console.log(`[Bot-OnCreate] Reply sent OK (msgId=${result.messageId})`);
    } else {
      console.error(`[Bot-OnCreate] Reply FAILED: ${result.error}`);
    }

    return res.json({
      ok: result.ok,
      messageId: result.messageId,
      error: result.error,
      leadCreated: botReply.leadCreated,
      authorId,
      authorName,
      channelId,
    });
  } catch (err) {
    console.error(`[Bot-OnCreate] Error: ${err}`);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// === GET /bot/whatsapp-webhook (Meta verification) ===
router.get('/whatsapp-webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'performe-bot-verify';
  if (mode === 'subscribe' && token === verifyToken) {
    return res.status(200).send(challenge || '');
  }
  return res.status(403).send('Forbidden');
});

// === POST /bot/whatsapp-webhook (Meta inbound — fallback, nao usado neste fluxo) ===
router.post('/whatsapp-webhook', async (req, res) => {
  // Forward para Odoo nativo (igual ao Next.js bot fazia)
  const rawBody = JSON.stringify(req.body);
  try {
    const odooWebhookUrl = process.env.ODOO_WEBHOOK_FORWARD_URL || 'https://www.performemais.com/whatsapp/webhook';
    fetch(odooWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    }).catch(() => {});
  } catch (e) {}

  // Processa igual ao /bot/whatsapp-on-create mas com payload do Meta
  // (Este endpoint e usado so se o Meta apontar direto para o bot,
  // o que nao e o caso atual — Odoo e o primario)
  try {
    const payload = req.body || {};
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value.messages || [];
        const contacts = change.value.contacts || [];
        for (const msg of messages) {
          if (msg.type !== 'text' || !msg.text?.body) continue;
          const phone = msg.from;
          const contactName = contacts.find(c => c.wa_id === phone)?.profile?.name;
          const text = msg.text.body;
          // Nao processamos aqui — Odoo nativo vai criar a msg e disparar automation
        }
      }
    }
  } catch (e) {}

  return res.json({ ok: true });
});

// === POST /bot/cron-check-inactivity ===
// Cron externo (cron-job.org) chama a cada 10 min para criar oportunidades de conversas abandonadas
router.post('/cron-check-inactivity', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const expectedToken = `Bearer ${process.env.CRON_SECRET || 'performe-cron-secret-2024'}`;
  if (authHeader !== expectedToken) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  console.log('[Bot-Cron] Starting inactivity check...');
  try {
    const env = getOdooEnv();
    const INACTIVITY_MINUTES = 10;
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - INACTIVITY_MINUTES * 60 * 1000);

    // 1. Buscar todos WhatsApp channels
    const channels = await searchRead(env, 'discuss.channel',
      [['channel_type', '=', 'whatsapp']],
      ['id', 'name', 'whatsapp_partner_id', 'whatsapp_number', 'wa_account_id'],
      100, 'id asc');
    console.log(`[Bot-Cron] Found ${channels.length} WhatsApp channels`);

    let leadsCreated = 0;
    let oppsCreated = 0;
    let messagesSent = 0;

    for (const channel of channels) {
      const channelId = channel.id;
      const partnerInfo = channel.whatsapp_partner_id;
      const partnerId = Array.isArray(partnerInfo) ? partnerInfo[0] : partnerInfo;
      const partnerName = Array.isArray(partnerInfo) ? partnerInfo[1] : 'Cliente';
      const phone = channel.whatsapp_number || '';
      if (!partnerId) continue;

      // 2. Buscar msgs do canal
      const messages = await searchRead(env, 'mail.message',
        [['model', '=', 'discuss.channel'], ['res_id', '=', channelId]],
        ['id', 'body', 'author_id', 'create_date', 'message_type'],
        50, 'create_date asc');
      if (messages.length < 2) continue;

      // 3. Verificar se ja existe opportunity nos ultimos 7 dias
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const sevenDaysAgoStr = sevenDaysAgo.toISOString().replace('T', ' ').substring(0, 19);
      const existingOpps = await searchRead(env, 'crm.lead',
        [['partner_id', '=', partnerId], ['type', '=', 'opportunity'], ['create_date', '>=', sevenDaysAgoStr]],
        ['id', 'name'], 1, 'id desc');
      if (existingOpps.length > 0) continue;

      // 4. Ultima msg
      const lastMessage = messages[messages.length - 1];
      const lastMessageDate = new Date((lastMessage.create_date || '').replace(' ', 'T') + 'Z');
      if (lastMessageDate > cutoffTime) continue;

      const operatorPartnerIds = [3, 22, 23, 553, 68865];

      // 5. Transcript
      const transcript = messages.map(m => {
        const mAuthorArr = m.author_id || [];
        const mAuthorId = Array.isArray(mAuthorArr) ? mAuthorArr[0] : 0;
        const mAuthorName = Array.isArray(mAuthorArr) ? mAuthorArr[1] : 'Desconhecido';
        const role = operatorPartnerIds.includes(mAuthorId) ? 'Bot/Operador' : 'Cliente';
        const body = stripHtml(m.body || '');
        return `[${m.create_date}] ${role} (${mAuthorName}): ${body}`;
      }).join('\n');

      // 6. Extrair info
      const emailMatch = transcript.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      const phoneMatch = transcript.match(/\+?\d[\d\s\-()]{7,}\d/);
      const nameMatch = transcript.match(/(?:meu nome é|me chamo|sou o|sou a|nome[:\s]+)\s+([A-Za-zÀ-ú][A-Za-zÀ-ú\s]{2,40})/i);
      const extractedName = nameMatch ? nameMatch[1].trim().split(/\s+/).slice(0, 4).join(' ') : partnerName;

      // 7. Buscar lead existente
      let leadId = null;
      try {
        const existingLead = await findLeadByPhone(env, phoneMatch?.[0] || phone || '');
        if (existingLead) {
          const oldDesc = existingLead.description || '';
          const newDesc = `${oldDesc}\n\n--- Conversa finalizada (${now.toISOString()}) ---\n${transcript.slice(0, 2000)}`;
          await updateLeadDescription(env, existingLead.id, newDesc);
          leadId = existingLead.id;
        }
      } catch (e) {}

      // 8. Criar lead se nao existir
      if (!leadId) {
        try {
          leadId = await createCrmLead(env, {
            name: `Conversa WhatsApp — ${extractedName}`,
            partnerName: extractedName,
            email: emailMatch?.[0],
            phone: phoneMatch?.[0] || `+${phone}`,
            description: `Conversa finalizada após 10 min de inatividade no WhatsApp.\n\nCliente: ${extractedName}\nTelefone: ${phoneMatch?.[0] || '+' + phone || '—'}\nE-mail: ${emailMatch?.[0] || '—'}\n\nTranscrição:\n${transcript.slice(0, 2000)}`,
          });
          leadsCreated++;
        } catch (e) {
          continue;
        }
      }

      // 9. Converter para oportunidade
      if (leadId) {
        const oppResult = await convertLeadToOpportunity(env, leadId, {
          partnerName: extractedName,
          partnerId,
          phone: phoneMatch?.[0] || phone,
          email: emailMatch?.[0],
          transcript,
        });
        if (oppResult.ok) oppsCreated++;
      }

      // 10. Enviar thank you
      try {
        const thankYouMessage = `Olá, ${extractedName}! 👋\n\nAgradecemos muito pela sua conversa conosco. Registramos seu interesse aqui na Performe+ e um de nossos especialistas entrará em contato em até 1 dia útil para continuar o atendimento.\n\nCaso precise de algo urgente, responda "humano" que te conectamos com nossa equipe agora mesmo.\n\nAté logo!`;
        const waAccountArr = channel.wa_account_id;
        const waAccountId = Array.isArray(waAccountArr) ? waAccountArr[0] : waAccountArr || 1;
        const result = await sendWhatsAppReply(env, {
          partnerId,
          body: thankYouMessage,
          waAccountId,
          partnerName: extractedName,
          partnerPhone: phone,
        });
        if (result.ok) messagesSent++;
      } catch (e) {}
    }

    console.log(`[Bot-Cron] Done. Leads: ${leadsCreated}, opportunities: ${oppsCreated}, msgs: ${messagesSent}`);
    return res.json({
      ok: true,
      checked_channels: channels.length,
      leads_created: leadsCreated,
      opportunities_created: oppsCreated,
      messages_sent: messagesSent,
      cutoff_minutes: INACTIVITY_MINUTES,
    });
  } catch (err) {
    console.error('[Bot-Cron] Error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// === GET /bot/cron-check-inactivity (alias para testar no browser) ===
router.get('/cron-check-inactivity', (req, res) => {
  // So responde ok se for chamado sem auth (para teste)
  // Para executar de verdade, use POST com Bearer token
  res.json({
    endpoint: 'POST /bot/cron-check-inactivity',
    description: 'Cron para criar oportunidades de conversas abandonadas',
    auth: 'Bearer CRON_SECRET',
  });
});

// ============================================================
// === REDRIVE INTEGRATION ====================================
// ============================================================

// === POST /bot/redrive-search ===
// Busca contato Redrive por phone/email/firstname/etc.
// Body: { phone: "5599999999999" } OU { email: "..." } OU { firstname: "..." }
router.post('/redrive-search', async (req, res) => {
  try {
    const query = req.body || {};
    console.log(`[Bot-Redrive] search: ${JSON.stringify(query)}`);
    const results = await redrive.searchContact(query);
    return res.json({ ok: true, count: results.length, results });
  } catch (err) {
    console.error('[Bot-Redrive] search error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// === POST /bot/redrive-update-odoo ===
// Busca contato Redrive + atualiza partner/lead no Odoo
// Body: { phone: "5599999999999", model: "res.partner" | "crm.lead", record_id: 123 }
router.post('/redrive-update-odoo', async (req, res) => {
  try {
    const { phone, email, model = 'res.partner', record_id } = req.body || {};
    console.log(`[Bot-Redrive] update-odoo: phone=${phone} email=${email} model=${model} record_id=${record_id}`);

    if (!record_id) {
      return res.status(400).json({ ok: false, error: 'record_id obrigatorio' });
    }

    // Busca contato Redrive
    let rc = null;
    if (phone) rc = await redrive.searchContactByPhone(phone);
    if (!rc && email) rc = await redrive.searchContactByEmail(email);
    if (!rc) {
      return res.json({ ok: false, error: 'contato nao encontrado na Redrive' });
    }
    console.log(`[Bot-Redrive] contato encontrado: ${rc.firstname} ${rc.lastname} - campo_auxiliar="${rc.campo_auxiliar || ''}"`);

    // Atualiza no Odoo
    const env = getOdooEnv();
    let updateResult;
    if (model === 'crm.lead') {
      updateResult = await redrive.updateOdooLeadFromRedrive(env, record_id, rc);
    } else {
      updateResult = await redrive.updateOdooPartnerFromRedrive(env, record_id, rc);
    }

    // Posta no chatter
    await redrive.postRedriveContactToChatter(env, model, record_id, rc);

    return res.json({
      ok: updateResult.ok,
      redrive_contact: {
        firstname: rc.firstname,
        lastname: rc.lastname,
        email: rc.email,
        phone: rc.phone,
        campo_auxiliar: rc.campo_auxiliar,
        curso_mapeado: redrive.mapCampoAuxiliarToCurso(rc.campo_auxiliar),
      },
      updated_fields: updateResult.vals || {},
      error: updateResult.error,
    });
  } catch (err) {
    console.error('[Bot-Redrive] update-odoo error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// === POST /bot/redrive-upload-history ===
// Upload de arquivo de historico (PDF/txt/HTML) exportado manualmente da Redrive
// Posta como attachment no chatter do partner/lead no Odoo
// Form: multipart/form-data com fields: file, model (res.partner|crm.lead), record_id
router.post('/redrive-upload-history', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'arquivo nao enviado (campo "file")' });
    }
    const model = req.body.model || 'res.partner';
    const record_id = parseInt(req.body.record_id, 10);
    if (!record_id) {
      return res.status(400).json({ ok: false, error: 'record_id obrigatorio' });
    }
    const filename = req.file.originalname || `historico-${Date.now()}.txt`;
    const mimetype = req.file.mimetype || 'application/octet-stream';
    const fileBuffer = req.file.buffer;
    console.log(`[Bot-Redrive] upload-history: file="${filename}" size=${fileBuffer.length} model=${model} record_id=${record_id}`);

    const env = getOdooEnv();

    // 1. Cria ir.attachment vinculado ao record
    // Odoo 19.4: usa campo 'raw' (nao 'datas') para conteudo binario
    const attachmentVals = {
      name: filename,
      raw: fileBuffer.toString('base64'),
      mimetype: mimetype,
      res_model: model,
      res_id: record_id,
    };
    let attachmentId;
    try {
      attachmentId = await executeKw(env, 'ir.attachment', 'create', [attachmentVals]);
      console.log(`[Bot-Redrive] attachment criado: ${attachmentId}`);
    } catch (e) {
      return res.status(500).json({ ok: false, error: `Falha ao criar attachment: ${e}` });
    }

    // 2. Posta mensagem no chatter referenciando o attachment
    const today = new Date().toISOString().slice(0, 10);
    const body = `<b>Histórico de Conversa WhatsApp (Redrive)</b><br/>`
      + `<b>Arquivo:</b> ${filename}<br/>`
      + `<b>Data upload:</b> ${today}<br/>`
      + `<br/>Veja o arquivo anexo para o histórico completo da conversa.`;
    try {
      // message_post com attachment_ids
      const uid = await getUid(env);
      const result = await fetch(`${env.url}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'call', id: Date.now(),
          params: {
            service: 'object', method: 'execute',
            args: [env.db, uid, env.apiKey, model, 'message_post',
              [record_id], {
                body,
                message_type: 'comment',
                subtype_xmlid: 'mail.mt_comment',
                attachment_ids: [Array.isArray(attachmentId) ? attachmentId[0] : attachmentId],
              }],
          },
        }),
      }).then(r => r.json());
      if (result.error) {
        console.log(`[Bot-Redrive] message_post com attachment falhou, tentando sem attachment_ids: ${result.error}`);
        // Fallback sem attachment_ids
        await executeKw(env, model, 'message_post', [[record_id], {
          body, message_type: 'comment', subtype_xmlid: 'mail.mt_comment',
        }]);
      }
    } catch (e) {
      console.log(`[Bot-Redrive] message_post falhou: ${e}`);
      // Fallback: post simples
      try {
        await executeKw(env, model, 'message_post', [[record_id], {
          body: body + `<br/><i>(attachment ${attachmentId} - ver em anexos)</i>`,
          message_type: 'comment', subtype_xmlid: 'mail.mt_comment',
        }]);
      } catch (e2) {}
    }

    return res.json({
      ok: true,
      attachment_id: attachmentId,
      filename,
      size: fileBuffer.length,
      model,
      record_id,
    });
  } catch (err) {
    console.error('[Bot-Redrive] upload-history error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// === GET /bot/redrive-info — info dos endpoints ===
router.get('/redrive-info', (req, res) => {
  res.json({
    endpoints: {
      'POST /bot/redrive-search': {
        description: 'Busca contato Redrive',
        body: { phone: 'string (opcional)', email: 'string (opcional)', firstname: 'string (opcional)' },
      },
      'POST /bot/redrive-update-odoo': {
        description: 'Busca Redrive + atualiza partner/lead no Odoo',
        body: { phone: 'string OU email: string', model: 'res.partner | crm.lead', record_id: 'number' },
      },
      'POST /bot/redrive-upload-history': {
        description: 'Upload de PDF/txt exportado da Redrive -> attachment no chatter Odoo',
        form_data: { file: 'arquivo', model: 'res.partner | crm.lead', record_id: 'number' },
      },
    },
    config_required: ['REDRIVE_LOGIN', 'REDRIVE_PASSWORD', 'ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_API_KEY'],
  });
});

module.exports = router;
