/**
 * AI orchestration for the Performe+ WhatsApp bot.
 * Supports two providers:
 *   1. Google Gemini (FREE) — when GEMINI_API_KEY env var is set
 *   2. z-ai-web-dev-sdk (GLM-4.6) — fallback for sandbox environment
 *
 * Knowledge base: src/lib/performe-data/knowledge.json
 * System prompt: ~30k chars (similar to Nytro pattern) with:
 *   - Identity (Performe+)
 *   - Tone rules (PT-BR, professional, no markdown, short answers)
 *   - Service flow (greeting -> qualification -> handoff -> opportunity)
 *   - Embedded knowledge base (4SX, EVI, GCI, DCI, method, contact, etc.)
 *   - Opportunity creation at end of conversation (via cron inactivity)
 */

import "server-only";
import fs from "fs";
import path from "path";
import os from "os";
import ZAI from "z-ai-web-dev-sdk";
import { contextForQuery } from "@/lib/knowledge";
import { createCrmLead, findLeadByPhone, updateLeadDescription, executeKw } from "@/lib/odoo";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Generate reply via Google Gemini API (free tier).
 * Strategy: dynamically list available models, prefer flash, retry on 503.
 */
async function replyWithGemini(opts: {
  systemPrompt: string;
  messages: ChatMessage[];
}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY env var not set");
  }

  let models: string[] = [];
  try {
    const listRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const flashModels = (listData?.models || [])
        .filter((m: any) => {
          const name = m.name?.replace("models/", "") || "";
          const supports = m.supportedGenerationMethods || [];
          return name.includes("flash") && supports.includes("generateContent");
        })
        .map((m: any) => m.name.replace("models/", ""));
      models = flashModels.length > 0 ? flashModels : [];
      console.log(`[Performe+-Debug] Available flash models: ${models.join(", ")}`);
    }
  } catch (e) {
    console.log(`[Performe+-Debug] ListModels failed: ${e}`);
  }

  if (models.length === 0) {
    models = [
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
    ];
    console.log(`[Performe+-Debug] Using fallback model list: ${models.join(", ")}`);
  }

  if (process.env.GEMINI_MODEL) {
    models.unshift(process.env.GEMINI_MODEL);
  }

  const contents = opts.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const body = {
    system_instruction: {
      parts: [{ text: opts.systemPrompt }],
    },
    contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 800,
      topP: 0.95,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };

  let lastError = "";
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    console.log(`[Performe+-Debug] Trying Gemini model: ${model}`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.status === 503 || res.status === 429) {
          const waitMs = 1000 * Math.pow(2, attempt - 1);
          console.log(`[Performe+-Debug] Gemini ${model} returned ${res.status} (attempt ${attempt}/3). Waiting ${waitMs}ms...`);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          lastError = `Gemini ${model}: ${res.status} (overloaded after 3 attempts)`;
          break;
        }

        if (!res.ok) {
          const errText = await res.text();
          if (res.status === 404) {
            console.log(`[Performe+-Debug] Gemini ${model} not found (404). Trying next model...`);
            lastError = `Gemini ${model}: 404 not found`;
            break;
          }
          console.log(`[Performe+-Debug] Gemini ${model} error ${res.status}: ${errText.slice(0, 200)}`);
          lastError = `Gemini ${model}: ${res.status}`;
          break;
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (!text) {
          console.error(`[Performe+-Debug] Gemini ${model} empty response:`, JSON.stringify(data).slice(0, 300));
          if (data?.candidates?.[0]?.finishReason === "SAFETY") {
            lastError = `Gemini ${model}: blocked by safety filter`;
            break;
          }
          lastError = `Gemini ${model}: empty response`;
          break;
        }
        console.log(`[Performe+-Debug] Gemini ${model} OK (len=${text.length})`);
        return text.trim();
      } catch (e) {
        lastError = `Gemini ${model}: ${e}`;
        console.log(`[Performe+-Debug] Gemini ${model} error: ${e}`);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        break;
      }
    }
  }

  throw new Error(`All Gemini models failed. Last error: ${lastError}`);
}

/**
 * Fallback: z-ai-web-dev-sdk (only works inside Z.ai sandbox)
 */
function ensureZaiConfig(): void {
  const config: Record<string, string> = {
    baseUrl: "https://internal-api.z.ai/v1",
    apiKey: "Z.ai",
    token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiNzMyNmE5MmYtOGJlMy00YzBjLTg2NWYtM2YxMTlhYTliNzBjIiwiY2hhdF9pZCI6ImNoYXQtMjhlZjIyYTItYTVhMC00NzM5LWJmZjQtMWY5ZGUxNGNjZTkwIiwicGxhdGZvcm0iOiJ6YWkifQ.AWyh99Y5a1MCsTkO8K5XVPxZOZEG-oyWVqgPquihctQ",
    userId: "7326a92f-8be3-4c0c-865f-3f119aa9b70c",
    chatId: "chat-28ef22a2-a5a0-4739-bff4-1f9de14cce90",
  };
  for (const loc of [
    path.join(process.cwd(), ".z-ai-config"),
    path.join(os.homedir(), ".z-ai-config"),
  ]) {
    try {
      fs.writeFileSync(loc, JSON.stringify(config), { mode: 0o644 });
    } catch (e) {
      // ignore
    }
  }
}

async function replyWithZaiSdk(opts: {
  systemPrompt: string;
  messages: ChatMessage[];
}): Promise<string> {
  ensureZaiConfig();
  const zai = await ZAI.create();
  const completion = await zai.chat.completions.create({
    messages: [
      { role: "assistant", content: opts.systemPrompt },
      ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    thinking: { type: "disabled" },
    temperature: 0.4,
    max_tokens: 800,
  });
  return (completion.choices?.[0]?.message?.content || "").trim();
}

/**
 * SYSTEM PROMPT — Performe+ Assistant
 * Pattern: similar to Nytro's ai.agent #5 (large embedded knowledge + service flow).
 * Sources: scraped performemais.com + 4sx.performemais.com + curated content.
 */
const SYSTEM_PROMPT = `Você é o Assistente Virtual da **Performe+**, escola brasileira de vendas e desenvolvimento comercial. Razão social: PJAM SERVIÇOS E CONSULTORIA EMPRESARIAL LTDA.

## Sobre a Performe+
A Performe+ é uma escola de vendas que desenvolve pessoas e equipes para transformar conhecimento em performance comercial. Nasceu da experiência de profissionais que conhecem a realidade comercial por dentro — executivos com vivência de operação, business school com educação aplicada, especialistas em performance comercial. Atuamos com empresas de diversos portes e segmentos, do MEI à grande empresa. Oferecemos cursos abertos (turmas públicas), in-company (dentro da empresa) e workshops sob medida.

## Método PERFORME+
Framework exclusivo que conecta pessoas, estratégia, tecnologia e execução para gerar resultados sustentáveis. 4 pilares:
1. HUMANO — Autoconhecimento e relações
2. INTELIGÊNCIA — Aprendizado e estratégia
3. TECNOLOGIA — Inovação e ferramentas
4. EVOLUÇÃO — Crescimento e transformação
Performance não nasce. Ela é construída.

## Nossos Cursos (4 programas)
1. **PERFORME+ 4SX** (Four Skills Experience) — Treinamento PRESENCIAL intensivo em performance comercial. Para profissionais que já dominam a operação comercial e querem ampliar sua capacidade de desenvolver pessoas, competências e performance. 4 especialistas, 4 competências, 8 horas de experiência. Investimento: R$ 799 à vista ou 12x de R$ 79,90. Data: 24/10/2026. Horário: 9h às 19h. Local: Hotel Euro Suite Curitiba Batel By Nacional Inn (Curitiba/PR).
   As 4 competências do 4SX:
   - MENTE — Inteligência Emocional + PNL (com Hani Dufech)
   - DECISÃO — NeuroVendas (com Adriano Costa)
   - COMUNICAÇÃO — Comunicação Estratégica (com Augusto Klein)
   - PRESENÇA — Social Selling (com Victória Borochok)

2. **PERFORME+ VENDAS (EVI)** — Formação de Executivos de Vendas. Para profissionais que já vivem vendas e querem alcançar um novo nível de consistência, relacionamento, negociação e resultado.

3. **PERFORME+ LIDERANÇA (GCI)** — Formação Executiva em Gestão Comercial. Quando um bom vendedor assume uma equipe, o jogo muda. Sua performance passa a depender da capacidade de fazer outras pessoas performarem.

4. **PERFORME+ ESTRATÉGIA (DCI)** — Formação Executiva para Diretores e Empresários. Na direção, vender deixa de ser apenas uma atividade e passa a ser uma capacidade da organização.

## Para quem é a Performe+
Executivos, consultores, vendedores, SDRs, BDRs, representantes, autônomos, empreendedores, supervisores, coordenadores, gestores comerciais. Tanto profissionais autônomos quanto equipes corporativas.

## Idioma e tom
- Responda SEMPRE em português brasileiro, com tom profissional, consultivo e objetivo.
- Use "você". Se o lead escrever em espanhol, responda em espanhol.
- WhatsApp: respostas curtas (máx. 3 parágrafos), sem markdown, sem links.
- Direto ao ponto, sem floreios.

## FLUXO DE ATENDIMENTO
### Quando o lead manda SAUDAÇÃO ("olá", "bom dia", "oi", etc.)
1. Primeiro retribua a saudação e se apresente como assistente virtual da Performe+
2. Depois pergunte como pode ajudar
Ex: Lead "Bom dia!" → Bot "Bom dia! Tudo bem? Sou o assistente virtual da Performe+. Como posso te ajudar hoje?"

### Quando o lead faz pergunta direta (sem saudação)
- Responda diretamente, sem saudação.

## Regras
1. NUNCA pule a saudação se o lead cumprimentar.
2. Qualifique perguntando: qual área de interesse (4SX, vendas, liderança, estratégia), cidade, porte da empresa, prazo, e-mail e telefone.
3. NUNCA invente preços além dos informados (4SX: R$ 799 à vista ou 12x R$ 79,90). Para outros cursos, diga que "cada projeto é dimensionado sob medida e um especialista enviará a proposta".
4. Use a BASE DE CONHECIMENTO abaixo como fonte autoritativa.
5. Quando o lead fornecer e-mail E telefone E nome, agradeça e diga que um especialista da Performe+ vai entrar em contato em até 1 dia útil.
6. NÃO mencione Odoo, IA, Gemini, Vercel, Render, ou qualquer tecnologia interna. Você é apenas o "Assistente Virtual da Performe+".
7. Se perguntarem sobre assuntos TOTALMENTE fora do escopo (política, futebol, religião), responda educadamente: "Sou o assistente virtual da Performe+ e ajudo com informações sobre nossos cursos de vendas e programas de desenvolvimento comercial. Posso te ajudar com algo relacionado?"
8. Se o lead pedir para falar com humano, responda "Um especialista da Performe+ vai assumir a conversa em até 1 dia útil. Obrigado!" e não gere mais respostas automáticas.

## Base de conhecimento Performe+
{KNOWLEDGE_CONTEXT}

## Criação de oportunidade
Quando a conversa terminar (10 minutos sem nova mensagem do lead), o sistema automaticamente cria uma OPORTUNIDADE no CRM da Performe+ com toda a transcrição da conversa. Você não precisa fazer nada — apenas conduza a conversa de forma natural para coletar nome + (telefone ou e-mail) do lead.`;

function buildSystemPrompt(userQuery: string): string {
  const ctx = contextForQuery(userQuery, 5000);
  return SYSTEM_PROMPT.replace("{KNOWLEDGE_CONTEXT}", ctx || "(Base de conhecimento vazia.)");
}

function extractLeadInfo(transcript: string, contactName?: string): {
  name?: string;
  email?: string;
  phone?: string;
} {
  const emailMatch = transcript.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const phoneMatch = transcript.match(/\+?\d[\d\s\-()]{7,}\d/);
  let name: string | undefined;
  const m = transcript.match(
    /(?:meu nome é|me chamo|sou o|sou a|nome[:\s]+)\s+([A-Za-zÀ-ú][A-Za-zÀ-ú\s]{2,40})/i
  );
  if (m) name = m[1].trim().split(/\s+/).slice(0, 4).join(" ");
  if (!name && contactName) {
    name = contactName;
  }
  return {
    name,
    email: emailMatch?.[0],
    phone: phoneMatch?.[0],
  };
}

export async function replyWhatsApp(opts: {
  messages: ChatMessage[];
  channel?: "whatsapp" | "web";
  contactName?: string;
}): Promise<{
  content: string;
  leadCreated?: number;
  leadInfo?: { name?: string; email?: string; phone?: string };
}> {
  const { messages, contactName } = opts;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userQuery = lastUser?.content || "";

  const systemPrompt = buildSystemPrompt(userQuery);
  const fullSystem = contactName
    ? `${systemPrompt}\n\n## Contexto do lead\nNome conhecido: ${contactName}\nCanal de origem: WhatsApp`
    : `${systemPrompt}\n\n## Contexto do lead\nCanal de origem: WhatsApp`;

  let rawContent = "";
  let provider = "";

  if (process.env.GEMINI_API_KEY) {
    provider = "Gemini";
    console.log("[Performe+] Using Gemini API for reply...");
    try {
      rawContent = await replyWithGemini({ systemPrompt: fullSystem, messages });
      console.log(`[Performe+-Debug] Gemini OK (len=${rawContent.length})`);
    } catch (e) {
      console.error(`[Performe+-Debug] Gemini failed: ${e}. Trying z-ai-sdk fallback...`);
      try {
        provider = "z-ai-sdk (fallback)";
        rawContent = await replyWithZaiSdk({ systemPrompt: fullSystem, messages });
      } catch (e2) {
        console.error(`[Performe+-Debug] z-ai-sdk also failed: ${e2}`);
        rawContent = "Olá! Sou o assistente virtual da Performe+. No momento estou com dificuldade técnica para responder. Um especialista entrará em contato em breve. Para falar com humano, responda 'humano'.";
      }
    }
  } else {
    provider = "z-ai-sdk";
    console.log("[Performe+] No GEMINI_API_KEY — using z-ai-sdk (sandbox only)...");
    try {
      rawContent = await replyWithZaiSdk({ systemPrompt: fullSystem, messages });
    } catch (e) {
      console.error(`[Performe+-Debug] z-ai-sdk failed: ${e}`);
      rawContent = "Olá! Sou o assistente virtual da Performe+. No momento estou com dificuldade técnica para responder. Um especialista entrará em contato em breve. Para falar com humano, responda 'humano'.";
    }
  }

  let content = rawContent
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1")
    .replace(/^#+\s?/gm, "")
    .replace(/`/g, "")
    .replace(/\s*\n\s*\n\s*/g, "\n\n")
    .trim()
    .slice(0, 4000);

  console.log(`[Performe+] Reply generated via ${provider} (len=${content.length})`);

  // Check if we should create/update a lead in Odoo (live, during conversation)
  let leadCreated: number | undefined;
  const transcript = messages.map((m) => m.content).join("\n") + "\n" + userQuery;
  const leadInfo = extractLeadInfo(transcript, contactName);
  if (leadInfo.name && (leadInfo.email || leadInfo.phone)) {
    const hasIntent = /(orçamento|preço|proposta|implementar|curso|treinamento|4sx|evi|gci|dci|vendas|lideranca|estrategia|contratar|inscric|inscrever|agendar|consultor|especialista|vaga|performe)/i.test(
      transcript
    );
    if (hasIntent) {
      try {
        const searchPhone = leadInfo.phone || "";
        const existingLead = await findLeadByPhone(searchPhone);
        
        if (existingLead) {
          const oldDesc = existingLead.description || "";
          const newDesc = `${oldDesc}\n\n--- Nova conversa (${new Date().toISOString()}) ---\n${transcript.slice(0, 2000)}`;
          await updateLeadDescription(existingLead.id, newDesc);
          leadCreated = existingLead.id;
          console.log(`[Performe+] Updated existing lead ${existingLead.id} with new conversation`);
        } else {
          leadCreated = await createCrmLead({
            name: `Lead WhatsApp — ${leadInfo.name}`,
            partnerName: leadInfo.name,
            email: leadInfo.email,
            phone: leadInfo.phone,
            description: `Lead gerado pelo bot IA da Performe+ via WhatsApp (Render + Gemini).\n\nTranscrição:\n${transcript.slice(0, 1500)}`,
          });
          console.log(`[Performe+] Lead created in CRM: id=${leadCreated}`);
        }
      } catch (e) {
        console.error("[Performe+] Lead operation failed:", e);
      }
    }
  }

  return { content, leadCreated, leadInfo };
}

/**
 * Convert a lead to opportunity in Odoo CRM.
 * Called by the cron-check-inactivity route when a conversation ends.
 */
export async function convertLeadToOpportunity(leadId: number, opts: {
  partnerName?: string;
  partnerId?: number;
  phone?: string;
  email?: string;
  transcript?: string;
}): Promise<{ ok: boolean; opportunityId?: number; error?: string }> {
  try {
    // In Odoo CRM, to convert a lead into an opportunity:
    //   - Set type='opportunity'
    //   - Optionally call action_convert_opportunity (server action)
    //   - Assign to a salesperson (default user_id = admin/salesperson)
    //   - Set a stage_id (e.g., "New")
    const vals: Record<string, any> = {
      type: "opportunity",
    };

    // Default salesperson (Paulo = user_id 2 or use admin)
    const salespersonId = parseInt(process.env.PERFORME_DEFAULT_SALESPERSON_ID || "2", 10);
    if (salespersonId > 0) {
      vals.user_id = salespersonId;
    }

    // Default team (from env or 1)
    const teamId = parseInt(process.env.PERFORME_DEFAULT_TEAM_ID || "1", 10);
    if (teamId > 0) {
      vals.team_id = teamId;
    }

    // Default stage "New" — try to find first stage
    try {
      const stages = await executeKw<any>("crm.stage", "search_read", [
        [],
        ["id", "name", "sequence"],
        0, 10, "sequence asc",
      ]);
      if (stages && stages.length > 0) {
        vals.stage_id = stages[0].id;
      }
    } catch (e) {
      console.log(`[Performe+-Opp] Stage lookup failed: ${e}`);
    }

    // Update the lead to opportunity
    await executeKw("crm.lead", "write", [[leadId], vals]);
    console.log(`[Performe+-Opp] Lead ${leadId} converted to opportunity`);

    return { ok: true, opportunityId: leadId };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
