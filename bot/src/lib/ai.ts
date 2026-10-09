/**
 * AI orchestration for the Performe+ WhatsApp bot.
 * Supports two providers:
 *   1. Google Gemini (FREE) — when GEMINI_API_KEY env var is set
 *   2. z-ai-web-dev-sdk (GLM-4.6) — fallback for sandbox environment
 */

import "server-only";
import fs from "fs";
import path from "path";
import os from "os";
import ZAI from "z-ai-web-dev-sdk";
import { contextForQuery } from "@/lib/knowledge";
import { createCrmLead, findLeadByPhone, updateLeadDescription } from "@/lib/odoo";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Generate reply via Google Gemini API (free tier).
 * Docs: https://ai.google.dev/api/rest/v1beta/models/generateContent
 *
 * Strategy:
 *   1. Dynamically list available models from the Gemini API
 *   2. Pick the best "flash" model (fast, free-tier friendly)
 *   3. Retry on 503 (overloaded) with exponential backoff
 */
async function replyWithGemini(opts: {
  systemPrompt: string;
  messages: ChatMessage[];
}): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY env var not set");
  }

  // Step 1: Discover available models dynamically
  let models: string[] = [];
  try {
    const listRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const allModels = (listData?.models || [])
        .map((m: any) => m.name?.replace("models/", "") || "")
        .filter((n: string) => n);
      // Filter to models that support generateContent and are flash (fastest)
      const flashModels = (listData?.models || [])
        .filter((m: any) => {
          const name = m.name?.replace("models/", "") || "";
          const supports = m.supportedGenerationMethods || [];
          return name.includes("flash") && supports.includes("generateContent");
        })
        .map((m: any) => m.name.replace("models/", ""));
      models = flashModels.length > 0 ? flashModels : allModels;
      console.log(`[Performe+-Debug] Available flash models: ${models.join(", ")}`);
    }
  } catch (e) {
    console.log(`[Performe+-Debug] ListModels failed: ${e}`);
  }

  // Fallback to known models if discovery failed
  if (models.length === 0) {
    models = [
      "gemini-3.8-flash",
      "gemini-flash-latest",
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
    ];
    console.log(`[Performe+-Debug] Using fallback model list: ${models.join(", ")}`);
  }

  // Allow user override via env var (try this first)
  if (process.env.GEMINI_MODEL) {
    models.unshift(process.env.GEMINI_MODEL);
  }

  // Convert chat messages to Gemini format
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

  // Step 2: Try each model with retry on 503/429 (exponential backoff)
  let lastError = "";
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    console.log(`[Performe+-Debug] Trying Gemini model: ${model}`);

    // Retry each model up to 3 times on 503/429 with exponential backoff
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.status === 503 || res.status === 429) {
          // Overloaded — exponential backoff: 1s, 2s, 4s
          const waitMs = 1000 * Math.pow(2, attempt - 1);
          console.log(`[Performe+-Debug] Gemini ${model} returned ${res.status} (attempt ${attempt}/3). Waiting ${waitMs}ms...`);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          lastError = `Gemini ${model}: ${res.status} (overloaded after 3 attempts)`;
          break; // try next model
        }

        if (!res.ok) {
          const errText = await res.text();
          if (res.status === 404) {
            console.log(`[Performe+-Debug] Gemini ${model} not found (404). Trying next model...`);
            lastError = `Gemini ${model}: 404 not found`;
            break;
          }
          // Other error — try next model
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

const SYSTEM_PROMPT = `Voce e o Assistente Virtual da **Performe+**, escola de vendas e desenvolvimento comercial.

## REGRA DE ESCOPO
Voce SO responde sobre:
1. A empresa Performe+ (cursos, solucoes, valores)
2. Cursos de vendas (4SX, EVI, DCI, GCI e outros)
3. Desenvolvimento comercial e performance de vendas
4. Treinamentos corporativos e workshops

Se perguntarem sobre QUALQUER OUTRO ASSUNTO, responda educadamente:
"Sou o assistente virtual da Performe+ e so posso ajudar com informacoes sobre nossos cursos de vendas e programas de desenvolvimento comercial. Posso te ajudar com algo relacionado?"

## Sobre a Performe+
A Performe+ e uma escola de vendas que desenvolve pessoas e equipes para transformar conhecimento em performance comercial.
Nossos cursos:
- 4SX (Four Skills Experience) - curso de vendas com 4 modulos
- EVI (Performe+ Vendas)
- DCI (Performe+ Estrategia)
- GCI (Performe+ Lideranca)
Outros programas presenciais e online.

## Idioma e tom
- Responda SEMPRE em portugues brasileiro, com tom profissional e objetivo.
- WhatsApp: respostas curtas (max. 3 paragrafos), sem markdown, sem links.
- Direto ao ponto, sem floreios.

## FLUXO DE ATENDIMENTO
1. Cumprimentar quando o lead mandar saudacao
2. Entender a necessidade do lead
3. Qualificar perguntando: segmento, tamanho da empresa, cidade, prazo
4. Coletar nome, email e telefone
5. Quando tiver nome + (email ou telefone), criar lead no CRM

## CRIACAO DE LEAD
Quando o lead fornecer NOME + (E-MAIL ou TELEFONE) + demonstrar interesse comercial, o sistema criara um lead no CRM automaticamente.

## Base de conhecimento
{KNOWLEDGE_CONTEXT}`;

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
  // If name not found in text, use contactName from Meta webhook
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

  // Generate reply — prefer Gemini, fall back to z-ai-sdk
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

  // Strip markdown for WhatsApp
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

  // Check if we should create/update a lead in Odoo
  let leadCreated: number | undefined;
  const transcript = messages.map((m) => m.content).join("\n") + "\n" + userQuery;
  const leadInfo = extractLeadInfo(transcript, contactName);
  if (leadInfo.name && (leadInfo.email || leadInfo.phone)) {
    const hasIntent = /(orçamento|preço|proposta|implementar|odoo|erp|sistema|contratar|demo|teste|agendar|performe|consultor|especialista)/i.test(
      transcript
    );
    if (hasIntent) {
      try {
        // First: search for existing lead by phone
        const searchPhone = leadInfo.phone || "";
        const existingLead = await findLeadByPhone(searchPhone);
        
        if (existingLead) {
          // UPDATE existing lead with new conversation transcript
          const oldDesc = existingLead.description || "";
          const newDesc = `${oldDesc}\n\n--- Nova conversa (${new Date().toISOString()}) ---\n${transcript.slice(0, 2000)}`;
          await updateLeadDescription(existingLead.id, newDesc);
          leadCreated = existingLead.id;
          console.log(`[Performe+] Updated existing lead ${existingLead.id} with new conversation`);
        } else {
          // CREATE new lead
          leadCreated = await createCrmLead({
            name: `Lead WhatsApp — ${leadInfo.name}`,
            partnerName: leadInfo.name,
            email: leadInfo.email,
            phone: leadInfo.phone,
            description: `Lead gerado pelo bot IA da Performe+ via WhatsApp (Vercel + Gemini).\n\nTranscrição:\n${transcript.slice(0, 1500)}`,
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
