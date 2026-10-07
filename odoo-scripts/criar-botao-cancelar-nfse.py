#!/usr/bin/env python3
"""
odoo-scripts/criar-botao-cancelar-nfse.py
=======================================
Cria via XML-RPC um Server Action "Cancelar NFS-e" visivel como botao
no menu Acao (engrenagem) do formulario de faturas (account.move).

O botao verifica se a NFS-e esta autorizada e chama o middleware
para cancelar na prefeitura.

Autenticacao via API Key do Odoo.

Execute:
  ODOO_URL=https://performe.odoo.com ODOO_DB=performe \\
  ODOO_USER=paulo.yure@gmail.com \\
  ODOO_API_KEY=sua-api-key-aqui \\
  MIDDLEWARE_URL=https://performemais.vercel.app \\
  MIDDLEWARE_API_KEY=sua-chave \\
  python3 odoo-scripts/criar-botao-cancelar-nfse.py
"""

import os, sys, json, xmlrpc.client, urllib.request, urllib.error

ODOO_URL = os.environ.get('ODOO_URL', '').rstrip('/')
ODOO_DB = os.environ.get('ODOO_DB', '')
ODOO_USER = os.environ.get('ODOO_USER', '')
ODOO_API_KEY = os.environ.get('ODOO_API_KEY', '')
MIDDLEWARE_URL = os.environ.get('MIDDLEWARE_URL', 'https://performemais.vercel.app')
MIDDLEWARE_KEY = os.environ.get('MIDDLEWARE_API_KEY', '')
if not all([ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY]):
    print('ERRO: Defina ODOO_URL, ODOO_DB, ODOO_USER e ODOO_API_KEY')
    sys.exit(1)

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
if not uid:
    raise SystemExit('Autenticacao falhou. Verifique ODOO_API_KEY.')
print(f'Autenticado como uid={uid}')

models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args or [], kwargs or {})

model_ids = kw('ir.model', 'search', [[['model', '=', 'account.move']]])
if not model_ids:
    raise SystemExit('Modelo account.move nao encontrado')
model_id = model_ids[0]

codigo = f"""import urllib.request, json
from odoo.exceptions import UserError

move_id = record.id
move_name = record.name
nfse_status = record.x_performe_nfse_status or ''

if nfse_status != 'autorizada':
    raise UserError('A NFS-e precisa estar com status "autorizada" para ser cancelada. Status atual: ' + (nfse_status or 'vazio'))

justificativa = 'Cancelamento solicitado pelo emitente via Odoo'
url = '{MIDDLEWARE_URL}/api/v1/nfse/cancelar'
payload = json.dumps({{'move_id': move_id, 'justificativa': justificativa}}).encode('utf-8')
req = urllib.request.Request(url, data=payload, headers={{
    'Content-Type': 'application/json',
    'X-Api-Key': '{MIDDLEWARE_KEY}',
}}, method='POST')

try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        resultado = json.loads(resp.read().decode('utf-8'))
    if resultado.get('sucesso'):
        raise UserError('NFS-e ' + move_name + ' cancelada com sucesso!')
    else:
        raise UserError('Cancelamento rejeitado: ' + str(resultado.get('xMotivo', 'Erro desconhecido')))
except urllib.error.URLError as e:
    raise UserError('Erro ao contatar middleware: ' + str(e))
"""

# Remove acao anterior se existir
existing = kw('ir.actions.server', 'search', [[['name', '=', 'Cancelar NFS-e']]])
if existing:
    kw('ir.actions.server', 'unlink', [existing])
    print('Acao anterior removida.')

action_id = kw('ir.actions.server', 'create', [{
    'name': 'Cancelar NFS-e',
    'model_id': model_id,
    'binding_model_id': model_id,
    'binding_view_types': 'form',
    'state': 'code',
    'code': codigo,
}])

print(f'Botao "Cancelar NFS-e" criado com sucesso! (ir.actions.server ID={action_id})')
print('Acesse qualquer fatura no Odoo -> menu Acao (engrenagem) -> "Cancelar NFS-e"')
