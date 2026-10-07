#!/usr/bin/env python3
"""
odoo-scripts/criar-botao-emitir-nfse.py
=====================================
Cria via XML-RPC um Server Action "Emitir NFS-e" visivel como botao
no menu Acao (engrenagem) do formulario de faturas (account.move).

O botao apenas marca x_performe_nfse_status = 'pendente'. O polling do
middleware detecta e processa automaticamente.

Autenticacao via API Key do Odoo (gerada em Preferencias > Chaves de API).

Execute:
  ODOO_URL=https://performe.odoo.com ODOO_DB=performe \\
  ODOO_USER=paulo.yure@gmail.com \\
  ODOO_API_KEY=sua-api-key-aqui \\
  python3 odoo-scripts/criar-botao-emitir-nfse.py
"""

import os, sys, xmlrpc.client

ODOO_URL = os.environ.get('ODOO_URL', '').rstrip('/')
ODOO_DB = os.environ.get('ODOO_DB', '')
ODOO_USER = os.environ.get('ODOO_USER', '')
ODOO_API_KEY = os.environ.get('ODOO_API_KEY', '')
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

# Busca ID do modelo account.move
model_ids = kw('ir.model', 'search', [[['model', '=', 'account.move']]])
if not model_ids:
    raise SystemExit('Modelo account.move nao encontrado')
model_id = model_ids[0]

codigo = """# Emitir NFS-e
if record.move_type != 'out_invoice':
    raise UserError('Esta acao so funciona em faturas de venda (Fatura de Cliente).')
if record.state != 'posted':
    raise UserError('Confirme a fatura antes de emitir a NFS-e.')
status = record.x_performe_nfse_status or 'vazio'
if status in ('autorizada', 'processando'):
    raise UserError('Ja existe NFS-e em andamento para esta fatura. Status: ' + status)
record.write({'x_performe_nfse_status': 'pendente', 'x_performe_nfse_erro': False})
raise UserError('Fatura marcada para emissao de NFS-e. O middleware processara automaticamente.')
"""

# Remove acao anterior se existir
existing = kw('ir.actions.server', 'search', [[['name', '=', 'Emitir NFS-e']]])
if existing:
    kw('ir.actions.server', 'unlink', [existing])
    print('Acao anterior removida.')

action_id = kw('ir.actions.server', 'create', [{
    'name': 'Emitir NFS-e',
    'model_id': model_id,
    'binding_model_id': model_id,
    'binding_view_types': 'form',
    'state': 'code',
    'code': codigo,
}])

print(f'Botao "Emitir NFS-e" criado com sucesso! (ir.actions.server ID={action_id})')
print('Acesse qualquer fatura no Odoo -> menu Acao (engrenagem) -> "Emitir NFS-e"')
