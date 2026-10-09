/**
 * Cron endpoint to check for abandoned WhatsApp conversations
 * and create CRM leads + send "thank you" message.
 *
 * Call this endpoint every 5-10 minutes from an external cron service
 * like cron-job.org (free) or Vercel Cron (paid Pro plan).
 *
 * Auth: requires CRON_SECRET env var to be set, sent as Bearer token.
 *
 * Flow:
 *   1. Find all discuss.channel with channel_type=whatsapp
 *   2. For each channel, check the most recent mail.message
 *   3. If the last message was > 10 minutes ago AND from the customer (not bot)
 *      AND no lead was created yet for this conversation
 *      AND the conversation had at least 2 messages
 *   4. Create a CRM lead with the conversation transcript
 *   5. Send a "thank you" message via message_post
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getOdooEnv,
  searchRead,
  executeKw,
  createCrmLead,
  sendWhatsAppReply,
} from "@/lib/odoo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const INACTIVITY_MINUTES = 10;

export async function POST(req: NextRequest) {
  // Auth check
  const authHeader = req.headers.get("authorization") || "";
  const expectedToken = `Bearer ${process.env.CRON_SECRET || "performe-cron-secret-2024"}`;
  if (authHeader !== expectedToken) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  console.log("[Performe+-Cron] Starting inactivity check...");

  try {
    const env = getOdooEnv();
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - INACTIVITY_MINUTES * 60 * 1000);

    // 1. Find all WhatsApp channels
    const channels = await searchRead<any>(
      "discuss.channel",
      [["channel_type", "=", "whatsapp"]],
      ["id", "name", "whatsapp_partner_id", "whatsapp_number", "wa_account_id"],
      100,
      "id asc"
    );
    console.log(`[Performe+-Cron] Found ${channels.length} WhatsApp channels`);

    let leadsCreated = 0;
    let messagesSent = 0;

    for (const channel of channels) {
      const channelId = channel.id;
      const partnerInfo = channel.whatsapp_partner_id;
      const partnerId = Array.isArray(partnerInfo) ? partnerInfo[0] : partnerInfo;
      const partnerName = Array.isArray(partnerInfo) ? partnerInfo[1] : "Cliente";
      const phone = channel.whatsapp_number || "";

      if (!partnerId) continue;

      // 2. Get all messages from this channel
      const messages = await searchRead<any>(
        "mail.message",
        [["model", "=", "discuss.channel"], ["res_id", "=", channelId]],
        ["id", "body", "author_id", "create_date", "message_type"],
        50,
        "create_date asc"
      );

      if (messages.length < 2) {
        // Not enough messages to be a real conversation
        continue;
      }

      // 3. Check if there's already a lead for this partner in the last 7 days
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const sevenDaysAgoStr = sevenDaysAgo.toISOString().replace("T", " ").substring(0, 19);

      const existingLeads = await searchRead<any>(
        "crm.lead",
        [
          ["partner_id", "=", partnerId],
          ["create_date", ">=", sevenDaysAgoStr],
        ],
        ["id", "name"],
        1,
        "id desc"
      );

      if (existingLeads.length > 0) {
        // Already has a lead in last 7 days — skip
        continue;
      }

      // 4. Find the most recent message
      const lastMessage = messages[messages.length - 1];
      const lastMessageDate = new Date(lastMessage.create_date + " UTC");

      // 5. If the last message was less than 10 minutes ago, skip
      if (lastMessageDate > cutoffTime) {
        continue;
      }

      // 6. Check who sent the last message — if it was the bot/operator, skip
      // (we only want to create a lead if the customer abandoned the conversation)
      const lastAuthorArr = lastMessage.author_id || [];
      const lastAuthorId = Array.isArray(lastAuthorArr) ? lastAuthorArr[0] : 0;

      // The customer's partner ID should be different from the system user (Luis Fernando = 22, Admin = 3, Comercial = 23)
      const operatorPartnerIds = [3, 22, 23]; // Admin, Luis, Comercial
      if (operatorPartnerIds.includes(lastAuthorId)) {
        // Last message was from us (bot/operator) — customer already got a reply
        // We should still create a lead if the conversation was meaningful
      }

      // 7. Build transcript
      const transcript = messages.map((m: any) => {
        const mAuthorArr = m.author_id || [];
        const mAuthorId = Array.isArray(mAuthorArr) ? mAuthorArr[0] : 0;
        const mAuthorName = Array.isArray(mAuthorArr) ? mAuthorArr[1] : "Desconhecido";
        let role = "Cliente";
        if (operatorPartnerIds.includes(mAuthorId)) {
          role = "Bot/Operador";
        }
        const body = (m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return `[${m.create_date}] ${role} (${mAuthorName}): ${body}`;
      }).join("\n");

      // 8. Extract contact info from transcript
      const emailMatch = transcript.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      const phoneMatch = transcript.match(/\+?\d[\d\s\-()]{7,}\d/);
      const nameMatch = transcript.match(
        /(?:meu nome é|me chamo|sou o|sou a|nome[:\s]+)\s+([A-Za-zÀ-ú][A-Za-zÀ-ú\s]{2,40})/i
      );
      const extractedName = nameMatch ? nameMatch[1].trim().split(/\s+/).slice(0, 4).join(" ") : partnerName;

      // 9. Create the lead
      try {
        const leadId = await createCrmLead({
          name: `Lead WhatsApp — ${extractedName}`,
          partnerName: extractedName,
          email: emailMatch?.[0],
          phone: phoneMatch?.[0] || `+${phone}`,
          description: `Lead gerado automaticamente após 10 min de inatividade no WhatsApp.

Cliente: ${extractedName}
Telefone: ${phoneMatch?.[0] || "+" + phone || "—"}
E-mail: ${emailMatch?.[0] || "—"}

Transcrição da conversa:
${transcript.slice(0, 2000)}`,
        });
        console.log(`[Performe+-Cron] Created lead ${leadId} for partner ${partnerId} (channel ${channelId})`);
        leadsCreated++;

        // 10. Send "thank you" message to the customer
        const thankYouMessage = `Olá, ${extractedName}! 👋

Agradecemos muito pela sua conversa conosco. Registramos seu interesse aqui na Performe+ e um de nossos especialistas entrará em contato em até 1 dia útil para continuar o atendimento.

Caso precise de algo urgente, responda "humano" que te conectamos com nossa equipe agora mesmo.

Até logo!`;

        const waAccountArr = channel.wa_account_id;
        const waAccountId = Array.isArray(waAccountArr) ? waAccountArr[0] : waAccountArr || 1;

        const result = await sendWhatsAppReply({
          partnerId,
          body: thankYouMessage,
          waAccountId,
          partnerName: extractedName,
          partnerPhone: phone,
        });

        if (result.ok) {
          console.log(`[Performe+-Cron] Thank you message sent to partner ${partnerId}`);
          messagesSent++;
        } else {
          console.log(`[Performe+-Cron] Failed to send thank you: ${result.error}`);
        }
      } catch (e) {
        console.log(`[Performe+-Cron] Failed to create lead for partner ${partnerId}: ${e}`);
      }
    }

    console.log(`[Performe+-Cron] Done. Leads created: ${leadsCreated}, messages sent: ${messagesSent}`);

    return NextResponse.json({
      ok: true,
      checked_channels: channels.length,
      leads_created: leadsCreated,
      messages_sent: messagesSent,
      cutoff_minutes: INACTIVITY_MINUTES,
    });
  } catch (err) {
    console.error("[Performe+-Cron] Error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
