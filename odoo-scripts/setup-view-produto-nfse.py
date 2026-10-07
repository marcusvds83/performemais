#!/usr/bin/env python3
"""
odoo-scripts/setup-view-produto-nfse.py
=====================================
Adiciona aba "NFS-e" com os campos customizados no formulario de produto
(product.product) via XML-RPC no Odoo Online.

Campos adicionados na aba:
  - Codigo Tributacao Municipal
  - Codigo NBS
  - Descricao para NFS-e
  - Aliquota ISS (%)
  - ISS Retido (boolean)

Execute:
  ODOO_URL=https://luisfernandoperforme-performe.odoo.com \
  ODOO_DB=luisfernandoperforme-performe-producao-performe-28615541 \
  ODOO_USER=contato@performe-br.com \
  ODOO_API_KEY=cec5c5c71b21cab1d2bbd58403d0b5eb5301f0c0 \
  python3 odoo-scripts/setup-view-produto-nfse.py
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
    print('ERRO: Auth falhou.')
    sys.exit(1)
print(f'Autenticado! uid={uid}')

models = xmlrpc.client.ServerProxy(f'{ODOO_URL}/xmlrpc/2/object')

def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(ODOO_DB, uid, ODOO_API_KEY, model, method, args or [], kwargs or {})

# ---- 1. Verificar se campos existem no modelo product.product ----
model_ids = kw('ir.model', 'search', [[['model', '=', 'product.product']]])
if not model_ids:
    raise SystemExit('Modelo product.product nao encontrado')
model_id = model_ids[0]

campos = [
    'x_performe_codigo_tributacao',
    'x_performe_c_nbs',
    'x_performe_descricao_nfse',
    'x_performe_aliquota_iss',
    'x_performe_iss_retido',
]

for nome in campos:
    fid = kw('ir.model.fields', 'search', [[['name', '=', nome], ['model_id', '=', model_id]]])
    if not fid:
        print(f'  [AVISO] Campo {nome} nao encontrado no modelo product.product. Crie-o primeiro.')
    else:
        print(f'  [OK] Campo {nome} existe (ID={fid[0]})')

# ---- 2. Buscar a view externa do produto que criamos antes (se existir) ----
existing_view = kw('ir.ui.view', 'search', [[['name', '=', 'product.product.nfse.form']]])
if existing_view:
    print(f'View ja existe (ID={existing_view[0]}), recriando...')
    try:
        kw('ir.ui.view', 'unlink', [existing_view])
        print('  View anterior removida.')
    except Exception as e:
        print(f'  Nao conseguiu remover: {e}')
        # Tenta escrever ao inves de recriar

# ---- 3. Criar view com aba NFS-e ----
arch = """<?xml version="1.0"?>
<data>
    <xpath expr="//page[@name='general_attributes']" position="after">
        <page string="NFS-e" name="nyt_nfse">
            <group string="Dados para NFS-e (Performe+)" col="2">
                <field name="x_performe_codigo_tributacao" placeholder="Ex: 08.02.01"/>
                <field name="x_performe_c_nbs" placeholder="Ex: 12.20519.00"/>
                <field name="x_performe_descricao_nfse" placeholder="Descricao do servico para a nota"/>
                <field name="x_performe_aliquota_iss"/>
                <field name="x_performe_iss_retido"/>
            </group>
        </page>
    </xpath>
</data>"""

try:
    view_id = kw('ir.ui.view', 'create', [{
        'name': 'product.product.nfse.form',
        'model': 'product.product',
        'type': 'form',
        'inherit_id': 284,  # product.product form padrao (geralmente ID fixo)
        'arch_db': arch,
        'active': True,
    }])
    print(f'\nView criada com sucesso! (ID={view_id})')
    print('Abra qualquer produto no Odoo e va ate a aba "NFS-e"')
except Exception as e:
    print(f'\nTentativa com ID fixo falhou ({e}), tentando com referencia...')
    # Busca view base do product.product
    base_views = kw('ir.ui.view', 'search', [[
        ['model', '=', 'product.product'],
        ['type', '=', 'form'],
        ['inherit_id', '=', False],
    ]], {'limit': 1, 'order': 'id asc'})
    if not base_views:
        raise SystemExit('Nao encontrou view base do product.product')
    base_id = base_views[0]
    print(f'  View base encontrada: ID={base_id}')
    
    # Tenta xpath mais generico
    arch2 = """<?xml version="1.0"?>
<data>
    <xpath expr="//notebook" position="inside">
        <page string="NFS-e" name="nyt_nfse">
            <group string="Dados para NFS-e (Performe+)" col="2">
                <field name="x_performe_codigo_tributacao" placeholder="Ex: 08.02.01"/>
                <field name="x_performe_c_nbs" placeholder="Ex: 12.20519.00"/>
                <field name="x_performe_descricao_nfse" placeholder="Descricao do servico para a nota"/>
                <field name="x_performe_aliquota_iss"/>
                <field name="x_performe_iss_retido"/>
            </group>
        </page>
    </xpath>
</data>"""

    try:
        view_id = kw('ir.ui.view', 'create', [{
            'name': 'product.product.nfse.form',
            'model': 'product.product',
            'type': 'form',
            'inherit_id': base_id,
            'arch_db': arch2,
            'active': True,
        }])
        print(f'View criada com sucesso! (ID={view_id})')
        print('Abra qualquer produto no Odoo e va ate a aba "NFS-e"')
    except Exception as e2:
        print(f'ERRO ao criar view: {e2}')
        print('\nTentando abordagem alternativa com field inheritance...')
        # Abordagem final: modifica a view generica via ir.ui.view com priority
        try:
            view_id = kw('ir.ui.view', 'create', [{
                'name': 'product.product.nfse.form',
                'model': 'product.product',
                'type': 'form',
                'inherit_id': base_id,
                'arch_db': arch2,
                'active': True,
                'priority': 99,
            }])
            print(f'View criada com priority=99! (ID={view_id})')
        except Exception as e3:
            print(f'ERRO final: {e3}')

print('\nPronto!')
