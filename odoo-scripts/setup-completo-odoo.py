#!/usr/bin/env python3
"""
odoo-scripts/setup-completo-odoo.py
==================================
Script UNICO que cria tudo no Odoo da Performe+:
  1. Campos customizados x_performe_* no account.move
  2. Botao "Emitir NFS-e" (Server Action)
  3. Botao "Cancelar NFS-e" (Server Action)

Execute no Git Bash do seu PC:

  cd ~/Downloads/nfse-performe

  ODOO_URL=https://SEU-ODOO.odoo.com \
  ODOO_DB=SEU-BANCO \
  ODOO_API_KEY=SUA-CHAVE \
  python3 odoo-scripts/setup-completo-odoo.py

Apos rodar, abra qualquer fatura no Odoo, clique na engrenagem (Acao)
e os botoes "Emitir NFS-e" e "Cancelar NFS-e" estaram la.
"""

import os, sys, xmlrpc.client

# ============================================================
# 1. AUTENTICACAO
# ============================================================
ODOO_URL = os.environ.get('ODOO_URL', '').rstrip('/')
ODOO_DB = os.environ.get('ODOO_DB', '')
ODOO_USER = os.environ.get('ODOO_USER', '')  # email de login (ex: paulo.yure@gmail.com)
ODOO_API_KEY = os.environ.get('ODOO_API_KEY', '')

if not all([ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY]):
    print('ERRO: Defina as 4 variaveis de ambiente:')
    print('  ODOO_URL=https://SEU-ODOO.odoo.com')
    print('  ODOO_DB=SEU-BANCO')
    print('  ODOO_USER=seu@email.com  (login Odoo)')
    print('  ODOO_API_KEY=SUA-CHAVE')
    print('')
    print('Exemplo no Git Bash:')
    print('  ODOO_URL=https://performe.odoo.com ODOO_DB=performe ODOO_USER=paulo.yure@gmail.com ODOO_API_KEY=abc123 python3 odoo-scripts/setup-completo-odoo.py')
    sys.exit(1)

print(f'Conectando em {ODOO_URL} (DB: {ODOO_DB})...')
common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
# Odoo 19: authenticate(email, api_key, api_key) - segundo arg = password = api_key
uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
if not uid:
    print('ERRO: Autenticacao falhou. Verifique ODOO_URL, ODOO_DB, ODOO_USER e ODOO_API_KEY.')
    sys.exit(1)
print(f'Autenticado com sucesso! (uid={uid})')

models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args or [], kwargs or {})

def kw_read(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args or [], kwargs or {})

# ============================================================
# 2. CAMPOS CUSTOMIZADOS (ir.model.fields)
# ============================================================
print('\n' + '='*60)
print('ETAPA 1: Criando campos customizados x_performe_*')
print('='*60)

# Busca o model_id de account.move
model_ids = kw('ir.model', 'search', [[['model', '=', 'account.move']]])
if not model_ids:
    print('ERRO: Modelo account.move nao encontrado.')
    sys.exit(1)
model_id = model_ids[0]
print(f'Modelo account.move encontrado: ir.model ID={model_id}')

campos = [
    {
        'name': 'x_performe_nfse_status',
        'field_description': 'NFS-e Status (Performe+)',
        'ttype': 'selection',
        'selection': "[('vazio','Vazio'),('pendente','Pendente'),('processando','Processando'),('autorizada','Autorizada'),('cancelada','Cancelada'),('erro','Erro')]",
        'default': 'vazio',
    },
    {
        'name': 'x_performe_nfse_numero',
        'field_description': 'NFS-e Numero (Performe+)',
        'ttype': 'char',
    },
    {
        'name': 'x_performe_nfse_codigo_verificacao',
        'field_description': 'NFS-e Codigo Verificacao (Performe+)',
        'ttype': 'char',
    },
    {
        'name': 'x_performe_nfse_url',
        'field_description': 'NFS-e URL (Performe+)',
        'ttype': 'char',
    },
    {
        'name': 'x_performe_nfse_erro',
        'field_description': 'NFS-e Erro (Performe+)',
        'ttype': 'boolean',
    },
    {
        'name': 'x_performe_nfse_mensagem',
        'field_description': 'NFS-e Mensagem Erro (Performe+)',
        'ttype': 'text',
    },
    {
        'name': 'x_performe_nfse_xml',
        'field_description': 'NFS-e XML (Performe+)',
        'ttype': 'text',
    },
    {
        'name': 'x_performe_nfse_data_emissao',
        'field_description': 'NFS-e Data Emissao (Performe+)',
        'ttype': 'datetime',
    },
    {
        'name': 'x_performe_nfse_protocolo',
        'field_description': 'NFS-e Protocolo (Performe+)',
        'ttype': 'char',
    },
    {
        'name': 'x_performe_nfse_dados_prestador_im',
        'field_description': 'NFS-e Inscricao Municipal Prestador (Performe+)',
        'ttype': 'char',
        'help': 'Inscricao Municipal da empresa prestadora (Performe+) em Curitiba',
    },
]

for campo in campos:
    nome = campo['name']
    # Verifica se ja existe
    existing = kw('ir.model.fields', 'search', [[['name', '=', nome], ['model_id', '=', model_id]]])
    if existing:
        print(f'  [OK] Campo {nome} ja existe (ID={existing[0]}), pulando.')
        continue
    
    campo_create = {
        'name': campo['name'],
        'field_description': campo['field_description'],
        'model_id': model_id,
        'ttype': campo['ttype'],
        'state': 'manual',
        'store': True,
    }
    
    # Adiciona campos extras dependendo do tipo
    if campo['ttype'] == 'selection':
        campo_create['selection'] = campo['selection']
    # NOTA: Odoo 19 nao aceita 'default' em ir.model.fields via XML-RPC
    #       Use ir.default ou crie via Studio.
    # if campo.get('default'): campo_create['default'] = campo['default']
    if campo.get('help'):
        campo_create['help'] = campo['help']
    
    try:
        field_id = kw('ir.model.fields', 'create', [campo_create])
        print(f'  [OK] Campo {nome} criado (ID={field_id})')
    except Exception as e:
        print(f'  [AVISO] Nao foi possivel criar campo {nome}: {e}')
        print(f'         Tente criar manualmente em Configuracao > Tecnico > Campos')

print('\nCampos criados/verificados!')

# ============================================================
# 3. BOTAO EMITIR NFS-e
# ============================================================
print('\n' + '='*60)
print('ETAPA 2: Criando botao "Emitir NFS-e"')
print('='*60)

codigo_emitir = """# Emitir NFS-e Performe+
if record.move_type != 'out_invoice':
    raise UserError('Esta acao so funciona em faturas de venda (Fatura de Cliente).')
if record.state != 'posted':
    raise UserError('Confirme a fatura (Contabilizar) antes de emitir a NFS-e.')
status = record.x_performe_nfse_status or 'vazio'
if status in ('autorizada', 'processando'):
    raise UserError('Ja existe NFS-e em andamento para esta fatura. Status: ' + status)
record.write({
    'x_performe_nfse_status': 'pendente',
    'x_performe_nfse_erro': False,
    'x_performe_nfse_mensagem': False,
})
"""

# Remove acao anterior se existir
existing = kw('ir.actions.server', 'search', [[['name', '=', 'Emitir NFS-e']]])
if existing:
    kw('ir.actions.server', 'unlink', [existing])
    print('  Acao anterior removida.')

try:
    action_id = kw('ir.actions.server', 'create', [{
        'name': 'Emitir NFS-e',
        'model_id': model_id,
        'binding_model_id': model_id,
        'binding_view_types': 'form',
        'state': 'code',
        'code': codigo_emitir,
    }])
    print(f'  [OK] Botao "Emitir NFS-e" criado (ID={action_id})')
except Exception as e:
    print(f'  [ERRO] Falha ao criar botao Emitir: {e}')

# ============================================================
# 4. BOTAO CANCELAR NFS-e
# ============================================================
print('\n' + '='*60)
print('ETAPA 3: Criando botao "Cancelar NFS-e"')
print('='*60)

# O botao de cancelar marca a fatura como 'cancelada' localmente.
# O cancelamento real na prefeitura sera feito pelo middleware.
# Por enquanto, vamos criar um botao simples que marca o status.
codigo_cancelar = """# Cancelar NFS-e Performe+
status = record.x_performe_nfse_status or 'vazio'
if status != 'autorizada':
    raise UserError('A NFS-e precisa estar com status "autorizada" para cancelar. Status atual: ' + status)
record.write({
    'x_performe_nfse_status': 'cancelada',
    'x_performe_nfse_erro': False,
})
"""

existing = kw('ir.actions.server', 'search', [[['name', '=', 'Cancelar NFS-e']]])
if existing:
    kw('ir.actions.server', 'unlink', [existing])
    print('  Acao anterior removida.')

try:
    action_id = kw('ir.actions.server', 'create', [{
        'name': 'Cancelar NFS-e',
        'model_id': model_id,
        'binding_model_id': model_id,
        'binding_view_types': 'form',
        'state': 'code',
        'code': codigo_cancelar,
    }])
    print(f'  [OK] Botao "Cancelar NFS-e" criado (ID={action_id})')
except Exception as e:
    print(f'  [ERRO] Falha ao criar botao Cancelar: {e}')

# ============================================================
# 5. RESUMO FINAL
# ============================================================
print('\n' + '='*60)
print('SETUP COMPLETO CONCLUIDO!')
print('='*60)
print('')
print('O que foi criado no Odoo:')
print('  - 10 campos customizados x_performe_* no account.move')
print('  - Botao "Emitir NFS-e" no menu Acao das faturas')
print('  - Botao "Cancelar NFS-e" no menu Acao das faturas')
print('')
print('Como usar:')
print('  1. Abra o Odoo > Faturamento > Faturas')
print('  2. Crie/abra uma fatura de venda')
print('  3. Contabilize a fatura (botao "Confirmar")')
print('  4. Clique na engrenagem (Acao) > "Emitir NFS-e"')
print('  5. O middleware detecta e processa automaticamente')
print('')
print('Nota: Os campos x_performe_* aparecem na aba "NFS-e Performe+"')
print('      ou no final do formulario da fatura.')
print('      Se nao aparecerem, ative o Modo Desenvolvedor')
print('      e va em Configuracao > Tecnico > ir.model.fields')
print('      para verificar se os campos foram criados.')
