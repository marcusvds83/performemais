#!/usr/bin/env python3
"""
Cria campo de numeracao NFS-e na empresa (res.company).
"""
import os, sys, xmlrpc.client

url = os.environ.get('ODOO_URL', '').rstrip('/')
db = os.environ.get('ODOO_DB', '')
user = os.environ.get('ODOO_USER', '')
key = os.environ.get('ODOO_API_KEY', '')

if not all([url, db, user, key]):
    print('ERRO: Defina ODOO_URL, ODOO_DB, ODOO_USER e ODOO_API_KEY')
    sys.exit(1)

c = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common')
uid = c.authenticate(db, user, key, {})
if not uid:
    print('ERRO: Autenticacao falhou.')
    sys.exit(1)
print(f'Autenticado! uid={uid}')

m = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')
def kw(model, method, args=None, kwargs=None):
    return m.execute_kw(db, uid, key, model, method, args or [], kwargs or {})

# Busca model_id de res.company
model_ids = kw('ir.model', 'search', [[['model', '=', 'res.company']]])
if not model_ids:
    print('ERRO: res.company nao encontrado')
    sys.exit(1)
model_id = model_ids[0]

# Campo de numeracao NFS-e
nome = 'x_performe_nfse_numero'
ex = kw('ir.model.fields', 'search', [[['name', '=', nome], ['model_id', '=', model_id]]])
if ex:
    print(f'  [OK] {nome} ja existe na empresa')
else:
    try:
        fid = kw('ir.model.fields', 'create', [{
            'name': nome, 'field_description': 'NFS-e Ultimo Numero (Performe+)',
            'model_id': model_id, 'ttype': 'integer', 'state': 'manual', 'store': True,
        }])
        print(f'  [OK] {nome} criado na empresa (ID={fid})')
    except Exception as e:
        print(f'  [AVISO] {nome}: {e}')

print('\nPronto!')
