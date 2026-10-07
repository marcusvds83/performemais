#!/usr/bin/env python3
"""
odoo-scripts/recriar-botao-cancelar.py
=====================================
Recria o Server Action "Cancelar NFS-e" no Odoo.
O botao apenas marca o status como 'cancelar_solicitado' e posta no chatter.
O middleware (polling) detecta esse status e faz o cancelamento na SEFIN.

Esta abordagem evita usar 'import' que e bloqueado no Odoo Online.
"""

import os, xmlrpc.client

ODOO_URL = os.environ['ODOO_URL'].rstrip('/')
ODOO_DB = os.environ['ODOO_DB']
ODOO_USER = os.environ.get('ODOO_USER', '')
ODOO_API_KEY = os.environ['ODOO_API_KEY']

print('=== Recriando botao Cancelar NFS-e ===')
print('DB: ' + ODOO_DB)
print('User: ' + ODOO_USER)

common = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/common')
uid = common.authenticate(ODOO_DB, ODOO_USER, ODOO_API_KEY, {})
if not uid:
    raise SystemExit('Autenticacao falhou.')
print(f'Autenticado uid={uid}')

models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args or [], kwargs or {})

model_ids = kw('ir.model', 'search', [[['model', '=', 'account.move']]])
model_id = model_ids[0]

# Codigo sem imports - apenas marca status e posta no chatter
# O polling do middleware detecta 'cancelar_solicitado' e faz o cancelamento real
codigo = """if record.x_performe_nfse_status != 'autorizada':
    raise UserError('NFS-e precisa estar com status autorizada para cancelar. Status: ' + str(record.x_performe_nfse_status or 'vazio'))

if not record.x_performe_nfse_codigo_verificacao:
    raise UserError('Chave de acesso vazia. Nao e possivel cancelar.')

record.write({'x_performe_nfse_status': 'cancelar_solicitado'})
record.message_post(body='<b>[CANCELAR NFS-e]</b> Cancelamento solicitado. O middleware processara em ate 15 segundos.')
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

print(f'Botao "Cancelar NFS-e" recriado! (ID={action_id})')
print('Fluxo: botao marca status -> polling detecta -> middleware cancela na SEFIN -> atualiza Odoo')
