/**
 * services/nfse-client.js — Cliente REST da API SEFIN NFS-e Nacional
 * ==================================================================
 * Desde 01/10/2025 a NFS-e Nacional migrou de SOAP para REST API.
 * O DPS XML (SPED v1.01) e enviado como JSON com campo dpsXmlGZipB64
 * (XML compactado em GZip + representacao base64binary).
 * Autenticacao: mTLS com certificado A1 ICP-Brasil.
 */

const axios = require('axios');
const https = require('https');
const zlib = require('zlib');
const config = require('../config');

/** Retorna a base URL conforme ambiente */
function getBaseUrl() {
  return config.nfse.tp_amb === 1
    ? config.sefin.producao
    : config.sefin.homologacao;
}

/** Cria agente HTTPS com certificado A1 (mTLS) */
function createHttpsAgent(cert) {
  if (!cert) return null;
  const tlsOpts = { rejectUnauthorized: !config.tls_insecure };

  // 1. Tenta PFX com senha
  if (cert.pfx) {
    console.log('[NFSE-CLIENT] Usando PFX para mTLS (pfx=' + cert.pfx.length + ' bytes, senha=' + (cert.senha ? 'sim' : 'nao') + ')');
    return new https.Agent({ ...tlsOpts, pfx: cert.pfx, passphrase: cert.senha || '' });
  }

  // 2. Fallback PEM
  if (cert.privateKeyPem && cert.certPem) {
    console.log('[NFSE-CLIENT] Usando PEM para mTLS (key=' + cert.privateKeyPem.length + ' bytes, cert=' + cert.certPem.length + ' bytes)');
    return new https.Agent({ ...tlsOpts, key: cert.privateKeyPem, cert: cert.certPem });
  }

  console.warn('[NFSE-CLIENT] Nenhum certificado disponivel para mTLS!');
  return null;
}

/**
 * Comprime string em GZip e retorna Base64.
 * @param {string} str - String a comprimir (geralmente XML)
 * @returns {string} Base64 do GZip
 */
function gzipBase64(str) {
  return new Promise((resolve, reject) => {
    zlib.gzip(Buffer.from(str, 'utf-8'), (err, compressed) => {
      if (err) return reject(err);
      resolve(compressed.toString('base64'));
    });
  });
}

/**
 * Descomprime Base64 GZip para string.
 * @param {string} b64 - Base64 do GZip
 * @returns {string} String descomprimida
 */
function gunzipBase64(b64) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(b64, 'base64');
    zlib.gunzip(buf, (err, decompressed) => {
      if (err) return reject(err);
      resolve(decompressed.toString('utf-8'));
    });
  });
}

/**
 * Envia DPS assinado para a API REST SEFIN NFS-e.
 * @param {string} dpsXmlAssinado - XML DPS completo com assinatura XMLDSIG
 * @param {object} cert - { pfx, certPem, chainPem, privateKeyPem, senha }
 * @returns {object} { sucesso, chaveAcesso, idDps, nfseXml, erros, xmlRetorno }
 */
async function enviarDPS(dpsXmlAssinado, cert) {
  const baseUrl = getBaseUrl();
  const url = baseUrl + '/nfse';

  console.log('[NFSE-CLIENT] Enviando DPS para ' + url);
  console.log('[NFSE-CLIENT] XML DPS assinado: ' + dpsXmlAssinado.length + ' bytes');

  try {
    // 1. Comprime XML DPS em GZip + Base64
    const dpsGzipB64 = await gzipBase64(dpsXmlAssinado);
    console.log('[NFSE-CLIENT] DPS GZip+Base64: ' + dpsGzipB64.length + ' chars');

    // 2. Monta body JSON
    const body = {
      dpsXmlGZipB64: dpsGzipB64,
    };

    // 3. Envia POST com mTLS
    const httpsAgent = createHttpsAgent(cert);
    const response = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      httpsAgent: httpsAgent || undefined,
      timeout: 30000,
      rejectUnauthorized: !config.tls_insecure,
      // Nao transforma resposta (precisamos do JSON cru)
      transformResponse: [data => data],
    });

    // 4. Parseia resposta JSON
    let respJson;
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      if (typeof response.data === 'string') {
        respJson = JSON.parse(response.data);
      } else {
        respJson = response.data;
      }
    } else {
      // Resposta inesperada — retorna como erro
      const txt = typeof response.data === 'string' ? response.data.substring(0, 500) : JSON.stringify(response.data).substring(0, 500);
      console.error('[NFSE-CLIENT] Resposta inesperada (HTTP ' + response.status + '): ' + txt);
      return {
        sucesso: false,
        cStat: 0,
        xMotivo: 'Resposta inesperada do servidor: HTTP ' + response.status,
        httpStatus: response.status,
      };
    }

    console.log('=============================================================');
    console.log('[NFSE-CLIENT] RESPOSTA SEFIN COMPLETA (HTTP ' + response.status + '):');
    console.log(JSON.stringify(respJson, null, 2));
    console.log('=============================================================');
    console.log('[NFSE-CLIENT] tipoAmbiente=' + respJson.tipoAmbiente);
    console.log('[NFSE-CLIENT] dataHoraProcessamento=' + (respJson.dataHoraProcessamento || 'n/a'));
    console.log('[NFSE-CLIENT] chaveAcesso=' + (respJson.chaveAcesso || 'n/a'));
    console.log('[NFSE-CLIENT] idDps=' + (respJson.idDps || 'n/a'));
    console.log('[NFSE-CLIENT] nfseXmlGZipB64 presente=' + !!(respJson.nfseXmlGZipB64) + ' (' + (respJson.nfseXmlGZipB64 ? respJson.nfseXmlGZipB64.length + ' chars' : 'n/a') + ')');
    console.log('[NFSE-CLIENT] erros=' + JSON.stringify(respJson.erros || []));
    console.log('[NFSE-CLIENT] alertas=' + JSON.stringify(respJson.alertas || []));

    // 5. Verifica se ha erros na resposta
    if (respJson.erros && respJson.erros.length > 0) {
      const errosMsg = respJson.erros.map(e =>
        '[' + (e.codigo || '?') + '] ' + (e.descricao || e.mensagem || '') + (e.complemento ? ' — ' + e.complemento : '')
      ).join('; ');
      console.error('[NFSE-CLIENT] Rejeicao SEFIN: ' + errosMsg);
      return {
        sucesso: false,
        cStat: 0,
        xMotivo: errosMsg,
        erros: respJson.erros,
        idDps: respJson.idDps || null,
      };
    }

    // 6. Sucesso! Extrai dados da NFS-e
    if (respJson.chaveAcesso) {
      let nfseXml = null;
      if (respJson.nfseXmlGZipB64) {
        try {
          nfseXml = await gunzipBase64(respJson.nfseXmlGZipB64);
          console.log('[NFSE-CLIENT] NFS-e XML descompactado: ' + nfseXml.length + ' bytes');
        } catch (e) {
          console.warn('[NFSE-CLIENT] Falha ao descompactar NFS-e XML:', e.message);
        }
      }

      // Extrai numero da NFS-e e codigo verificacao do XML
      let nNFSe = null;
      let nDFSe = null;
      if (nfseXml) {
        const nNFSeMatch = nfseXml.match(/<nNFSe>(\d+)<\/nNFSe>/);
        const nDFSeMatch = nfseXml.match(/<nDFSe>(\d+)<\/nDFSe>/);
        if (nNFSeMatch) nNFSe = nNFSeMatch[1];
        if (nDFSeMatch) nDFSe = nDFSeMatch[1];
      }

      console.log('[NFSE-CLIENT] =============================================');
      console.log('[NFSE-CLIENT] NFS-e AUTORIZADA COM SUCESSO!');
      console.log('[NFSE-CLIENT]   Chave de Acesso: ' + respJson.chaveAcesso);
      console.log('[NFSE-CLIENT]   nNFSe (SEFIN): ' + (nNFSe || 'n/a'));
      console.log('[NFSE-CLIENT]   nDFSe (SEFIN): ' + (nDFSe || 'n/a'));
      console.log('[NFSE-CLIENT]   IdDPS: ' + (respJson.idDps || 'n/a'));
      console.log('[NFSE-CLIENT]   dhProc: ' + (respJson.dataHoraProcessamento || 'n/a'));
      console.log('[NFSE-CLIENT]   verAplic SEFIN: ' + (respJson.versaoAplicativo || 'n/a'));

      // Log de valores para debug - comparar vServ (enviado) vs vLiq (retornado)
      if (nfseXml) {
        const vLiqMatch = nfseXml.match(/<vLiq>([^<]+)<\/vLiq>/);
        const vServMatch = nfseXml.match(/<vServ>([^<]+)<\/vServ>/);
        const vBCISSQNMatch = nfseXml.match(/<vBCISSQN>([^<]+)<\/vBCISSQN>/);
        const vISSQNMatch = nfseXml.match(/<vISSQN>([^<]+)<\/vISSQN>/);
        const tpRetISSQNMatch = nfseXml.match(/<tpRetISSQN>([^<]+)<\/tpRetISSQN>/);
        console.log('[NFSE-CLIENT]   vServ (DPS): ' + (vServMatch ? vServMatch[1] : 'n/a'));
        console.log('[NFSE-CLIENT]   vLiq (NFSe retorno): ' + (vLiqMatch ? vLiqMatch[1] : 'n/a'));
        console.log('[NFSE-CLIENT]   vBCISSQN: ' + (vBCISSQNMatch ? vBCISSQNMatch[1] : 'n/a'));
        console.log('[NFSE-CLIENT]   vISSQN: ' + (vISSQNMatch ? vISSQNMatch[1] : 'n/a'));
        console.log('[NFSE-CLIENT]   tpRetISSQN: ' + (tpRetISSQNMatch ? tpRetISSQNMatch[1] : 'n/a') + ' (1=Nao Retido, 2=Retido)');
      }
      console.log('[NFSE-CLIENT] =============================================');

      // Alertas informativos (nao sao erros)
      if (respJson.alertas && respJson.alertas.length > 0) {
        console.log('[NFSE-CLIENT] Alertas: ' + respJson.alertas.map(a => a.mensagem || a.descricao).join('; '));
      }

      return {
        sucesso: true,
        cStat: 100,
        xMotivo: 'NFS-e autorizada',
        chaveAcesso: respJson.chaveAcesso,
        idDps: respJson.idDps,
        nNFSe: nNFSe,
        nDFSe: nDFSe,
        dataHoraProcessamento: respJson.dataHoraProcessamento,
        nfseXml: nfseXml,
        xmlRetorno: nfseXml,
        alertas: respJson.alertas || [],
      };
    }

    // Resposta sem chave de acesso e sem erros
    console.warn('[NFSE-CLIENT] Resposta sem chaveAcesso e sem erros:', JSON.stringify(respJson).substring(0, 300));
    return {
      sucesso: false,
      cStat: 0,
      xMotivo: 'Resposta sem chave de acesso',
      respostaOriginal: respJson,
    };

  } catch (err) {
    const msg = err.response
      ? 'HTTP ' + err.response.status + ': ' + (typeof err.response.data === 'string' ? err.response.data.substring(0, 500) : JSON.stringify(err.response.data).substring(0, 500))
      : err.message;
    console.error('[NFSE-CLIENT] Erro ao enviar DPS:', msg);
    return { sucesso: false, cStat: 0, xMotivo: msg };
  }
}

/**
 * Consulta uma NFS-e pela chave de acesso (50 digitos).
 * GET /SefinNacional/nfse/{chaveAcesso}
 */
async function consultarNfse(chaveAcesso, cert) {
  const baseUrl = getBaseUrl();
  const url = baseUrl + '/nfse/' + chaveAcesso;

  try {
    const httpsAgent = createHttpsAgent(cert);
    const response = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
      },
      httpsAgent: httpsAgent || undefined,
      timeout: 15000,
      rejectUnauthorized: !config.tls_insecure,
      transformResponse: [data => data],
    });

    let respJson = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

    // Descomprime XML da NFS-e se presente
    if (respJson.nfseXmlGZipB64) {
      try {
        respJson.nfseXml = await gunzipBase64(respJson.nfseXmlGZipB64);
      } catch (e) {
        console.warn('[NFSE-CLIENT] Falha ao descompactar consulta:', e.message);
      }
    }

    return { sucesso: true, dados: respJson };
  } catch (err) {
    return { sucesso: false, cStat: 0, xMotivo: err.message };
  }
}

/**
 * Consulta DPS pelo ID para obter chave de acesso.
 * GET /SefinNacional/dps/{id}
 */
async function consultarDps(idDps, cert) {
  const baseUrl = getBaseUrl();
  const url = baseUrl + '/dps/' + idDps;

  try {
    const httpsAgent = createHttpsAgent(cert);
    const response = await axios.get(url, {
      headers: { 'Accept': 'application/json' },
      httpsAgent: httpsAgent || undefined,
      timeout: 15000,
      rejectUnauthorized: !config.tls_insecure,
      transformResponse: [data => data],
    });

    let respJson = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    return { sucesso: true, dados: respJson };
  } catch (err) {
    return { sucesso: false, xMotivo: err.message };
  }
}

/**
 * Tenta baixar o PDF oficial do DANFSe do ADN.
 *
 * AVISO IMPORTANTE (NT 008/2026 v1.02, 14/07/2026):
 *   O endpoint de download do DANFSe no ADN foi SUSPENSO em 03/08/2026.
 *   A responsabilidade de gerar o DANFSe passou ao emissor (NT 008/2026).
 *   Esta funcao e mantida como tentativa futura (se o gov reativar),
 *   mas na pratica o PDF sera sempre gerado localmente via open-nfse.
 *
 * Endpoints (historico):
 *   Producao:      https://adn.nfse.gov.br/danfse/{chaveAcesso}
 *   Homologacao:   https://adn.producaorestrita.nfse.gov.br/danfse/{chaveAcesso}
 *   Antigo SEFIN:  https://sefin.nfse.gov.br/SefinNacional/danfse/{chaveAcesso} (501 desde 09/2025)
 *
 * @param {string} chaveAcesso - Chave de acesso da NFS-e (50 digitos)
 * @param {object} cert - Certificado A1 para mTLS
 * @returns {Promise<Buffer|null>} Buffer do PDF ou null se indisponivel
 */
async function baixarPdfDanfse(chaveAcesso, cert) {
  if (!chaveAcesso) {
    console.warn('[NFSE-CLIENT-PDF] Chave de acesso vazia, nao e possivel baixar PDF oficial.');
    return null;
  }

  // URLs do ADN (Ambiente de Danfse Nacional) — endpoint oficial para PDF
  const isProd = config.nfse.tp_amb === 1;
  const urlCandidates = [
    // ADN — endereco correto desde out/2025 (forum.casadodesenvolvedor.com.br)
    isProd
      ? 'https://adn.nfse.gov.br/danfse/' + chaveAcesso
      : 'https://adn.producaorestrita.nfse.gov.br/danfse/' + chaveAcesso,
    // URLs antigas/alternativas (fallback)
    'https://sefin.nfse.gov.br/SefinNacional/danfse/' + chaveAcesso,
    'https://sefin.nfse.gov.br/sefinnacional/danfse/' + chaveAcesso,
  ];

  const httpsAgent = createHttpsAgent(cert);

  for (const url of urlCandidates) {
    try {
      console.log('[NFSE-CLIENT-PDF] Tentando: ' + url);
      const response = await axios.get(url, {
        headers: {
          'Accept': 'application/pdf, */*',
        },
        httpsAgent: httpsAgent || undefined,
        timeout: 20000,
        rejectUnauthorized: !config.tls_insecure,
        responseType: 'arraybuffer',
      });

      const contentType = response.headers['content-type'] || '';
      const buf = Buffer.from(response.data);

      // Verifica se recebeu um PDF valido (comeca com %PDF-)
      if (buf.length > 100 && buf.slice(0, 5).toString('ascii').startsWith('%PDF-')) {
        console.log('[NFSE-CLIENT-PDF] PDF OFICIAL do gov.br baixado com sucesso: ' + buf.length + ' bytes de ' + url);
        return buf;
      }

      // Se a resposta e JSON/XML, nao e PDF
      if (contentType.includes('application/json') || contentType.includes('application/xml') || contentType.includes('text/html')) {
        console.log('[NFSE-CLIENT-PDF] Resposta nao e PDF (Content-Type: ' + contentType + '), tentando proxima URL...');
        continue;
      }

      // Resposta inesperada
      console.log('[NFSE-CLIENT-PDF] Resposta inesperada: HTTP ' + response.status + ', Content-Type: ' + contentType + ', size: ' + buf.length);
    } catch (err) {
      const status = err.response ? 'HTTP ' + err.response.status : err.message;
      console.log('[NFSE-CLIENT-PDF] Falha em ' + url + ': ' + status);
    }
  }

  console.warn('[NFSE-CLIENT-PDF] Nenhuma URL retornou PDF oficial. Isso e esperado desde 03/08/2026 (NT 008/2026 suspendeu o endpoint).');
  console.warn('[NFSE-CLIENT-PDF] O DANFSe sera gerado localmente via open-nfse (padrao nacional) como estrategia principal.');
  return null;
}

/**
 * Testa conexao com a API SEFIN.
 */
async function testarConexao(cert) {
  const baseUrl = getBaseUrl();
  const url = baseUrl + '/nfse';

  try {
    // Tenta um GET simples no endpoint base (deve retornar 405 Method Not Allowed ou similar, mas prova que DNS + TLS funciona)
    const httpsAgent = createHttpsAgent(cert);
    await axios.get(baseUrl, {
      httpsAgent: httpsAgent || undefined,
      timeout: 10000,
      rejectUnauthorized: !config.tls_insecure,
    });
    return { online: true, mensagem: 'Conexao OK com ' + baseUrl };
  } catch (err) {
    // 404/405 indica que o servidor respondeu (DNS + TLS OK)
    if (err.response && (err.response.status === 404 || err.response.status === 405 || err.response.status === 401)) {
      return { online: true, mensagem: 'Servidor SEFIN acessivel em ' + baseUrl + ' (HTTP ' + err.response.status + ')' };
    }
    return { online: false, mensagem: 'Falha: ' + err.message.substring(0, 150) };
  }
}

module.exports = { enviarDPS, consultarNfse, consultarDps, baixarPdfDanfse, testarConexao, getBaseUrl };
