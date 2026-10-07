/**
 * services/nfse-cancelamento.js — Cancelamento de NFS-e (SEFIN REST)
 * =================================================================
 * Desde 01/10/2025, cancelamento via API REST (evento 101101).
 * Envia pedido de cancelamento como pedRegEvento na API SEFIN.
 * Schema: v1.01 — raiz <pedRegEvento>, info <infPedReg>, evento <e101101>
 */

const config = require('../config');
const { carregarCertificado } = require('./firebase-cert');
const axios = require('axios');
const https = require('https');
const zlib = require('zlib');
const { assinarXml } = require('./nfse-signer');

const NS = 'http://www.sped.fazenda.gov.br/nfse';

function createHttpsAgent(cert) {
  if (!cert) return null;
  const tlsOpts = { rejectUnauthorized: !config.tls_insecure };
  if (cert.pfx) {
    return new https.Agent({ ...tlsOpts, pfx: cert.pfx, passphrase: cert.senha || '' });
  }
  if (cert.privateKeyPem && cert.certPem) {
    return new https.Agent({ ...tlsOpts, key: cert.privateKeyPem, cert: cert.certPem });
  }
  return null;
}

function gzipBase64(str) {
  return new Promise((resolve, reject) => {
    zlib.gzip(Buffer.from(str, 'utf-8'), (err, compressed) => {
      if (err) return reject(err);
      resolve(compressed.toString('base64'));
    });
  });
}

/**
 * Formata data/hora no formato ISO 8601 com timezone (-03:00), sem milissegundos.
 * Ex: 2026-08-31T14:35:50-03:00
 */
function formatDhEvento() {
  const now = new Date();
  const offset = -3; // BRT
  const local = new Date(now.getTime() + offset * 60 * 60 * 1000);
  const yyyy = local.getFullYear();
  const mm = String(local.getMonth() + 1).padStart(2, '0');
  const dd = String(local.getDate()).padStart(2, '0');
  const hh = String(local.getHours()).padStart(2, '0');
  const mi = String(local.getMinutes()).padStart(2, '0');
  const ss = String(local.getSeconds()).padStart(2, '0');
  const tzSign = offset >= 0 ? '+' : '-';
  const tzH = String(Math.abs(offset)).padStart(2, '0');
  const tzM = '00';
  return yyyy + '-' + mm + '-' + dd + 'T' + hh + ':' + mi + ':' + ss + tzSign + tzH + ':' + tzM;
}

/**
 * Cancela uma NFS-e ja autorizada.
 * Usa a API de eventos: POST /SefinNacional/nfse/{chaveAcesso}/eventos
 * @param {object} params
 * @returns {object} { sucesso, cStat, xMotivo }
 */
async function cancelarNfse(params) {
  const { nNFSe, nDFSe, cnpjPrest, justificativa, infNfseId } = params;
  console.log('[NFSE-CANCEL-SVC] cancelarNfse chamado | chaveAcesso=' + (params.chaveAcesso || '(vazio)') + ' | nNFSe=' + (nNFSe || 'n/a') + ' | cnpjPrest=' + (cnpjPrest || 'n/a'));

  const cert = await carregarCertificado();
  if (!cert || (!cert.pfx && !cert.privateKeyPem)) {
    console.log('[NFSE-CANCEL-SVC] ERRO: Certificado A1 nao disponivel');
    return { sucesso: false, cStat: 0, xMotivo: 'Certificado A1 nao disponivel' };
  }
  console.log('[NFSE-CANCEL-SVC] Certificado carregado com sucesso');

  // Se temos a chave de acesso, usamos a API de eventos
  if (params.chaveAcesso) {
    console.log('[NFSE-CANCEL-SVC] Chave de acesso presente, usando API de eventos...');
    return cancelarViaEvento(params, cert);
  }

  // Fallback: sem chave de acesso, nao e possivel cancelar via nova API
  console.log('[NFSE-CANCEL-SVC] BLOQUEADO: Sem chave de acesso, nao e possivel cancelar');
  return {
    sucesso: false,
    cStat: 0,
    xMotivo: 'Cancelamento requer chave de acesso da NFS-e (campo x_performe_nfse_codigo_verificacao). Reemita a nota e tente novamente.',
  };
}

async function cancelarViaEvento(params, cert) {
  const { chaveAcesso, justificativa, cnpjPrest } = params;
  const baseUrl = config.nfse.tp_amb === 1 ? config.sefin.producao : config.sefin.homologacao;
  const url = baseUrl + '/nfse/' + chaveAcesso + '/eventos';
  console.log('[NFSE-CANCEL-SVC] URL do evento: ' + url);
  console.log('[NFSE-CANCEL-SVC] Ambiente: ' + (config.nfse.tp_amb === 1 ? 'PRODUCAO' : 'HOMOLOGACAO'));

  const dhEvento = formatDhEvento();
  const tpAmb = String(config.nfse.tp_amb);
  const verAplic = config.nfse.ver_aplic || 'performemais_1.0.0';

  // CNPJ do prestador/autor (apenas digitos)
  const cnpjAutor = (cnpjPrest || '').replace(/[^0-9]/g, '');
  if (!cnpjAutor || cnpjAutor.length !== 14) {
    console.log('[NFSE-CANCEL-SVC] ERRO: CNPJ do prestador invalido: ' + cnpjAutor);
    return { sucesso: false, cStat: 0, xMotivo: 'CNPJ do prestador invalido (' + cnpjAutor + ')' };
  }

  // xMotivo: garantir minimo 15 caracteres (XSD exige minLength=15)
  let xMotivo = justificativa || 'Cancelamento solicitado pelo emitente';
  if (xMotivo.length < 15) xMotivo = xMotivo + ' - verifique os dados';
  if (xMotivo.length > 255) xMotivo = xMotivo.substring(0, 255);

  // infPedReg Id: "PRE" + chave(50 digitos) + tpEvento(6 digitos) = 59 chars
  const tpEvento = '101101';
  const infPedRegId = 'PRE' + chaveAcesso + tpEvento;
  console.log('[NFSE-CANCEL-SVC] infPedReg Id: ' + infPedRegId + ' (' + infPedRegId.length + ' chars)');

  // === Gera XML pedRegEvento v1.01 ===
  const eventoXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<pedRegEvento xmlns="' + NS + '" versao="1.01">' +
    '<infPedReg Id="' + infPedRegId + '">' +
    '<tpAmb>' + tpAmb + '</tpAmb>' +
    '<verAplic>' + verAplic + '</verAplic>' +
    '<dhEvento>' + dhEvento + '</dhEvento>' +
    '<CNPJAutor>' + cnpjAutor + '</CNPJAutor>' +
    '<chNFSe>' + chaveAcesso + '</chNFSe>' +
    '<e101101>' +
    '<xDesc>Cancelamento de NFS-e</xDesc>' +
    '<cMotivo>9</cMotivo>' +
    '<xMotivo>' + escapeXml(xMotivo) + '</xMotivo>' +
    '</e101101>' +
    '</infPedReg>' +
    '</pedRegEvento>';
  console.log('[NFSE-CANCEL-SVC] XML pedRegEvento gerado (' + eventoXml.length + ' bytes)');

  try {
    console.log('[NFSE-CANCEL-SVC] Assinando XML (infPedReg)...');
    const assinado = await assinarXml(eventoXml, {
      privateKeyPem: cert.privateKeyPem,
      certPem: cert.certPem,
    });
    console.log('[NFSE-CANCEL-SVC] XML assinado (' + assinado.length + ' bytes)');

    console.log('[NFSE-CANCEL-SVC] Comprimindo (gzip+base64)...');
    const eventoGzipB64 = await gzipBase64(assinado);
    console.log('[NFSE-CANCEL-SVC] Enviando POST para SEFIN... (gzipB64 length=' + eventoGzipB64.length + ')');

    const body = { pedidoRegistroEventoXmlGZipB64: eventoGzipB64 };

    const httpsAgent = createHttpsAgent(cert);
    const response = await axios.post(url, body, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      httpsAgent: httpsAgent || undefined,
      timeout: 30000,
      rejectUnauthorized: !config.tls_insecure,
      transformResponse: [data => data],
    });

    console.log('[NFSE-CANCEL-SVC] Resposta HTTP: ' + response.status + ' ' + response.statusText);

    let respJson = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    console.log('[NFSE-CANCEL-SVC] Resposta SEFIN: ' + JSON.stringify(respJson).substring(0, 500));

    if (respJson.erro && respJson.erro.length > 0) {
      const msg = respJson.erro.map(e => (e.codigo || '') + ' ' + (e.descricao || e.mensagem || '')).join('; ');
      console.log('[NFSE-CANCEL-SVC] ERRO retornado pela SEFIN: ' + msg);
      return { sucesso: false, cStat: 0, xMotivo: msg };
    }

    // Verifica se tem eventos retornados com erro
    if (respJson.eventos && respJson.eventos.length > 0) {
      const evt = respJson.eventos[0];
      if (evt.infEvento && evt.infEvento.erro) {
        const msg = evt.infEvento.erro.map(e => (e.codigo || '') + ' ' + (e.descricao || e.mensagem || '')).join('; ');
        console.log('[NFSE-CANCEL-SVC] ERRO no evento: ' + msg);
        return { sucesso: false, cStat: 0, xMotivo: msg };
      }
      // Sucesso no evento
      const cStat = evt.infEvento && evt.infEvento.cStat ? evt.infEvento.cStat : '101';
      const xMot = evt.infEvento && evt.infEvento.xMotivo ? evt.infEvento.xMotivo : 'Cancelamento registrado';
      console.log('[NFSE-CANCEL-SVC] SUCESSO: ' + xMot);
      return { sucesso: true, cStat: cStat, xMotivo: xMot, dados: respJson };
    }

    console.log('[NFSE-CANCEL-SVC] SUCESSO: Cancelamento registrado com sucesso na SEFIN');
    return {
      sucesso: true,
      cStat: 101,
      xMotivo: 'Cancelamento registrado com sucesso',
      dados: respJson,
    };
  } catch (err) {
    const msg = err.response
      ? 'HTTP ' + err.response.status + ': ' + JSON.stringify(err.response.data || '').substring(0, 300)
      : err.message;
    console.error('[NFSE-CANCEL-SVC] ERRO na comunicacao com SEFIN:', msg);
    if (err.stack) console.error('[NFSE-CANCEL-SVC] Stack:', err.stack);
    return { sucesso: false, cStat: 0, xMotivo: msg };
  }
}

/** Escapa caracteres especiais XML */
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { cancelarNfse };
