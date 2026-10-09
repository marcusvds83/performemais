/**
 * services/bot-ai.js — IA Gemini para o bot WhatsApp
 * ==================================================
 * Chamada direta via fetch à API do Google Gemini.
 * Sem dependencias externas (nao usa z-ai-sdk, nao usa Next.js).
 * 
 * Funcoes:
 *   - replyWithGemini(systemPrompt, messages): chama Gemini API
 *   - replyWhatsApp(env, opts): gerencia reply + criacao de lead
 *   - extractLeadInfo(transcript, contactName): extrai nome/email/telefone
 *   - buildSystemPrompt(userQuery): monta prompt com knowledge base
 *   - contextForQuery(query, maxChars): RAG simples baseado em keywords
 */

const fs = require('fs');
const path = require('path');
const { createCrmLead, findLeadByPhone, updateLeadDescription } = require('./bot-odoo');

// === Knowledge base ===
let DOCS = [];
try {
  const knowledgePath = path.join(__dirname, 'performe-data', 'knowledge.json');
  if (fs.existsSync(knowledgePath)) {
    DOCS = JSON.parse(fs.readFileSync(knowledgePath, 'utf-8'));
  } else {
    // Tenta carregar da pasta bot (caso o servico unificado use bot/src/lib/performe-data)
    const altPath = path.join(__dirname, '..', 'bot', 'src', 'lib', 'performe-data', 'knowledge.json');
    if (fs.existsSync(altPath)) {
      DOCS = JSON.parse(fs.readFileSync(altPath, 'utf-8'));
    }
  }
} catch (e) {
  console.log(`[Bot-AI] Knowledge load failed: ${e}`);
  DOCS = [];
}
DOCS = DOCS.filter(d => d && d.text && !d.title.toLowerCase().includes('page not found'));
console.log(`[Bot-AI] Loaded ${DOCS.length} knowledge docs`);

function normalize(s) {
  return (s || '').toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'de','da','do','das','dos','e','ou','para','por','com','a','o','as','os',
  'um','uma','uns','umas','no','na','nos','nas','em','que','se','sao','ao',
  'the','of','to','in','on','for','and','or','is','are',
]);

function tokenize(query) {
  return normalize(query).split(' ').filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function retrieve(query, topK = 4) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return DOCS.slice(0, topK);
  const scored = DOCS.map(doc => {
    const norm = normalize(doc.text + ' ' + doc.title);
    let score = 0;
    for (const tok of tokens) {
      let idx = norm.indexOf(tok);
      while (idx !== -1) {
        score += 1;
        idx = norm.indexOf(tok, idx + tok.length);
      }
    }
    const titleNorm = normalize(doc.title);
    for (const tok of tokens) {
      if (titleNorm.includes(tok)) score += 3;
    }
    return { doc, score };
  });
  return scored.filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(s => s.doc);
}

function contextForQuery(query, maxChars = 5000) {
  const docs = retrieve(query, 4);
  let out = '';
  for (const d of docs) {
    const block = `## ${d.title}\nURL: ${d.url}\n${(d.text || '').slice(0, 2000)}\n\n`;
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out.trim();
}

// === System prompt (igual ao bot Next.js) ===
const SYSTEM_PROMPT = `Voce e o Assistente Virtual da **Performe+**, escola brasileira de vendas e desenvolvimento comercial. Razao social: PJAM SERVICOS E CONSULTORIA EMPRESARIAL LTDA.

## Sobre a Performe+
A Performe+ e uma escola de vendas que desenvolve pessoas e equipes para transformar conhecimento em performance comercial. Nasceu da experiencia de profissionais que conhecem a realidade comercial por dentro — executivos com vivencia de operacao, business school com educacao aplicada, especialistas em performance comercial. Atuamos com empresas de diversos portes e segmentos, do MEI a grande empresa. Oferecemos cursos abertos (turmas publicas), in-company (dentro da empresa) e workshops sob medida.

## Metodo PERFORME+
Framework exclusivo que conecta pessoas, estrategia, tecnologia e execucao para gerar resultados sustentaveis. 4 pilares:
1. HUMANO — Autoconhecimento e relacoes
2. INTELIGENCIA — Aprendizado e estrategia
3. TECNOLOGIA — Inovacao e ferramentas
4. EVOLUCAO — Crescimento e transformacao
Performance nao nasce. Ela e construida.

## Nossos Cursos (4 programas)
1. **PERFORME+ 4SX** (Four Skills Experience) — Treinamento PRESENCIAL intensivo em performance comercial. Para profissionais que ja dominam a operacao comercial e querem ampliar sua capacidade de desenvolver pessoas, competencias e performance. 4 especialistas, 4 competencias, 8 horas de experiencia. Investimento: R$ 799 a vista ou 12x de R$ 79,90. Data: 24/10/2026. Horario: 9h as 19h. Local: Hotel Euro Suite Curitiba Batel By Nacional Inn (Curitiba/PR).
   As 4 competencias do 4SX:
   - MENTE — Inteligencia Emocional + PNL (com Hani Dufech)
   - DECISAO — NeuroVendas (com Adriano Costa)
   - COMUNICACAO — Comunicacao Estrategica (com Augusto Klein)
   - PRESENCA — Social Selling (com Vitoria Borochok)

2. **PERFORME+ VENDAS (EVI)** — Formacao de Executivos de Vendas. Para profissionais que ja vivem vendas e querem alcancar um novo nivel de consistencia, relacionamento, negociacao e resultado.

3. **PERFORME+ LIDERANCA (GCI)** — Formacao Executiva em Gestao Comercial. Quando um bom vendedor assume uma equipe, o jogo muda. Sua performance passa a depender da capacidade de fazer outras pessoas performarem.

4. **PERFORME+ ESTRATEGIA (DCI)** — Formacao Executiva para Diretores e Empresarios. Na direcao, vender deixa de ser apenas uma atividade e passa a ser uma capacidade da organizacao.

## Para quem e a Performe+
Executivos, consultores, vendedores, SDRs, BDRs, representantes, autonomos, empreendedores, supervisores, coordenadores, gestores comerciais. Tanto profissionais autonomos quanto equipes corporativas.

## Idioma e tom
- Responda SEMPRE em portugues brasileiro, com tom profissional, consultivo e objetivo.
- Use "voce". Se o lead escrever em espanhol, responda em espanhol.
- WhatsApp: respostas curtas (max. 3 paragrafos), sem markdown, sem links.
- Direto ao ponto, sem floreios.

## FLUXO DE ATENDIMENTO
### Quando o lead manda SAUDACAO ("ola", "bom dia", "oi", etc.)
1. Primeiro retribua a saudacao e se apresente como assistente virtual da Performe+
2. Depois pergunte como pode ajudar
Ex: Lead "Bom dia!" -> Bot "Bom dia! Tudo bem? Sou o assistente virtual da Performe+. Como posso te ajudar hoje?"

### Quando o lead faz pergunta direta (sem saudacao)
- Responda diretamente, sem saudacao.

## Regras
1. NUNCA pule a saudacao se o lead cumprimentar.
2. Qualifique perguntando: qual area de interesse (4SX, vendas, lideranca, estrategia), cidade, porte da empresa, prazo, e-mail e telefone.
3. NUNCA invente precos alem dos informados (4SX: R$ 799 a vista ou 12x R$ 79,90). Para outros cursos, diga que "cada projeto e dimensionado sob medida e um especialista enviara a proposta".
4. Use a BASE DE CONHECIMENTO abaixo como fonte autoritativa.
5. Quando o lead fornecer e-mail E telefone E nome, agradeca e diga que um especialista da Performe+ vai entrar em contato em ate 1 dia util.
6. NAO mencione Odoo, IA, Gemini, Vercel, Render, ou qualquer tecnologia interna. Voce e apenas o "Assistente Virtual da Performe+".
7. Se perguntarem sobre assuntos TOTALMENTE fora do escopo (politica, futebol, religiao), responda educadamente: "Sou o assistente virtual da Performe+ e ajudo com informacoes sobre nossos cursos de vendas e programas de desenvolvimento comercial. Posso te ajudar com algo relacionado?"
8. Se o lead pedir para falar com humano, responda "Um especialista da Performe+ vai assumir a conversa em ate 1 dia util. Obrigado!" e nao gere mais respostas automaticas.

## Base de conhecimento Performe+
{KNOWLEDGE_CONTEXT}

## Criacao de oportunidade
Quando a conversa terminar (10 minutos sem nova mensagem do lead), o sistema automaticamente cria uma OPORTUNIDADE no CRM da Performe+ com toda a transcricao da conversa. Voce nao precisa fazer nada — apenas conduza a conversa de forma natural para coletar nome + (telefone ou e-mail) do lead.`;

function buildSystemPrompt(userQuery) {
  const ctx = contextForQuery(userQuery, 5000);
  return SYSTEM_PROMPT.replace('{KNOWLEDGE_CONTEXT}', ctx || '(Base de conhecimento vazia.)');
}

// === Gemini API ===
async function replyWithGemini(systemPrompt, messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY env var not set');

  // Lista de modelos para tentar
  let models = [];
  try {
    const listRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const flashModels = (listData?.models || [])
        .filter(m => {
          const name = m.name?.replace('models/', '') || '';
          const supports = m.supportedGenerationMethods || [];
          return name.includes('flash') && supports.includes('generateContent');
        })
        .map(m => m.name.replace('models/', ''));
      models = flashModels;
    }
  } catch (e) {
    console.log(`[Bot-AI] ListModels failed: ${e}`);
  }

  if (models.length === 0) {
    models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  }
  if (process.env.GEMINI_MODEL) {
    models.unshift(process.env.GEMINI_MODEL);
  }

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 800, topP: 0.95 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  let lastError = '';
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    console.log(`[Bot-AI] Trying Gemini model: ${model}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 503 || res.status === 429) {
          const waitMs = 1000 * Math.pow(2, attempt - 1);
          console.log(`[Bot-AI] ${model} returned ${res.status} (attempt ${attempt}/3). Waiting ${waitMs}ms...`);
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }
          lastError = `${model}: ${res.status} overloaded`;
          break;
        }
        if (!res.ok) {
          const errText = await res.text();
          if (res.status === 404) {
            lastError = `${model}: 404`;
            break;
          }
          console.log(`[Bot-AI] ${model} error ${res.status}: ${errText.slice(0, 200)}`);
          lastError = `${model}: ${res.status}`;
          break;
        }
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) {
          lastError = `${model}: empty response`;
          break;
        }
        console.log(`[Bot-AI] ${model} OK (len=${text.length})`);
        return text.trim();
      } catch (e) {
        lastError = `${model}: ${e}`;
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        break;
      }
    }
  }
  throw new Error(`All Gemini models failed. Last: ${lastError}`);
}

// === Extracao de info do lead ===
function extractLeadInfo(transcript, contactName) {
  const emailMatch = transcript.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const phoneMatch = transcript.match(/\+?\d[\d\s\-()]{7,}\d/);
  let name;
  const m = transcript.match(
    /(?:meu nome é|me chamo|sou o|sou a|nome[:\s]+)\s+([A-Za-zÀ-ú][A-Za-zÀ-ú\s]{2,40})/i
  );
  if (m) name = m[1].trim().split(/\s+/).slice(0, 4).join(' ');
  if (!name && contactName) name = contactName;
  return { name, email: emailMatch?.[0], phone: phoneMatch?.[0] };
}

// === Funcao principal: replyWhatsApp ===
async function replyWhatsApp(env, opts) {
  const { messages, contactName } = opts;
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userQuery = lastUser?.content || '';

  const systemPrompt = buildSystemPrompt(userQuery);
  const fullSystem = contactName
    ? `${systemPrompt}\n\n## Contexto do lead\nNome conhecido: ${contactName}\nCanal de origem: WhatsApp`
    : `${systemPrompt}\n\n## Contexto do lead\nCanal de origem: WhatsApp`;

  let rawContent = '';
  try {
    rawContent = await replyWithGemini(fullSystem, messages);
  } catch (e) {
    console.error(`[Bot-AI] Gemini failed: ${e}`);
    rawContent = 'Ola! Sou o assistente virtual da Performe+. No momento estou com dificuldade tecnica para responder. Um especialista entrara em contato em breve. Para falar com humano, responda "humano".';
  }

  // Limpa markdown
  let content = rawContent
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1')
    .replace(/^#+\s?/gm, '')
    .replace(/`/g, '')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .trim()
    .slice(0, 4000);

  // Cria lead se detectar info
  let leadCreated;
  const transcript = messages.map(m => m.content).join('\n') + '\n' + userQuery;
  const leadInfo = extractLeadInfo(transcript, contactName);
  if (leadInfo.name && (leadInfo.email || leadInfo.phone)) {
    const hasIntent = /(orçamento|preço|proposta|implementar|curso|treinamento|4sx|evi|gci|dci|vendas|lideranca|estrategia|contratar|inscric|inscrever|agendar|consultor|especialista|vaga|performe)/i.test(transcript);
    if (hasIntent) {
      try {
        const existingLead = await findLeadByPhone(env, leadInfo.phone || '');
        if (existingLead) {
          const oldDesc = existingLead.description || '';
          const newDesc = `${oldDesc}\n\n--- Nova conversa (${new Date().toISOString()}) ---\n${transcript.slice(0, 2000)}`;
          await updateLeadDescription(env, existingLead.id, newDesc);
          leadCreated = existingLead.id;
        } else {
          leadCreated = await createCrmLead(env, {
            name: `Lead WhatsApp — ${leadInfo.name}`,
            partnerName: leadInfo.name,
            email: leadInfo.email,
            phone: leadInfo.phone,
            description: `Lead gerado pelo bot IA da Performe+ via WhatsApp.\n\nTranscrição:\n${transcript.slice(0, 1500)}`,
          });
        }
      } catch (e) {
        console.error('[Bot-AI] Lead op failed:', e);
      }
    }
  }

  return { content, leadCreated, leadInfo };
}

module.exports = {
  replyWhatsApp,
  replyWithGemini,
  buildSystemPrompt,
  contextForQuery,
  extractLeadInfo,
};
