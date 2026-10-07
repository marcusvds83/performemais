# Performe+ NFS-e

Middleware de emissão própria de NFS-e e NF-e para a **Performe+** (venda de cursos) — Pontal do Paraná/PR (matriz). Fork do `accel-nfse`, adaptado para deploy no **Vercel** (em vez de Vercel) com cofre Firebase.

## Visão Geral

A Performe+ vende cursos de treinamento (4SX CWB, 4SX PG, etc.) registrados no Odoo 19 Online (`https://performe.odoo.com`). Quando uma fatura é marcada como "pendente" via botão Odoo, este middleware:

1. Lê a fatura via XML-RPC do Odoo
2. Gera XML DPS no padrão SPED NFS-e v1.01
3. Assina digitalmente com certificado A1 (guardado no Firebase)
4. Envia para a API REST da SEFIN Nacional (mTLS)
5. Atualiza o Odoo com número/chave de acesso/XML/PDF
6. Anexa o XML e o DANFSe no chatter da fatura

## Arquitetura

```
Odoo 19 (fatura com x_performe_nfse_status = "pendente")
    | XML-RPC (polling ou Vercel Cron)
Middleware Node.js (Vercel)
    | certificado A1 (PFX/PEM)
Firebase (cofre Firestore)
    | XML DPS assinado (SPED NFS-e v1.01)
SEFIN Nacional (REST + mTLS)
    | autorizada
Gera PDF DANFSe localmente (PDFKit)
    | anexa XML + PDF + atualiza status
Odoo (chatter da fatura)
```

## Estrutura do Projeto

```
performemais/
  server.js                  Servidor Express (handler Vercel)
  config.js                  Configurações (env vars)
  vercel.json                Configuração do Vercel (rotas + cron)
  package.json
  .env.example               Template de variáveis de ambiente
  services/
    firebase-cert.js         Cofre do certificado A1 no Firebase
    firebase-rest.js         Cliente Firestore REST (sem gRPC)
    pfx-openssl.js           Fallback OpenSSL para PFX
    nfse-xml.js              Gerador de XML DPS
    nfse-signer.js           Assinatura digital XMLDSig
    nfse-client.js           Cliente REST SEFIN (SPED NFS-e v1.01)
    nfse-cancelamento.js     Cancelamento de NFS-e
    nfse-odoo-emit.js        Polling + integração Odoo
    nfse-pdf.js              Gerador de DANFSe PDF
    trib-config.js           Config tributária (IBS/CBS opcional)
  routes/
    nfse-cert.js             Rotas de certificado
    nfse.js                  Rotas de emissão/cancelamento
    dashboard.js             Rotas do painel admin
    admin-tools.js           Ferramentas administrativas
    cron.js                   Endpoint /api/cron/process-pending (Vercel Cron)
  public/
    index.html               Frontend SPA
    app.js                   Lógica do frontend
    styles.css               Estilos
    logo-performe.png        Logo (placeholder)
  assets/
    logo-performe.png        Logo para PDF DANFSe
  odoo-scripts/             Scripts de setup do Odoo
  data/
    trib-config.json        Config tributária local
```

## Deploy no Vercel

1. **Fork este repo** no GitHub (ou use o repo `marcusvds83/performemais`)
2. No Vercel, **New Project > Import Git Repository** > escolha `performemais`
3. **Framework Preset**: Other (Node.js)
4. **Build Command**: `npm install`
5. **Output Directory**: (vazio — usa `vercel.json`)
6. **Install Command**: `npm install`
7. Configure as **Environment Variables** (ver `.env.example`)
8. Deploy — o `vercel.json` cuida das rotas e do cron

### Cron (essencial para Vercel)

O Vercel é **serverless**: o `setInterval` não persiste entre invocações frias.

**Importante sobre o Vercel Free (Hobby):** o plano gratuito só permite cron **diário** — não de minuto. Por isso, usamos **GitHub Actions** como cron principal, que chama `GET /api/cron/process-pending` a cada 5 minutos (limite free do GitHub Actions).

Arquivo: `.github/workflows/cron-process-pending.yml`

Para o GitHub Actions funcionar, configure **2 secrets** no repositório GitHub:
- `VERCEL_URL`: URL do deploy (ex: `https://performemais.vercel.app`)
- `CRON_SECRET`: mesmo valor configurado no Vercel

Caminho: GitHub repo → Settings → Secrets and variables → Actions → New repository secret.

O endpoint `/api/cron/process-pending` aceita requisições com o header `x-cron-secret: <valor>` (mesma validação que o Vercel Cron faria).

**Alternativas para cron de 1 minuto (se 5 min não for suficiente):**
- Upgrade Vercel Pro ($20/mês) — restaurar `crons` no `vercel.json` com `"*/1 * * * *"`
- Usar [cron-job.org](https://cron-job.org) (free, 1 min) apontando para o mesmo endpoint

## Setup do Odoo (Passo Único)

```bash
# Execute o script único que cria tudo:
ODOO_URL=https://performe.odoo.com/odoo \
ODOO_DB=performe \
ODOO_USER=paulo.yure@gmail.com \
ODOO_API_KEY=122307897e39fd4fd6119cecca38313cf7422d8b \
python3 odoo-scripts/setup-completo-odoo.py
```

O script cria:
- 10 campos customizados `x_performe_*` no `account.move`
- Botão "Emitir NFS-e" (Server Action)
- Botão "Cancelar NFS-e" (Server Action)

Para configurar campos de produto (NBS, alíquota ISS, etc.):
```bash
ODOO_URL=... ODOO_DB=performe ODOO_USER=... ODOO_API_KEY=... \
python3 odoo-scripts/setup-view-produto-nfse.py
```

## Firebase Setup (Cofre do Certificado A1)

1. Crie um projeto no [Firebase Console](https://console.firebase.google.com/)
   - Sugestão de nome: `performe-nfse-prod`
2. Va em **Project Settings > Service Accounts**
3. Clique em **Generate New Private Key** (baixa JSON)
4. Copie `project_id`, `client_email` e `private_key` para as env vars do Vercel
5. O Firestore será criado automaticamente no primeiro acesso

**Importante sobre a env var `FIREBASE_PRIVATE_KEY`:**
- O Vercel trata `\n` literal em strings como `\n` escape.
- Cole o conteúdo completo da `private_key` do JSON.
- O `config.js` faz `.replace(/\\n/g, '\n')` automaticamente.
- Se ocorrer erro "invalid_key", verifique que as linhas `-----BEGIN PRIVATE KEY-----` e `-----END PRIVATE KEY-----` estão presentes e o conteúdo está entre elas com `\n`.

## Variáveis de Ambiente (Vercel)

| Variável | Valor Performe+ | Descrição |
|---|---|---|
| `API_KEY` | `performe-nfse-2026-k3y-su3per-s3cr3t` | Chave de acesso ao painel |
| `CRON_SECRET` | (defina) | Protege `/api/cron/*` |
| `ODOO_ENABLED` | `1` | Habilita integração Odoo |
| `ODOO_URL` | `https://performe.odoo.com` | URL Odoo Online (sem `/odoo` no final) |
| `ODOO_DB` | `performe` | Nome do banco (subdomain) |
| `ODOO_USER` | `paulo.yure@gmail.com` | Login Odoo |
| `ODOO_API_KEY` | `122307897e39fd4fd6119cecca38313cf7422d8b` | API Key Odoo |
| `ODOO_POLLING_MS` | `15000` | Intervalo polling (local) |
| `ODOO_CRON_MODE` | `1` | Força uso via cron (Vercel) |
| `NFSE_CIDADE` | `Curitiba` | Cidade emissão (matriz operacional) |
| `NFSE_CODIGO_IBGE` | `4106902` | IBGE Curitiba |
| `NFSE_TP_AMB` | `2` | 1=produção, 2=homologação (comece em 2!) |
| `NFSE_SERIE` | `70000` | Série nacional (Curitiba) |
| `NFSE_ALIQUOTA_ISS` | `5.00` | Alíquota ISS Curitiba |
| `NFSE_C_NBS` | `122051900` | NBS padrão (já nos produtos Odoo) |
| `NFSE_C_TRIB_NAC` | `080201` | Código tributação LC 116 |
| `FIREBASE_PROJECT_ID` | `performe-nfse-prod` | Projeto Firebase |
| `FIREBASE_CLIENT_EMAIL` | `...@performe-nfse-prod.iam.gserviceaccount.com` | Email SA |
| `FIREBASE_PRIVATE_KEY` | `-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n` | Chave privada |
| `FIREBASE_CERT_COLLECTION` | `certificados` | Collection Firestore |
| `FIREBASE_CERT_DOC_ID` | `performe-a1` | ID do doc do certificado |
| `SEFIN_PROD_URL` | `https://sefin.nfse.gov.br/SefinNacional` | API SEFIN produção |
| `SEFIN_HOM_URL` | `https://sefin.producaorestrita.nfse.gov.br/SefinNacional` | API SEFIN homologação |

## Checklist de Implantação

- [x] Repositório GitHub `marcusvds83/performemais` criado
- [x] Código adaptado de Accel → Performe+
- [x] `vercel.json` configurado com cron
- [x] Scripts Odoo atualizados (`x_performe_*`)
- [x] Logo placeholder criado
- [ ] Conta Firebase criada (chaves a preencher)
- [ ] Vercel: criar projeto + preencher env vars
- [ ] Odoo: rodar `odoo-scripts/setup-completo-odoo.py`
- [ ] Upload do certificado A1 via painel (`POST /api/v1/nfse/certificado`)
- [ ] Upload da logo real da Performe+ via painel (`POST /api/v1/nfse/certificado/logo`)
- [ ] Cadastro da empresa no CNC NFS-e (prefeitura)
- [ ] Teste em homologação (NFSE_TP_AMB=2)
- [ ] Trocar para produção (NFSE_TP_AMB=1) após homologação aprovada

## Diferenças vs Accel (origem)

| Aspecto | Accel | Performe+ |
|---|---|---|
| Cliente | Accel (consultoria) | Performe+ (cursos) |
| Odoo | `accel-gpl.odoo.com` (DB: `accel`) | `performe.odoo.com/odoo` (DB: `performe`) |
| Versão Odoo | 17/18 | 19.4 (saas~19.4+e) |
| Produtos | Consultoria | Cursos (4SX CWB, 4SX PG, etc.) |
| Campos custom | `x_nytro_*` | `x_performe_*` |
| Deploy | Vercel | **Vercel** |
| Cofre | Firebase | Firebase (mesma conta ou nova) |
| Cron | `setInterval` (Vercel persistente) | Vercel Cron (`/api/cron/process-pending`) |
| PDF | PDFKit local | PDFKit local (mesmo modelo) |
| API NFS-e | REST SEFIN (SPED v1.01) | REST SEFIN (SPED v1.01) — idêntico |

## Notas Técnicas

- **Odoo 19.4+**: o campo `ir.attachment.datas` foi removido; o `nfse-odoo-emit.js` detecta automaticamente `db_datas` ou `raw`.
- **Odoo 19.4+**: `res.users.groups_id` e `res.partner.legal_name`/`mobile` foram removidos. Os scripts evitam esses campos.
- **SPED NFS-e v1.01**: o XML segue o XSD oficial. O bloco `IBSCBS` é **opcional** (NT 004/2025 v2.0 suspendeu obrigatoriedade); por padrão não é enviado (igual XMLs reais autorizados da Accel/Nytro).
- **API REST SEFIN**: desde 01/10/2025 substituiu o SOAP. Usa mTLS com certificado A1 e formato JSON com XML DPS em `dpsXmlGZipB64`.
- **PDF DANFSe**: gerado localmente com PDFKit (não baixamos do ADN — NT 008/2026 suspendeu o endpoint oficial).
- **Vercel Serverless**: o `setInterval` não persiste entre invocações frias; o `vercel.json` configura cron de 1 minuto chamando `/api/cron/process-pending`.

## Licença

Uso interno da Performe+. Fork do `accel-nfse` (mesmo autor).
