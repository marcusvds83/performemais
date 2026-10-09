/**
 * Endpoint POST /api/whatsapp-on-create
 * 
 * Chamado pela base.automation do Odoo quando uma msg WA chega.
 * Body: { record_id, body, author_id, author_name, wa_account_id, channel_id, history_text }
 * 
 * Resposta: chama Gemini, responde via Odoo JSON-RPC (cria msg outbound).
 */

import { NextRequest, NextResponse } from "next/server";
import { replyWhatsApp, type ChatMessage } from "@/lib/ai";
import { sendWhatsAppReply, executeKw } from "@/lib/odoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type OnCreatePayload = {
  record_id: number;
  body: string;
  author_id: number;
  author_name?: string;
  wa_account_id: number;
  channel_id?: number;
  history_text?: string;
};

const CRON_SECRET = process.env.CRON_SECRET || "performe-cron-secret-2024";

export async function POST(req: NextRequest) {
  // Auth simples via Bearer token (mesma do cron)
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: OnCreatePayload;
  try {
    payload = (await req.json()) as OnCreatePayload;
  } catch (e) {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  console.log(`[Performe+-OnCreate] record_id=${payload.record_id} author=${payload.author_name} body="${payload.body?.slice(0, 80)}"`);

  // Verificar handoff
  const handoffWordsStr = process.env.PERFORME_HANDOFF_WORDS || "humano,atendente,operador,falar com pessoa";
  const handoffWords = handoffWordsStr.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  const wantsHuman = handoffWords.some((w) => payload.body?.toLowerCase().includes(w));

  if (wantsHuman) {
    console.log(`[Performe+-OnCreate] Handoff solicitado — notificando chatter do partner ${payload.author_id}`);
    try {
      await executeKw("res.partner", "message_post", [
        [payload.author_id],
        {
          body: `<p><b>🔔 Handoff solicitado via WhatsApp</b></p><p><b>Cliente:</b> ${payload.author_name || "-"}</p><p><b>Mensagem:</b> ${payload.body?.slice(0, 500) || ""}</p><p>Um operador humano precisa assumir esta conversa.</p>`,
          message_type: "notification",
          subtype_xmlid: "mail.mt_comment",
        },
      ]);
    } catch (e) {
      console.log(`[Performe+-OnCreate] Handoff notify failed: ${e}`);
    }
    return NextResponse.json({ ok: true, action: "handoff" });
  }

  // Construir historico
  let history: ChatMessage[] = [];
  if (payload.history_text) {
    const lines = payload.history_text.split("\n").filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^(Cliente|Bot|Operador):\s*(.*)$/);
      if (m) {
        const role = m[1] === "Cliente" ? "user" : "assistant";
        history.push({ role, content: m[2] });
      }
    }
  }
  history.push({ role: "user", content: payload.body || "" });

  // Gerar resposta IA
  console.log(`[Performe+-OnCreate] Calling Gemini...`);
  const botReply = await replyWhatsApp({
    messages: history,
    channel: "whatsapp",
    contactName: payload.author_name,
  });
  console.log(`[Performe+-OnCreate] Reply generated (len=${botReply.content.length})`);

  // Enviar resposta via Odoo
  const result = await sendWhatsAppReply({
    partnerId: payload.author_id,
    body: botReply.content,
    waAccountId: payload.wa_account_id,
    partnerName: payload.author_name,
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
  });
}

export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/whatsapp-on-create",
    description: "Chamado pela base.automation do Odoo quando msg WA chega",
    body: {
      record_id: "number",
      body: "string",
      author_id: "number (res.partner ID)",
      author_name: "string",
      wa_account_id: "number",
      channel_id: "number (optional)",
      history_text: "string (optional, pre-formatted)",
    },
  });
}
