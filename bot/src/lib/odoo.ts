/**
 * Odoo JSON-RPC client — works in Vercel serverless functions.
 */

export type OdooEnv = {
  url: string;
  db: string;
  username: string;
  apiKey: string;
};

export function getOdooEnv(): OdooEnv {
  const url = (process.env.ODOO_URL || "").replace(/\/$/, "");
  const db = process.env.ODOO_DB || "";
  const username = process.env.ODOO_USERNAME || "";
  const apiKey = process.env.ODOO_API_KEY || "";
  if (!url || !db || !username || !apiKey) {
    throw new Error("Missing Odoo env vars.");
  }
  return { url, db, username, apiKey };
}

let _cachedUid: number | null = null;

async function rpc(endpoint: string, params: Record<string, unknown>) {
  const env = getOdooEnv();
  const body = {
    jsonrpc: "2.0",
    method: "call",
    params,
    id: Date.now(),
  };
  const res = await fetch(`${env.url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Performe+Bot-Vercel/1.0",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Odoo HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.error) {
    const msg = json.error?.data?.message || json.error?.message || "Unknown Odoo error";
    throw new Error(`Odoo: ${msg}`);
  }
  return json.result;
}

async function getUid(): Promise<number> {
  if (_cachedUid != null) return _cachedUid;
  const env = getOdooEnv();
  const uid = await rpc("/jsonrpc", {
    service: "common",
    method: "authenticate",
    args: [env.db, env.username, env.apiKey, {}],
  });
  if (!uid || typeof uid !== "number") {
    throw new Error(`Odoo auth failed`);
  }
  _cachedUid = uid;
  return uid;
}

/**
 * search_read wrapper — uses positional args without options object
 * to avoid Odoo 19 search_read quirks.
 */
export async function searchRead<T = any>(
  model: string,
  domain: any[],
  fields: string[],
  limit: number = 80,
  order: string = "id desc"
): Promise<T[]> {
  const env = getOdooEnv();
  const uid = await getUid();
  const result = await rpc("/jsonrpc", {
    service: "object",
    method: "execute",
    args: [env.db, uid, env.apiKey, model, "search_read", domain, fields, 0, limit, order],
  });
  return (result as T[]) || [];
}

export async function executeKw<T = any>(
  model: string,
  method: string,
  args: any[]
): Promise<T> {
  const env = getOdooEnv();
  const uid = await getUid();
  const result = await rpc("/jsonrpc", {
    service: "object",
    method: "execute",
    args: [env.db, uid, env.apiKey, model, method, ...args],
  });
  return result as T;
}

/* ============================================================
 * High-level helpers
 * ============================================================ */

export async function getRecentWaMessage(phoneDigits: string) {
  const digits = String(phoneDigits || "").replace(/\D/g, "").slice(-8);
  if (!digits) return null;
  console.log(`[Performe+-Debug] searching WA msg with digits: ${digits}`);
  const messages = await searchRead<any>(
    "whatsapp.message",
    [
      ["message_type", "=", "inbound"],
      ["state", "=", "received"],
      ["mobile_number_formatted", "ilike", digits],
    ],
    ["id", "body", "create_date", "mail_message_id", "mobile_number",
     "mobile_number_formatted", "wa_account_id"],
    1,
    "create_date desc"
  );
  if (!messages || messages.length === 0) {
    console.log(`[Performe+-Debug] no WA msg found for digits ${digits}`);
    return null;
  }
  console.log(`[Performe+-Debug] found WA msg id=${messages[0].id}`);
  return messages[0];
}

export async function getConversationHistory(
  channelId: number,
  partnerId: number,
  operatorPartnerIds: number[],
  systemPartnerId: number,
  limit = 24
) {
  const msgs = await searchRead<any>(
    "mail.message",
    [
      ["model", "=", "discuss.channel"],
      ["res_id", "=", channelId],
    ],
    ["id", "body", "author_id", "create_date", "message_type"],
    limit,
    "create_date asc"
  );
  return (msgs || []).map((m: any) => {
    const authorArr = m.author_id || [];
    const authorId: number = Array.isArray(authorArr) ? authorArr[0] : (authorArr as number);
    let role = "Bot";
    if (authorId === partnerId) role = "Cliente";
    else if (authorId === systemPartnerId) role = "Bot";
    else if (operatorPartnerIds.includes(authorId)) role = "Operador";
    return {
      role,
      content: stripHtml(m.body || ""),
      create_date: m.create_date,
    };
  }).filter((m: any) => m.content);
}

export async function getOnlineOperatorCount(operatorUserIds: number[]): Promise<{
  online: number;
  total: number;
  details: { id: number; name: string; im_status: string }[];
}> {
  if (!operatorUserIds || operatorUserIds.length === 0) {
    return { online: 0, total: 0, details: [] };
  }
  const users = await searchRead<any>(
    "res.users",
    [["id", "in", operatorUserIds]],
    ["id", "name", "im_status"],
    50,
    "id asc"
  );
  const details = (users || []).map((u: any) => ({
    id: u.id,
    name: u.name,
    im_status: u.im_status,
  }));
  return {
    online: details.filter((u) => u.im_status === "online").length,
    total: details.length,
    details,
  };
}

export async function sendWhatsAppReply(opts: {
  partnerId: number;
  body: string;
  waAccountId: number;
  partnerName?: string;
  partnerPhone?: string;
}): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  console.log(`[Performe+-Debug] sendWhatsAppReply partnerId=${opts.partnerId} accountId=${opts.waAccountId}`);

  // Step 1: Find the discuss.channel (WhatsApp type) for this partner
  let channelId: number | null = null;
  try {
    const channels = await searchRead<any>(
      "discuss.channel",
      [
        ["channel_type", "=", "whatsapp"],
        ["whatsapp_partner_id", "=", opts.partnerId],
      ],
      ["id", "name", "whatsapp_number"],
      1,
      "id asc"
    );
    if (channels && channels.length > 0) {
      channelId = channels[0].id;
      console.log(`[Performe+-Debug] Found discuss.channel id=${channelId} for partner ${opts.partnerId}`);
    }
  } catch (e) {
    console.log(`[Performe+-Debug] Channel search failed: ${e}`);
  }

  // Step 1b: If no channel found, create one (WhatsApp type)
  if (!channelId) {
    const phone = opts.partnerPhone || "";
    const digits = String(phone).replace(/\D/g, "");
    const name = opts.partnerName || `Partner ${opts.partnerId}`;
    const channelName = digits ? `${name} (${digits})` : name;
    // Set whatsapp_channel_active=True and valid_until=now+24h
    // (Odoo checks this to allow free-form outbound messages within 24h window)
    const now = new Date();
    const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const validUntilStr = validUntil.toISOString().replace("T", " ").substring(0, 19);
    try {
      const newChannelId = await executeKw<number>(
        "discuss.channel",
        "create",
        [{
          name: channelName,
          channel_type: "whatsapp",
          whatsapp_partner_id: opts.partnerId,
          whatsapp_number: digits || false,
          wa_account_id: opts.waAccountId,
          whatsapp_channel_active: true,
          whatsapp_channel_valid_until: validUntilStr,
        }]
      );
      channelId = Array.isArray(newChannelId) ? newChannelId[0] : newChannelId;
      console.log(`[Performe+-Debug] Created new WhatsApp channel id=${channelId} for partner ${opts.partnerId} (active until ${validUntilStr})`);
    } catch (e) {
      console.log(`[Performe+-Debug] Channel create failed: ${e}`);
      return { ok: false, error: `Could not find or create WhatsApp channel: ${e}` };
    }
  }

  if (!channelId) {
    return { ok: false, error: `No WhatsApp channel found/created for partner ${opts.partnerId}` };
  }

  // Step 2: Use discuss.channel.message_post to send the message
  // CRITICAL: message_type MUST be "whatsapp_message" (not "comment")
  // — only this triggers Odoo to create a whatsapp.message and send via Meta API
  try {
    const env = getOdooEnv();
    const uid = await getUid();
    const result = await rpc("/jsonrpc", {
      service: "object",
      method: "execute_kw",
      args: [env.db, uid, env.apiKey, "discuss.channel", "message_post",
             [[channelId]],
             {
               body: opts.body,
               message_type: "whatsapp_message",
               subtype_xmlid: "mail.mt_comment",
             }],
    });
    let messageId: number | undefined;
    if (Array.isArray(result) && result.length > 0) {
      messageId = result[0];
    } else if (typeof result === "number") {
      messageId = result;
    } else if (result && typeof result === "object") {
      messageId = (result as any).id || (result as any)[0];
    }
    console.log(`[Performe+-Debug] discuss.channel.message_post returned: ${JSON.stringify(result)} — messageId=${messageId}`);
    return { ok: true, messageId };
  } catch (e) {
    console.log(`[Performe+-Debug] discuss.channel.message_post failed: ${e}`);

    // Fallback: try message_post with body only
    try {
      const env = getOdooEnv();
      const uid = await getUid();
      const result = await rpc("/jsonrpc", {
        service: "object",
        method: "execute_kw",
        args: [env.db, uid, env.apiKey, "discuss.channel", "message_post",
               [[channelId]],
               { body: opts.body }],
      });
      let messageId: number | undefined;
      if (Array.isArray(result) && result.length > 0) {
        messageId = result[0];
      }
      console.log(`[Performe+-Debug] Fallback message_post returned: ${JSON.stringify(result)}`);
      return { ok: true, messageId };
    } catch (e2) {
      return { ok: false, error: `message_post failed: ${e}; fallback failed: ${e2}` };
    }
  }
}

export async function createCrmLead(opts: {
  name: string;
  partnerName?: string;
  email?: string;
  phone?: string;
  description?: string;
}): Promise<number> {
  return executeKw<number>("crm.lead", "create", [{
    name: opts.name,
    partner_name: opts.partnerName || false,
    contact_name: opts.partnerName || false,
    email_from: opts.email || false,
    phone: opts.phone || false,
    type: "lead",
    description: opts.description || "",
  }]);
}

/**
 * Search for existing lead/opportunity by phone number.
 * Returns the lead record if found, null otherwise.
 */
export async function findLeadByPhone(phoneDigits: string): Promise<{
  id: number;
  name: string;
  type: string;
  phone?: string;
  description?: string;
} | null> {
  const digits = String(phoneDigits || "").replace(/\D/g, "").slice(-8);
  if (!digits) return null;
  try {
    const leads = await searchRead<any>(
      "crm.lead",
      [["phone", "ilike", digits]],
      ["id", "name", "type", "phone", "description", "partner_id"],
      1,
      "create_date desc"
    );
    if (leads && leads.length > 0) {
      return leads[0];
    }
    // Also search by partner's phone
    const partners = await searchRead<any>(
      "res.partner",
      [["phone", "ilike", digits]],
      ["id"],
      1,
      "id desc"
    );
    if (partners && partners.length > 0) {
      const partnerId = partners[0].id;
      const partnerLeads = await searchRead<any>(
        "crm.lead",
        [["partner_id", "=", partnerId]],
        ["id", "name", "type", "phone", "description", "partner_id"],
        1,
        "create_date desc"
      );
      if (partnerLeads && partnerLeads.length > 0) {
        return partnerLeads[0];
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Update an existing lead's description (observations) with new conversation transcript.
 */
export async function updateLeadDescription(
  leadId: number,
  description: string
): Promise<boolean> {
  try {
    await executeKw("crm.lead", "write", [leadId, { description }]);
    return true;
  } catch {
    return false;
  }
}

export async function notifyPartnerChatter(
  partnerId: number,
  message: string
): Promise<boolean> {
  try {
    await executeKw("res.partner", "message_post", [[partnerId], {
      body: message,
      message_type: "notification",
      subtype_xmlid: "mail.mt_comment",
    }]);
    return true;
  } catch {
    return false;
  }
}

export async function findWaChannelForPartner(
  partnerId: number
): Promise<number | null> {
  try {
    const channels = await searchRead<any>(
      "discuss.channel",
      [
        ["channel_type", "=", "whatsapp"],
        ["whatsapp_partner_id", "=", partnerId],
      ],
      ["id"],
      1,
      "id asc"
    );
    if (channels && channels.length > 0) {
      return channels[0].id;
    }
    return null;
  } catch {
    return null;
  }
}

export async function getAuthorFromWaMessage(
  waMessageId: number
): Promise<{ authorId: number; authorName: string; channelId: number | null; mobile: string } | null> {
  const msgs = await searchRead<any>(
    "whatsapp.message",
    [["id", "=", waMessageId]],
    ["id", "mail_message_id", "mobile_number"],
    1,
    "id asc"
  );
  if (!msgs || msgs.length === 0) return null;
  const wa = msgs[0];
  const mmId = Array.isArray(wa.mail_message_id) ? wa.mail_message_id[0] : wa.mail_message_id;
  if (!mmId) return null;
  const mms = await searchRead<any>(
    "mail.message",
    [["id", "=", mmId]],
    ["id", "author_id", "model", "res_id"],
    1,
    "id asc"
  );
  if (!mms || mms.length === 0) return null;
  const mm = mms[0];
  const authorArr = mm.author_id || [];
  const authorId: number = Array.isArray(authorArr) ? authorArr[0] : 0;
  const authorName: string = Array.isArray(authorArr) ? authorArr[1] : "";
  let channelId: number | null = null;
  if (mm.model === "discuss.channel" && mm.res_id) {
    channelId = mm.res_id;
  }
  return {
    authorId,
    authorName,
    channelId,
    mobile: wa.mobile_number || "",
  };
}

/* ============================================================
 * Helpers
 * ============================================================ */

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

/**
 * Public wrappers used by the fallback handler in webhook route.
 */
export async function searchReadPartner<T = any>(
  model: string,
  domain: any[],
  fields: string[],
  limit: number = 1,
  order: string = "id desc"
): Promise<T[]> {
  return searchRead<T>(model, domain, fields, limit, order);
}

export async function createPartner(opts: {
  name: string;
  phone?: string;
  email?: string;
}): Promise<number> {
  const vals: Record<string, any> = { name: opts.name };
  if (opts.phone) vals.phone = opts.phone;
  if (opts.email) vals.email = opts.email;
  return executeKw<number>("res.partner", "create", [vals]);
}
