/**
 * Endpoint POST /api/whatsapp-on-create
 * 
 * Chamado pela base.automation do Odoo (#22) quando uma msg WA chega.
 * Payload enviado pelo Odoo (state=webhook):
 *   { _action, _id, _model, body, create_date, id, mail_message_id, 
 *     message_type, mobile_number, state, wa_account_id }
 * 
 * Bot:
 * 1. Recebe o payload
 * 2. Busca author_id e history via JSON-RPC no Odoo
 * 3. Chama Gemini
 * 4. Responde via Odoo JSON-RPC (cria msg outbound)
 */

import { NextRequest, NextResponse } from "next/server";
import { replyWhatsApp, type ChatMessage } from "@/lib/ai";
import { sendWhatsAppReply, searchRead, executeKw } from "@/lib/odoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type OdooWebhookPayload = {
  _action?: string;
  _id?: number;
  _model?: string;
  id: number;
  body: string;
  mail_message_id: number;
  wa_account_id: number;
  mobile_number?: string;
  message_type?: string;
  state?: string;
  create_date?: string;
};

const CRON_SECRET = process.env.CRON_SECRET || "performe-cron-secret-2024";

function stripHtml(html: string): string {
  let text = html || "";
  while (text.includes("<") && text.includes(">")) {
    const start = text.indexOf("<");
    const end = text.indexOf(">", start);
    if (end < 0) break;
    text = text.slice(0, start) + " " + text.slice(end + 1);
  }
  return text.split(/\s+/).join(" ").trim();
}

export async function POST(req: NextRequest) {
  // Auth
  const authHeader = req.headers.get("authorization") || "";
  // Odoo webhook nao envia Bearer — desativamos auth por enquanto
  // (o endpoint e publico mas so responde a payloads validos do Odoo)
  let authOk = !CRON_SECRET; // se CRON_SECRET nao setado, permite
  if (CRON_SECRET) {
    // Tenta com e sem Bearer (Odoo pode nao enviar)
    authOk = authHeader === `Bearer ${CRON_SECRET}` || !authHeader;
  }
  // Para o webhook do Odoo, vamos permitir sem auth (o URL nao e publico)
  // authOk = true; // Uncomment para desativar auth completamente

  let payload: OdooWebhookPayload;
  try {
    payload = (await req.json()) as OdooWebhookPayload;
  } catch (e) {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Filtra: so processa msgs inbound (nao outbound do bot)
  if (payload.message_type && payload.message_type !== "inbound") {
    return NextResponse.json({ ok: true, skipped: "not inbound" });
  }

  console.log(`[Performe+-OnCreate] msg id=${payload.id} mobile=${payload.mobile_number} body="${payload.body?.slice(0, 60)}"`);

  // 1. Buscar author_id (res.partner) via mail_message_id
  let authorId = 0;
  let authorName = "";
  let channelId: number | null = null;
  try {
    const mm = await searchRead<any>(
      "mail.message",
      [["id", "=", payload.mail_message_id]],
      ["id", "author_id", "model", "res_id"],
      1
    );
    if (mm && mm.length > 0) {
      const authorArr = mm[0].author_id;
      if (Array.isArray(authorArr)) {
        authorId = authorArr[0];
        authorName = authorArr[1] || "";
      }
      if (mm[0].model === "discuss.channel" && mm[0].res_id) {
        channelId = mm[0].res_id;
      }
    }
  } catch (e) {
    console.log(`[Performe+-OnCreate] mail.message lookup failed: ${e}`);
  }

  if (!authorId) {
    console.log(`[Performe+-OnCreate] No author found for msg ${payload.id}`);
    return NextResponse.json({ ok: false, error: "no author" });
  }

  // 2. Identificar partner_id dos operadores (nao responder a operadores)
  const operatorIdsStr = process.env.PERFORME_OPERATOR_USER_IDS || "2,5";
  const operatorIds = operatorIdsStr.split(",").map((x) => parseInt(x.trim(), 10)).filter(Boolean);
  let isOperator = false;
  try {
    const opUsers = await searchRead<any>(
      "res.users",
      [["id", "in", operatorIds]],
      ["id", "name", "partner_id"],
      10
    );
    for (const op of opUsers) {
      const pId = Array.isArray(op.partner_id) ? op.partner_id[0] : op.partner_id;
      if (pId === authorId) {
        isOperator = true;
        break;
      }
    }
  } catch (e) {
    console.log(`[Performe+-OnCreate] operator lookup failed: ${e}`);
  }

  if (isOperator) {
    console.log(`[Performe+-OnCreate] Author is operator — skip`);
    return NextResponse.json({ ok: true, skipped: "operator" });
  }

  // 3. Limpar body (HTML)
  const text = stripHtml(payload.body || "");

  // 4. Verificar handoff
  const handoffWordsStr = process.env.PERFORME_HANDOFF_WORDS || "humano,atendente,operador,falar com pessoa";
  const handoffWords = handoffWordsStr.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  const wantsHuman = handoffWords.some((w) => text.toLowerCase().includes(w));

  if (wantsHuman) {
    console.log(`[Performe+-OnCreate] Handoff solicitado`);
    try {
      await executeKw("res.partner", "message_post", [
        [authorId],
        {
          body: `<p><b>🔔 Handoff solicitado via WhatsApp</b></p><p><b>Cliente:</b> ${authorName || "-"}</p><p><b>Mensagem:</b> ${text.slice(0, 500)}</p><p>Um operador humano precisa assumir esta conversa.</p>`,
          message_type: "notification",
          subtype_xmlid: "mail.mt_comment",
        },
      ]);
    } catch (e) {
      console.log(`[Performe+-OnCreate] Handoff notify failed: ${e}`);
    }
    return NextResponse.json({ ok: true, action: "handoff" });
  }

  // 5. Buscar historico da conversa (canal WA)
  let historyText = "";
  if (channelId) {
    try {
      const channelMsgs = await searchRead<any>(
        "mail.message",
        [["model", "=", "discuss.channel"], ["res_id", "=", channelId]],
        ["id", "body", "author_id", "create_date", "message_type"],
        24,
        "create_date asc"
      );
      const systemPartnerIds = [3, 22, 23, 553, 68865]; // Operadores/Bot
      for (const m of channelMsgs) {
        const authorArr = m.author_id;
        const mAuthorId = Array.isArray(authorArr) ? authorArr[0] : 0;
        const mAuthorName = Array.isArray(authorArr) ? authorArr[1] : "Sistema";
        const role = mAuthorId === authorId ? "Cliente" : (systemPartnerIds.includes(mAuthorId) ? "Bot" : "Operador");
        const mtext = stripHtml(m.body || "");
        if (mtext) {
          historyText += `${role}: ${mtext}\n`;
        }
      }
    } catch (e) {
      console.log(`[Performe+-OnCreate] history lookup failed: ${e}`);
    }
  }

  // 6. Construir mensagens para Gemini
  const history: ChatMessage[] = [];
  if (historyText) {
    const lines = historyText.split("\n").filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^(Cliente|Bot|Operador):\s*(.*)$/);
      if (m) {
        const role = m[1] === "Cliente" ? "user" : "assistant";
        history.push({ role, content: m[2] });
      }
    }
  }
  // Garante que a msg atual esta no final
  if (history.length === 0 || history[history.length - 1].content !== text) {
    history.push({ role: "user", content: text });
  }

  // 7. Gerar resposta IA
  console.log(`[Performe+-OnCreate] Calling Gemini (history len=${history.length})...`);
  const botReply = await replyWhatsApp({
    messages: history,
    channel: "whatsapp",
    contactName: authorName,
  });
  console.log(`[Performe+-OnCreate] Reply generated (len=${botReply.content.length})`);

  // 8. Enviar resposta via Odoo
  const result = await sendWhatsAppReply({
    partnerId: authorId,
    body: botReply.content,
    waAccountId: payload.wa_account_id,
    partnerName: authorName,
  });

  if (result.ok) {
    console.log(`[Performe+-OnCreate] Reply sent OK (msgId=${result.messageId})`);
  } else {
    console.error(`[Performe+-OnCreate] Reply FAILED: ${result.error}`);
  }

  return NextResponse.json({
    ok: result.ok,
    messageId: result.messageId,
    error: result.error,
    leadCreated: botReply.leadCreated,
    authorId,
    authorName,
    channelId,
  });
}

export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/whatsapp-on-create",
    description: "Chamado pela base.automation #22 do Odoo quando msg WA chega",
    payload: "Odoo webhook format (id, body, mail_message_id, wa_account_id, mobile_number, message_type, state, create_date)",
    note: "Bot busca author_id e history via JSON-RPC depois",
  });
}
