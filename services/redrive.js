/**
 * services/redrive.js — Cliente Redrive API
 * ==========================================
 * Integra com a API da Redrive (https://api.redrive.com.br)
 * 
 * Funcoes:
 *   - login(): faz login e cacheia token
 *   - searchContactByPhone(phone): busca contato por telefone (POST /v1/crm/generic-search)
 *   - searchContactByEmail(email): busca por email
 *   - searchContact(query): busca generica
 *   - updateOdooPartnerFromRedrive(env, partnerId, redriveContact): atualiza partner no Odoo
 *   - updateOdooLeadFromRedrive(env, leadId, redriveContact): atualiza lead no Odoo
 *   - mapCampoAuxiliarToCurso(campo_auxiliar): mapeia string do campo auxiliar -> selection Odoo
 */

const { executeKw, searchRead } = require('./bot-odoo');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Origin': 'https://app.redrive.com.br',
  'Referer': 'https://app.redrive.com.br/',
};

let _tokenCache = null;
let _tokenExpiry = 0;

async function login() {
  // Token expira em ~1h, renovamos a cada 50 min
  if (_tokenCache && Date.now() < _tokenExpiry) {
    return _tokenCache;
  }
  const apiUrl = process.env.REDRIVE_API_URL || 'https://api.redrive.com.br';
  const login_ = process.env.REDRIVE_LOGIN;
  const password = process.env.REDRIVE_PASSWORD;
  if (!login_ || !password) {
    throw new Error('REDRIVE_LOGIN e REDRIVE_PASSWORD env vars necessarias');
  }
  console.log('[Redrive] Fazendo login...');
  const res = await fetch(`${apiUrl}/login`, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: login_, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redrive login HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const token = data.token;
  if (!token) {
    throw new Error('Redrive login: token nao retornado');
  }
  _tokenCache = token;
  _tokenExpiry = Date.now() + 50 * 60 * 1000; // 50 min
  console.log('[Redrive] Login OK (token len=' + token.length + ')');
  return token;
}

async function searchContact(query) {
  const token = await login();
  const apiUrl = process.env.REDRIVE_API_URL || 'https://api.redrive.com.br';
  const res = await fetch(`${apiUrl}/v1/crm/generic-search`, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(query),
  });
  if (res.status === 429) {
    // Rate limit — espera 3s e tenta de novo
    console.log('[Redrive] Rate limit (429), esperando 3s...');
    await new Promise(r => setTimeout(r, 3000));
    return searchContact(query);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Redrive search HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

async function searchContactByPhone(phone) {
  // Limpa phone: so digitos
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  // Tenta com phone e mobilephone
  let results = await searchContact({ phone: digits });
  if (!results || results.length === 0) {
    results = await searchContact({ mobilephone: digits });
  }
  return results && results.length > 0 ? results[0] : null;
}

async function searchContactByEmail(email) {
  if (!email || !email.includes('@')) return null;
  const results = await searchContact({ email });
  return results && results.length > 0 ? results[0] : null;
}

// === Mapeamento campo_auxiliar -> x_curso_interesse (Odoo selection) ===
// Selection Odoo: 4SX, Vendas EVI, Lideranca GCI, Performe Estrategia DCI, indefinido, 4SX - PG
function mapCampoAuxiliarToCurso(campo_auxiliar) {
  const v = String(campo_auxiliar || '').trim().toLowerCase();
  if (!v) return false;
  if (v.includes('4sx') && v.includes('pg')) return '4SX - PG';
  if (v.includes('4sx')) return '4SX';
  if (v.includes('evi') || v.includes('vendas')) return 'Performe Vendas EVI';
  if (v.includes('gci') || v.includes('lider')) return 'Performe Liderança GCI';
  if (v.includes('dci') || v.includes('estrat')) return 'Performe Estratégia DCI';
  return 'indefinido';
}

// === Atualiza partner no Odoo com dados do contato Redrive ===
async function updateOdooPartnerFromRedrive(env, partnerId, rc) {
  const vals = {};
  if (rc.firstname || rc.lastname) {
    const name = `${rc.firstname || ''} ${rc.lastname || ''}`.trim();
    if (name) vals.name = name;
  }
  if (rc.email) vals.email = rc.email;
  if (rc.phone) vals.phone = '+' + String(rc.phone).replace(/\D/g, '');
  // Odoo 19.4: res.partner NAO tem campo 'mobile', so 'phone'
  // if (rc.mobilephone) vals.mobile = '+' + String(rc.mobilephone).replace(/\D/g, '');
  if (rc.address) vals.street = rc.address;
  if (rc.number) vals.street = (vals.street || '') + (vals.street ? ', ' : '') + rc.number;
  if (rc.district) vals.street2 = rc.district;
  if (rc.zipcode) vals.zip = String(rc.zipcode).replace(/\D/g, '');
  if (rc.city) vals.city = rc.city;
  if (rc.uf) {
    // Tenta achar state_id por UF
    try {
      const states = await searchRead(env, 'res.country.state',
        [['code', '=', rc.uf.toUpperCase()], ['country_id.code', '=', 'BR']],
        ['id'], 1);
      if (states && states.length > 0) vals.state_id = states[0].id;
    } catch (e) {}
  }
  // curso_auxiliar -> x_curso_interesse
  const curso = mapCampoAuxiliarToCurso(rc.campo_auxiliar);
  if (curso) vals.x_curso_interesse = curso;

  if (Object.keys(vals).length === 0) {
    return { ok: false, error: 'Nada para atualizar' };
  }

  try {
    await executeKw(env, 'res.partner', 'write', [[partnerId], vals]);
    return { ok: true, vals };
  } catch (e) {
    return { ok: false, error: String(e), vals };
  }
}

// === Atualiza lead no Odoo com dados do contato Redrive ===
async function updateOdooLeadFromRedrive(env, leadId, rc) {
  const vals = {};
  if (rc.firstname || rc.lastname) {
    const name = `${rc.firstname || ''} ${rc.lastname || ''}`.trim();
    if (name) {
      vals.contact_name = name;
      vals.partner_name = name;
    }
  }
  if (rc.email) vals.email_from = rc.email;
  if (rc.phone) vals.phone = '+' + String(rc.phone).replace(/\D/g, '');
  // crm.lead NAO tem 'mobile'
  if (rc.address) vals.street = rc.address;
  if (rc.number) vals.street = (vals.street || '') + (vals.street ? ', ' : '') + rc.number;
  if (rc.district) vals.street2 = rc.district;
  if (rc.zipcode) vals.zip = String(rc.zipcode).replace(/\D/g, '');
  if (rc.city) vals.city = rc.city;
  if (rc.uf) {
    try {
      const states = await searchRead(env, 'res.country.state',
        [['code', '=', rc.uf.toUpperCase()], ['country_id.code', '=', 'BR']],
        ['id'], 1);
      if (states && states.length > 0) vals.state_id = states[0].id;
    } catch (e) {}
  }
  const curso = mapCampoAuxiliarToCurso(rc.campo_auxiliar);
  if (curso) vals.x_curso_interesse = curso;

  if (Object.keys(vals).length === 0) {
    return { ok: false, error: 'Nada para atualizar' };
  }

  try {
    await executeKw(env, 'crm.lead', 'write', [[leadId], vals]);
    return { ok: true, vals };
  } catch (e) {
    return { ok: false, error: String(e), vals };
  }
}

// === Posta resumo do contato Redrive no chatter do partner/lead ===
async function postRedriveContactToChatter(env, model, recordId, rc) {
  const curso = mapCampoAuxiliarToCurso(rc.campo_auxiliar);
  let body = `<b>Atualizado da Redrive</b><br/>`;
  body += `<b>Nome:</b> ${rc.firstname || ''} ${rc.lastname || ''}<br/>`;
  body += `<b>Telefone:</b> ${rc.phone || '-'}<br/>`;
  body += `<b>E-mail:</b> ${rc.email || '-'}<br/>`;
  body += `<b>Campo auxiliar (curso):</b> ${rc.campo_auxiliar || '-'}<br/>`;
  if (curso) body += `<b>Curso mapeado:</b> ${curso}<br/>`;
  if (rc.city) body += `<b>Cidade:</b> ${rc.city}<br/>`;
  if (rc.uf) body += `<b>UF:</b> ${rc.uf}<br/>`;
  if (rc.address) body += `<b>Endereço:</b> ${rc.address}${rc.number ? ', ' + rc.number : ''}${rc.district ? ' - ' + rc.district : ''}<br/>`;
  if (rc.instagram) body += `<b>Instagram:</b> @${rc.instagram}<br/>`;
  if (rc.tags && rc.tags.length) body += `<b>Tags:</b> ${rc.tags.join(', ')}<br/>`;
  body += `<b>UUID:</b> ${rc.uuid || rc.id || '-'}<br/>`;
  body += `<b>Atualizado em:</b> ${rc.updatedAt || new Date().toISOString()}<br/>`;
  try {
    // message_post aceita só kwargs - usar args=[recordId], kwargs={body,...}
    await executeKw(env, model, 'message_post', [recordId], {
      body,
      message_type: 'notification',
      subtype_xmlid: 'mail.mt_note',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

module.exports = {
  login,
  searchContact,
  searchContactByPhone,
  searchContactByEmail,
  mapCampoAuxiliarToCurso,
  updateOdooPartnerFromRedrive,
  updateOdooLeadFromRedrive,
  postRedriveContactToChatter,
};
