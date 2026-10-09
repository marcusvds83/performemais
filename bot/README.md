# Performe+ Bot

Bot IA da Performe+ para WhatsApp, deploy no Render, integrado ao Odoo SaaS 19.4.

## O que faz

Quando um cliente manda mensagem no WhatsApp da Performe+:
1. Meta envia webhook -> Render (este projeto)
2. Render verifica no Odoo se ha operador online
   - Se sim: nao faz nada (deixa humano atender)
   - Se nao: gera resposta com IA (Gemini)
3. Render envia a resposta via Odoo (whatsapp.composer)
4. Se detectar nome+email+telefone+intencao -> cria Lead no CRM

## Variaveis de ambiente (Render)

| Nome | Valor |
|---|---|
| ODOO_URL | https://performe.odoo.com |
| ODOO_DB | performe |
| ODOO_USERNAME | paulo.yure@gmail.com |
| ODOO_API_KEY | (sua API key) |
| GEMINI_API_KEY | (sua chave Gemini) |
| WHATSAPP_VERIFY_TOKEN | performe-bot-verify-2026 |
| PERFORME_OPERATOR_USER_IDS | 5 |
| PERFORME_HANDOFF_WORDS | humano,atendente,operador,falar com pessoa,vendedor |

## Deploy no Render

1. Conectar repo GitHub no Render
2. Tipo: Web Service
3. Build: npm install && npm run build
4. Start: npm start
5. Variaveis de ambiente: ver tabela acima
