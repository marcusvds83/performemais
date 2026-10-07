#!/usr/bin/env python3
"""
odoo-scripts/setup-campo-ultima-nf.py
=====================================
Cria o campo x_performe_nfse_numero (integer) em res.company.

Este campo e o CONTADOR/SEQUENCIAL de NFS-e da empresa.
O middleware le ele (ultimo numero emitido), soma 1 para gerar a proxima DPS
e grava o novo valor de volta. Eh o "ultima NF emitida" no painel admin.

Por que res.company e nao account.move?
- account.move.x_performe_nfse_numero = numero da NFS-e daquela fatura especifica
- res.company.x_performe_nfse_numero  = ULTIMO numero usado pela empresa (contador)

Execute no Git Bash:

  ODOO_URL=https://performe-gpl.odoo.com \
  ODOO_DB=performe \
  ODOO_API_KEY=629f0ba46233f60449c11fc4d801402c38a0f13c \
  python3 odoo-scripts/setup-campo-ultima-nf.py

Opcional: setar valor inicial se a empresa ja tem NFS-e anterior
  VALOR_INICIAL=91 python3 odoo-scripts/setup-campo-ultima-nf.py
"""

import os, sys, xmlrpc.client

# ============================================================
# 1. AUTENTICACAO
# ============================================================
ODOO_URL = os.environ.get('ODOO_URL', '').rstrip('/')
ODOO_DB  = os.environ.get('ODOO_DB', '')
# Aceita ODOO_API_KEY (antigo padrao) ou ODOO_PASSWORD (legado)
ODOO_KEY = os.environ.get('ODOO_API_KEY') or os.environ.get('ODOO_PASSWORD', '')
VALOR_INICIAL = os.environ.get('VALOR_INICIAL', '')  # ex: 91

if not all([ODOO_URL, ODOO_DB, ODOO_KEY]):
    print('ERRO: Defina as variaveis de ambiente:')
    print('  ODOO_URL=https://SEU-ODOO.odoo.com')
    print('  ODOO_DB=SEU-BANCO')
    print('  ODOO_API_KEY=SUA-CHAVE')
    print('')
    print('Opcional:')
    print('  VALOR_INICIAL=91     # seta o contador pra 91 (ultima NFS-e emitida)')
    sys.exit(1)

print(f'Conectando em {ODOO_URL} (DB: {ODOO_DB})...')
common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid = common.authenticate(ODOO_DB, ODOO_KEY, ODOO_KEY, {})
if not uid:
    print('ERRO: Autenticacao falhou. Verifique ODOO_URL, ODOO_DB e ODOO_API_KEY.')
    sys.exit(1)
print(f'Autenticado com sucesso! (uid={uid})')

models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_KEY, model, method, args or [], kwargs or {})

# ============================================================
# 2. BUSCAR O model_id DE res.company
# ============================================================
print('')
print('=' * 60)
print('Criando campo x_performe_nfse_numero em res.company')
print('=' * 60)

model_ids = kw('ir.model', 'search', [[['model', '=', 'res.company']]])
if not model_ids:
    print('ERRO: Modelo res.company nao encontrado.')
    sys.exit(1)
model_id = model_ids[0]
print(f'Modelo res.company encontrado: ir.model ID={model_id}')

# ============================================================
# 3. CRIAR O CAMPO (se nao existir)
# ============================================================
NOME_CAMPO = 'x_performe_nfse_numero'
LABEL      = 'NFS-e Ultimo Numero (Performe+)'
HELP_TXT   = 'Contador/sequencial de NFS-e da empresa. O middleware le este valor, soma 1 para emitir a proxima DPS e grava o novo valor de volta. Edite manualmente para corrigir a numeracao (ex: se ja tem NFS-e anterior emitida por outro sistema, sete o ultimo numero aqui).'

existing = kw('ir.model.fields', 'search', [[['name', '=', NOME_CAMPO], ['model', '=', 'res.company']]])
if existing:
    print(f'  [OK] Campo {NOME_CAMPO} ja existe em res.company (ID={existing[0]}).')
    # Atualiza help e label para garantir
    try:
        kw('ir.model.fields', 'write', [existing, {'field_description': LABEL, 'help': HELP_TXT}])
        print(f'       Label/help atualizados.')
    except Exception as e:
        print(f'       [AVISO] Nao foi possivel atualizar label/help: {e}')
    field_id = existing[0]
else:
    try:
        field_id = kw('ir.model.fields', 'create', [{
            'name': NOME_CAMPO,
            'field_description': LABEL,
            'model_id': model_id,
            'ttype': 'integer',
            'state': 'manual',
            'store': True,
            'help': HELP_TXT,
        }])
        print(f'  [OK] Campo {NOME_CAMPO} criado em res.company (ID={field_id})')
    except Exception as e:
        print(f'  [ERRO] Falha ao criar campo: {e}')
        sys.exit(1)

# ============================================================
# 4. SETAR VALOR INICIAL (se VALOR_INICIAL foi informado)
# ============================================================
if VALOR_INICIAL != '':
    try:
        valor = int(VALOR_INICIAL)
    except ValueError:
        print(f'  [ERRO] VALOR_INICIAL="{VALOR_INICIAL}" nao e um numero inteiro.')
        sys.exit(1)

    # Lista todas as empresas
    company_ids = kw('res.company', 'search', [[]])
    companies = kw('res.company', 'read', [company_ids, ['name', NOME_CAMPO]])
    print('')
    print(f'Setando {NOME_CAMPO}={valor} em {len(companies)} empresa(s):')
    for c in companies:
        atual = c.get(NOME_CAMPO, 0) or 0
        print(f'  - {c["name"]}: valor atual = {atual} -> setando {valor}')
        kw('res.company', 'write', [[c['id']], {NOME_CAMPO: valor}])
    print(f'  [OK] Contador setado para {valor} em todas as empresas.')

# ============================================================
# 5. RELATORIO FINAL
# ============================================================
print('')
print('=' * 60)
print('Relatorio final')
print('=' * 60)
company_ids = kw('res.company', 'search', [[]])
companies = kw('res.company', 'read', [company_ids, ['name', NOME_CAMPO]])
for c in companies:
    val = c.get(NOME_CAMPO, '(nulo)') or 0
    print(f'  Empresa: {c["name"]:30s}  |  {NOME_CAMPO} = {val}')

print('')
print('PRONTO!')
print('')
print('Proximos passos:')
print('1. No Odoo, va em Configuracao > Empresas > abra a empresa Performe+')
print('2. Na aba "Ajustes dinamicos" ou via Developer Mode, procure o campo')
print(f'   "{LABEL}" e adicione na view de empresa (form) para visualizar.')
print('3. Se nao setou VALOR_INICIAL agora, defina o numero da ultima NFS-e')
print('   ja emitida pela empresa (para o middleware comecar a partir do proximo).')
print('4. No painel admin do middleware (/), aba Painel, voce vera o campo')
print('   "ultimo_ndps" atualizado em tempo real.')
