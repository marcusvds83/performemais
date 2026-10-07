import xmlrpc.client

url = 'https://luisfernandoperforme-performe.odoo.com'
db = 'luisfernandoperforme-performe-producao-performe-28615541'
user = 'contato@performe-br.com'
key = 'cec5c5c71b21cab1d2bbd58403d0b5eb5301f0c0'

common = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common')
uid = common.authenticate(db, user, key, {})
print('uid:', uid)

models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

def kw(model, method, args=None, kwargs=None):
    return models.execute_kw(db, uid, key, model, method, args or [], kwargs or {})

field_ids = kw('ir.model.fields', 'search', [[['name', '=', 'x_performe_nfse_status'], ['model', '=', 'account.move']]])
print('Field IDs:', field_ids)

new_selection = "[('vazio','Vazio'),('pendente','Pendente'),('processando','Processando'),('autorizada','Autorizada'),('cancelar_solicitado','Cancelar Solicitado'),('cancelada','Cancelada'),('erro','Erro')]"
kw('ir.model.fields', 'write', [field_ids, {'selection': new_selection}])
print('Selection atualizado!')

fields = kw('ir.model.fields', 'read', [field_ids, ['name', 'selection']])
print('Novo selection:', fields[0]['selection'])
