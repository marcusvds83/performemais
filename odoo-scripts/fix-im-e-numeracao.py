"""
Cria campo IM faltante e reseta numeracao
"""
import xmlrpc.client

URL = 'https://luisfernandoperforme-performe.odoo.com'
DB = 'luisfernandoperforme-performe-producao-performe-28615541'
USER = 'contato@performe-br.com'
API_KEY = 'cec5c5c71b21cab1d2bbd58403d0b5eb5301f0c0'

common = xmlrpc.client.ServerProxy(f'{URL}/xmlrpc/2/common')
uid = common.authenticate(DB, USER, API_KEY, {})
print(f'UID: {uid}')

models = xmlrpc.client.ServerProxy(f'{URL}/xmlrpc/2/object')

# 1. Verifica se o campo existe
existing = models.execute_kw(DB, uid, API_KEY, 'ir.model.fields', 'search_count',
    [[['model', '=', 'res.company'], ['name', '=', 'x_performe_nfse_dados_prestador_im']]])
print(f'Campo x_performe_nfse_dados_prestador_im existe: {existing > 0}')

if existing == 0:
    models.execute_kw(DB, uid, API_KEY, 'ir.model.fields', 'create', [{
        'name': 'x_performe_nfse_dados_prestador_im',
        'model': 'res.company',
        'model_id': 1,
        'field_description': 'Inscricao Municipal (NFS-e)',
        'ttype': 'char',
        'size': 20,
    }])
    print('Campo criado com sucesso!')

# 2. Seta o IM correto na empresa principal
companies = models.execute_kw(DB, uid, API_KEY, 'res.company', 'search_read',
    [[['id', '=', 1]]], {'fields': ['name', 'x_performe_nfse_dados_prestador_im', 'x_performe_nfse_numero']})

for c in companies:
    print(f'Empresa: {c["name"]}')
    print(f'  IM atual: {c.get("x_performe_nfse_dados_prestador_im", "(vazio)")}')
    print(f'  nDPS atual: {c.get("x_performe_nfse_numero", 0)}')

# 3. Atualiza IM e reseta numeracao
models.execute_kw(DB, uid, API_KEY, 'res.company', 'write', [[1], {
    'x_performe_nfse_dados_prestador_im': '170110079908',
    'x_performe_nfse_numero': 0,
}])
print('\nAtualizado: IM=170110079908, nDPS resetado para 0 (proximo sera 1)')

# 4. Verifica
updated = models.execute_kw(DB, uid, API_KEY, 'res.company', 'read', [[1]],
    {'fields': ['x_performe_nfse_dados_prestador_im', 'x_performe_nfse_numero']})
print(f'Verificacao: IM={updated[0]["x_performe_nfse_dados_prestador_im"]}, nDPS={updated[0]["x_performe_nfse_numero"]}')

# 5. Reseta faturas com status de erro para pendente (para reprocessar)
error_moves = models.execute_kw(DB, uid, API_KEY, 'account.move', 'search', [
    ['move_type', '=', 'out_invoice'],
    ['state', '=', 'posted'],
    ['x_performe_nfse_status', 'in', ['erro', 'processando']],
])
if error_moves:
    models.execute_kw(DB, uid, API_KEY, 'account.move', 'write', [error_moves], {
        'x_performe_nfse_status': 'pendente',
        'x_performe_nfse_erro': False,
        'x_performe_nfse_mensagem': False,
    })
    print(f'Resetadas {len(error_moves)} fatura(s) com erro para pendente.')
else:
    print('Nenhuma fatura com erro para resetar.')
