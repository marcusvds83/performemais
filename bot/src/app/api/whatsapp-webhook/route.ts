/**
 * WhatsApp Cloud API webhook handler — Vercel serverless function.
 *
 * Endpoints:
 *   GET  /api/whatsapp-webhook  — verification (hub.challenge)
 *   POST /api/whatsapp-webhook  — receive inbound messages from Meta
 *
 * Flow:
 *   1. Meta sends webhook → we receive it here
 *   2. We call Odoo JSON-RPC to find the whatsapp.message that Odoo already created
 *   3. We check if any operator is online (res.users.im_status)
 *      - If yes: skip (let human handle)
 *      - If no: call GLM via z-ai-web-dev-sdk, generate reply
 *   4. We send the reply back via Odoo's whatsapp.composer (JSON-RPC)
 *   5. We create a Lead in CRM if we detect lead signals
 *
 * Meta config:
 *   - Callback URL: https://<your-vercel-project>.vercel.app/api/whatsapp-webhook
 *   - Verify Token: WHATSAPP_VERIFY_TOKEN env var
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getRecentWaMessage,
  getAuthorFromWaMessage,
  getConversationHistory,
  getOnlineOperatorCount,
  sendWhatsAppReply,
  notifyPartnerChatter,
  findWaChannelForPartner,
  getOdooEnv,
  searchReadPartner,
  createPartner,
} from "@/lib/odoo";
import { replyWhatsApp, type ChatMessage } from "@/lib/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type WaPayload = {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: { body: string };
        }>;
      };
      field: string;
    }>;
  }>;
};

/* ---------- GET (verification) ---------- */

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || "performe-bot-verify";

  if (mode === "subscribe" && token === verifyToken) {
    return new NextResponse(challenge || "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

/* ---------- POST (inbound messages) ---------- */

export async function POST(req: NextRequest) {
  let payload: WaPayload;
  let rawBody: string;
  try {
    rawBody = await req.text();
    payload = JSON.parse(rawBody) as WaPayload;
  } catch (e) {
    console.error("[Performe+-Webhook] Invalid JSON:", e);
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Debug: log incoming payload (truncated)
  console.log(`[Performe+-Webhook] Received POST, payload length: ${rawBody.length}`);
  console.log(`[Performe+-Webhook] Payload preview: ${rawBody.slice(0, 500)}`);

  // FORWARD the webhook to Odoo (fire-and-forget, non-blocking)
  try {
    const odooWebhookUrl = "https://www.performe.com.br/whatsapp/webhook";
    console.log(`[Performe+-Webhook] Forwarding to Odoo (fire-and-forget)`);
    fetch(odooWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody,
    }).catch(() => {});
  } catch (e) {
    // ignore
  }

  // Always 200 OK quickly so Meta doesn't retry
  try {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value.messages || [];
        const contacts = change.value.contacts || [];
        console.log(`[Performe+-Webhook] Processing: ${messages.length} messages, ${contacts.length} contacts`);
        for (const msg of messages) {
          console.log(`[Performe+-Webhook] Message: type=${msg.type} from=${msg.from} id=${msg.id}`);
          if (msg.type !== "text" || !msg.text?.body) {
            console.log(`[Performe+-Webhook] Skipping non-text message (type=${msg.type})`);
            continue;
          }
          const phone = msg.from;
          const contactName = contacts.find((c) => c.wa_id === phone)?.profile?.name;
          const text = msg.text.body;
          console.log(`[Performe+-Webhook] Dispatching to handler: phone=${phone} name=${contactName} text="${text.slice(0, 80)}"`);

          await handleInbound({ phone, contactName, text });
        }
      }
    }
  } catch (err) {
    console.error("[Performe+-Webhook] Error processing:", err);
    console.error("[Performe+-Webhook] Error stack:", (err as Error)?.stack);
  }

  return NextResponse.json({ ok: true });
}

/* ---------- Main handler ---------- */

async function handleInbound(input: {
  phone: string;
  contactName?: string;
  text: string;
}) {
  const { phone, contactName, text } = input;
  console.log(`[Performe+] Inbound WA from ${phone} (${contactName || "?"}): ${text.slice(0, 80)}`);

  // 1) Get the whatsapp.message that Odoo already created
  // Retry up to 3 times with 2s interval = 6s total max wait
  let waMsg = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[Performe+-Debug] Attempt ${attempt}/3: searching WA msg in Odoo...`);
    await sleep(2000);
    waMsg = await getRecentWaMessage(phone);
    if (waMsg) {
      console.log(`[Performe+] Found whatsapp.message id=${waMsg.id} on attempt ${attempt}`);
      break;
    }
    console.log(`[Performe+-Debug] Attempt ${attempt}: not found yet, retrying...`);
  }
  if (!waMsg) {
    console.log("[Performe+] No matching whatsapp.message found after 3 retries — using fallback");
    await handleInboundFallback({ phone, contactName, text });
    return;
  }

  // 2) Get the author partner ID and discuss.channel
  const authorInfo = await getAuthorFromWaMessage(waMsg.id);
  if (!authorInfo || !authorInfo.authorId) {
    console.log("[Performe+] Could not find author partner");
    return;
  }
  console.log(`[Performe+] Author: id=${authorInfo.authorId} name=${authorInfo.authorName}`);

  // 3) Check operator online status — but DON'T skip if online
  // The bot should ALWAYS respond unless a human has manually replied
  const operatorIdsStr = process.env.PERFORME_OPERATOR_USER_IDS || "2,6";
  const operatorIds = operatorIdsStr
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((x) => !isNaN(x));

  // 4) Check if a HUMAN has already replied in this conversation
  // If yes, the bot stops (human took over)
  // System partner IDs = bot/operators (3=Admin, 22=Luis, 23=Comercial, 68865=AI Agent)
  const systemPartnerIds = [3, 22, 23, 68865];
  let humanReplied = false;
  if (authorInfo.channelId) {
    const historyRows = await getConversationHistory(
      authorInfo.channelId,
      authorInfo.authorId,
      [], // no operator partner IDs for now
      0,
      10
    );
    // Check if the LAST message before the current one was from a human operator
    // (not the bot). If so, the human is actively handling the conversation.
    const recentMessages = historyRows.slice(-5);
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const row = recentMessages[i];
      // If the last non-customer message was from a human (not bot), stop
      if (row.role === "Operador") {
        humanReplied = true;
        break;
      }
    }
  }
  if (humanReplied) {
    console.log(`[Performe+] Human operator has replied — bot stepping back`);
    return;
  }

  // 5) Check for handoff request — use word boundaries to avoid false positives
  const handoffWordsStr = process.env.PERFORME_HANDOFF_WORDS || "humano,atendente,operador,falar com pessoa";
  const handoffWords = handoffWordsStr.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  const textLower = text.toLowerCase();
  // Match whole words only (surrounded by spaces, punctuation, or start/end)
  const wantsHuman = handoffWords.some((w) => {
    const regex = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return regex.test(textLower);
  });

  if (wantsHuman) {
    console.log("[Performe+] Handoff requested — notifying operators");
    await notifyPartnerChatter(
      authorInfo.authorId,
      `<p><b>🔔 Handoff solicitado via WhatsApp</b></p>
       <p><b>Cliente:</b> ${authorInfo.authorName || "-"}</p>
       <p><b>Telefone:</b> ${phone}</p>
       <p><b>Mensagem:</b> ${text.slice(0, 500)}</p>
       <p>Um operador humano precisa assumir esta conversa.</p>`
    );
    return;
  }

  // 5) Bot ALWAYS responds (unless human already replied — checked above)
  // Operators being online does NOT stop the bot anymore

  // 6) Build conversation history
  let channelId = authorInfo.channelId;
  if (!channelId) {
    channelId = await findWaChannelForPartner(authorInfo.authorId);
  }

  let history: ChatMessage[] = [];
  if (channelId) {
    // Get operator partner IDs (to label their messages as "Operador" not "Bot")
    const operatorPartnerIds: number[] = [];
    try {
      const opUsers = await getOnlineOperatorCount(operatorIds);
      for (const op of opUsers.details) {
        // Need to fetch partner_id from res.users — skip for simplicity
      }
    } catch {}

    const historyRows = await getConversationHistory(
      channelId,
      authorInfo.authorId,
      operatorPartnerIds,
      0, // system partner ID — we don't have it precisely, label unknown as Bot
      12
    );
    history = historyRows.map((r) => ({
      role: (r.role === "Cliente" ? "user" : "assistant") as "user" | "assistant",
      content: r.content,
    }));
  }
  // Always include the new message at the end
  history.push({ role: "user", content: text });

  // 7) Generate reply via GLM
  console.log("[Performe+] Calling GLM for reply...");
  const botReply = await replyWhatsApp({
    messages: history,
    channel: "whatsapp",
    contactName: contactName || authorInfo.authorName,
  });
  console.log(`[Performe+] Reply generated (len=${botReply.content.length})${botReply.leadCreated ? ` — lead created id=${botReply.leadCreated}` : ""}`);

  // 8) Send reply via Odoo
  const waAccountField = waMsg.wa_account_id as number | [number, string] | undefined;
  const waAccountId: number = Array.isArray(waAccountField)
    ? waAccountField[0]
    : (waAccountField as number);
  const result = await sendWhatsAppReply({
    partnerId: authorInfo.authorId,
    body: botReply.content,
    waAccountId,
    partnerName: contactName || authorInfo.authorName,
    partnerPhone: phone,
  });
  if (result.ok) {
    console.log(`[Performe+] Reply sent successfully (msgId=${result.messageId})`);
  } else {
    console.error(`[Performe+] Failed to send reply: ${result.error}`);
  }
}

/**
 * Fallback handler: when Odoo hasn't processed the Meta webhook yet
 * (whatsapp.message not created in time), we still respond to the user.
 * We find/create the partner in Odoo by phone, then send the reply.
 */
async function handleInboundFallback(input: {
  phone: string;
  contactName?: string;
  text: string;
}) {
  const { phone, contactName, text } = input;
  console.log(`[Performe+-Fallback] Starting fallback handler for ${phone}`);

  const digits = String(phone || "").replace(/\D/g, "");
  const last8 = digits.slice(-8);
  let partnerId: number | null = null;

  // 1) Find partner by phone (Odoo 19 uses 'phone' or 'phone_mobile_search')
  try {
    const partners = await searchReadPartner<any>(
      "res.partner",
      ["|",
        ["phone", "ilike", last8],
        ["phone_mobile_search", "ilike", last8],
      ],
      ["id", "name", "phone"],
      1,
      "id desc"
    );
    if (partners && partners.length > 0) {
      partnerId = partners[0].id;
      console.log(`[Performe+-Fallback] Found partner id=${partnerId} by phone`);
    }
  } catch (e) {
    console.log(`[Performe+-Fallback] Partner search failed: ${e}`);
  }

  // 2) If no partner found, create one (Odoo 19 uses 'phone' field, not 'mobile')
  if (!partnerId) {
    try {
      partnerId = await createPartner({
        name: contactName || `WhatsApp ${phone}`,
        phone: phone,
      });
      console.log(`[Performe+-Fallback] Created new partner id=${partnerId}`);
    } catch (e) {
      console.log(`[Performe+-Fallback] Partner create failed: ${e}`);
    }
  }

  if (!partnerId) {
    console.log("[Performe+-Fallback] Could not find or create partner — aborting");
    return;
  }

  // 3) Get WA account ID (account 1 — Performe+)
  const waAccountId = 1;

  // 4) Check operator online — bot ALWAYS responds now
  const operatorIdsStr = process.env.PERFORME_OPERATOR_USER_IDS || "2,6";
  const operatorIds = operatorIdsStr
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((x) => !isNaN(x));

  // 5) Check handoff
  const handoffWordsStr = process.env.PERFORME_HANDOFF_WORDS || "humano,atendente,operador,falar com pessoa";
  const handoffWords = handoffWordsStr.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  const wantsHuman = handoffWords.some((w) => text.toLowerCase().includes(w));

  if (wantsHuman) {
    console.log("[Performe+-Fallback] Handoff requested");
    await notifyPartnerChatter(
      partnerId,
      `<p><b>🔔 Handoff solicitado via WhatsApp</b></p><p><b>Cliente:</b> ${contactName || "-"}</p><p><b>Telefone:</b> ${phone}</p><p><b>Mensagem:</b> ${text.slice(0, 500)}</p>`
    );
    return;
  }

  // Bot ALWAYS responds (no more operator-online check)

  // 6) Build history (just the user message — no Odoo history available)
  const history: ChatMessage[] = [
    { role: "user", content: text },
  ];

  // 7) Generate reply via Gemini
  console.log("[Performe+-Fallback] Calling AI for reply...");
  const botReply = await replyWhatsApp({
    messages: history,
    channel: "whatsapp",
    contactName: contactName || `WhatsApp ${phone}`,
  });
  console.log(`[Performe+-Fallback] Reply generated (len=${botReply.content.length})`);

  // 8) Send reply
  const result = await sendWhatsAppReply({
    partnerId,
    body: botReply.content,
    waAccountId,
    partnerName: contactName || `WhatsApp ${phone}`,
    partnerPhone: phone,
  });
  if (result.ok) {
    console.log(`[Performe+-Fallback] Reply sent successfully (msgId=${result.messageId})`);
  } else {
    console.error(`[Performe+-Fallback] Failed to send reply: ${result.error}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
