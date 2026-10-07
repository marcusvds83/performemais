/**
 * services/nfse-xml.js — Gerador de XML DPS (SPED NFS-e v1.01)
 * =============================================================
 * Gera o XML do Documento de Prestacao de Servicos (DPS) no formato
 * do SPED NFS-e v1.01, conforme XSD oficial:
 *   https://dl.ellotecnologia.com/NFS-e/Schemas/PadraoNacional/1.01/
 *
 * Estrutura XSD (TCInfDPS -> ordem estrita):
 *   tpAmb, dhEmi, verAplic, serie, nDPS, dCompet, tpEmit,
 *   [cMotivoEmisTI], [chNFSeRej], cLocEmi, [subst],
 *   prest (TCInfoPrestador),
 *   toma (TCInfoPessoa, optional),
 *   serv (TCServ),
 *   valores (TCInfoValores),
 *   [IBSCBS]
 *
 * TCIBSCBS (NT 004/2025 v2.0 — obrigatorios desde 01/01/2026):
 *   CINOP, cClassTrib, IBS { CST, vBCIBS, pIBS, vIBS }, CBS { CST, vBCcbs, pCBS, vCBS }
 *
 * TCInfoPrestador ordem:
 *   CNPJ/CPF, [CAEPF], [IM], [xNome], [end], [fone], [email], regTrib
 *
 * TCInfoPessoa (toma) ordem:
 *   CNPJ/CPF, [CAEPF], [IM], xNome, [end], [fone], [email]
 *
 * TCEndereco ordem:
 *   endNac/endExt, xLgr, nro, [xCpl], xBairro
 *
 * Namespace: http://www.sped.fazenda.gov.br/nfse
 */

const config = require('../config');
const { getIbsCbsConfig } = require('./trib-config');

const NS = 'http://www.sped.fazenda.gov.br/nfse';

// === Cache IBGE por CEP (ViaCEP) ===
const ibgeCache = {};

/** Busca codigo IBGE do municipio pelo CEP via ViaCEP (com cache) */
async function ibgeFromCep(cep) {
  const cepLimpo = limpaDoc(cep);
  if (!cepLimpo || cepLimpo.length !== 8) return null;
  if (ibgeCache[cepLimpo]) return ibgeCache[cepLimpo];
  try {
    const resp = await fetch('https://viacep.com.br/ws/' + cepLimpo + '/json/', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    if (data && data.ibge) {
      ibgeCache[cepLimpo] = data.ibge;
      console.log('[NFSE-XML] ViaCEP: CEP=' + cepLimpo + ' -> IBGE=' + data.ibge + ' (' + (data.localidade || '') + '/' + (data.uf || '') + ')');
      return data.ibge;
    }
  } catch (e) {
    console.warn('[NFSE-XML] ViaCEP falhou para CEP ' + cepLimpo + ': ' + e.message);
  }
  return null;
}

// === Helpers de formatacao ===

/** Remove pontuacao de CNPJ/CPF */
function limpaDoc(doc) {
  if (!doc) return '';
  return String(doc).replace(/[^0-9]/g, '');
}

/** Formata valor monetario com 2 casas */
function fmtValor(v) {
  return Number(v || 0).toFixed(2);
}

/** Formata data ISO 8601 com timezone */
function fmtDataHora(d) {
  const dt = d ? new Date(d) : new Date();
  // XSD exige TSDateTimeUTC: AAAA-MM-DDThh:mm:ssTZD
  // BRT = -03:00
  const iso = dt.toISOString();
  const utcDate = new Date(iso);
  const brtDate = new Date(utcDate.getTime() - 3 * 60 * 60 * 1000);
  const yyyy = brtDate.getUTCFullYear();
  const MM = String(brtDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(brtDate.getUTCDate()).padStart(2, '0');
  const hh = String(brtDate.getUTCHours()).padStart(2, '0');
  const mm = String(brtDate.getUTCMinutes()).padStart(2, '0');
  const ss = String(brtDate.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}-03:00`;
}

/** Formata data competencia YYYY-MM-DD */
function fmtDataCompet(d) {
  const dt = d ? new Date(d) : new Date();
  const brt = new Date(dt.getTime() - 3 * 60 * 60 * 1000);
  const yyyy = brt.getUTCFullYear();
  const MM = String(brt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(brt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd}`;
}

/** Extrai codigo IBGE do city_id do Odoo (fallback: busca ViaCEP pelo CEP) */
function ibgeFromCity(cityId) {
  // Sem l10n_br_city_id no Odoo Online, sempre usa fallback
  return null; // null sinaliza para usar ViaCEP
}

/** Extrai numero do endereco */
function extraiNumero(street, street2, number) {
  if (number && String(number).trim()) return String(number).trim();
  if (street2 && String(street2).trim() && /^\d+$/.test(street2.trim())) return street2.trim();
  const match = String(street || '').match(/[,\s]+(\d+)[\s,]*$/);
  return match ? match[1] : 'S/N';
}

/** Limpa logradouro removendo numero final */
function limpaLogradouro(street) {
  if (!street) return '';
  return String(street).replace(/[,\s]+\d+[\s,]*$/, '').trim();
}

/** Escapa caracteres especiais XML */
function escXml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Gera bloco de endereco (TCEndereco) - ordem XSD: endNac/endExt, xLgr, nro, [xCpl], xBairro */
function xmlEndereco(cMun, cep, xLgr, nro, xBairro, xCpl) {
  let s = `\n        <end>\n          <endNac>\n            <cMun>${cMun}</cMun>`;
  if (cep) s += `\n            <CEP>${cep}</CEP>`;
  s += `\n          </endNac>`;
  s += `\n          <xLgr>${escXml(xLgr)}</xLgr>`;
  s += `\n          <nro>${escXml(nro)}</nro>`;
  if (xCpl) s += `\n          <xCpl>${escXml(xCpl)}</xCpl>`;
  s += `\n          <xBairro>${escXml(xBairro)}</xBairro>`;
  s += `\n        </end>`;
  return s;
}

// === Gerador do DPS ===

/**
 * Gera o XML DPS conforme XSD v1.01 do SPED NFS-e Nacional.
 */
async function gerarXmlDPS(dados) {
  const { move, company, partner, lines, products, nDPS } = dados;
  const c = config.nfse;

  const cnpjPrest = limpaDoc(company._cnpj);
  const ibge = c.codigo_ibge;
  const serie = c.serie;
  const dhEmi = fmtDataHora(move.invoice_date);
  const dCompet = fmtDataCompet(move.invoice_date);

  // ID do infDPS (formato XSD TSIdDPS: DPS + cMun 7d + tpInsc 1d + InscFed 14d + serie 5d + nDPS 15d = 45 chars)
  // tpInsc: 2=CNPJ, 1=CPF (conforme nfse-js referencia oficial SPED)
  const tpInscPrest = cnpjPrest.length === 14 ? '2' : '1';
  const nDPSIdFmt = String(nDPS).padStart(15, '0');
  const serieFmt = String(serie).padStart(5, '0').slice(-5);
  const infDpsId = `DPS${ibge}${tpInscPrest}${cnpjPrest}${serieFmt}${nDPSIdFmt}`;

  // --- Prestador (TCInfoPrestador) ---
  // Ordem XSD: CNPJ, [CAEPF], [IM], [xNome], [end], [fone], [email], regTrib
  const fonePrest = limpaDoc(company.phone || '');
  const emailPrest = company.email || '';
  const fonePrestXml = fonePrest.length >= 10 ? `\n      <fone>${fonePrest}</fone>` : '';
  const emailPrestXml = emailPrest ? `\n      <email>${escXml(emailPrest)}</email>` : '';

  // IM (Inscricao Municipal) - NAO ENVIAR POR PADRAO
  // Descoberto 03/09/2026 após análise exaustiva E0116 (homologacao) vs E0120 (producao):
  //
  // HOMOLOGACAO (tpAmb=2):
  //   E0116: "A IM deve ser informada" -> SEFIN exige IM no CNC
  //   Mas Performe+ nao esta cadastrada no CNC de homologacao
  //
  // PRODUCAO (tpAmb=1):
  //   E0120: "IM do prestador NAO deve ser informado, pois nao existem
  //          informacoes complementares registradas no CNC NFS-e do municipio"
  //   Performe+ NAO tem IM cadastrada no CNC de producao -> NAO enviar IM
  //   Performe+ emite sem IM em producao e funciona (mesmo cenario)
  //
  // Conclusao: NAO enviar IM por padrao (funciona em producao, igual Performe+)
  // Para forcar envio de IM, setar NFSE_INCLUIR_IM=1
  const forcarIncluirIm = process.env.NFSE_INCLUIR_IM === '1';
  const imFromOdoo = String(company.x_performe_nfse_dados_prestador_im || '').trim();
  const imFromConfig = String(c.inscricao_municipal || '').trim();
  const imOdooValida = imFromOdoo && /^\d{8,15}$/.test(imFromOdoo);
  const imConfigValida = imFromConfig && /^\d{8,15}$/.test(imFromConfig);
  const imPrest = forcarIncluirIm ? (imOdooValida ? imFromOdoo : (imConfigValida ? imFromConfig : '')) : '';
  const imPrestXml = imPrest ? `\n      <IM>${escXml(imPrest)}</IM>` : '';
  console.log('[NFSE-XML] IM prestador: forcarIncluirIm=' + forcarIncluirIm + ' odoo="' + imFromOdoo + '" (valida=' + imOdooValida + ') config="' + imFromConfig + '" (valida=' + imConfigValida + ') usado="' + imPrest + '"');

  // Nome do prestador (xNome) - OPCIONAL via env var NFSE_INCLUIR_XNOME=1
  // Descoberto em 03/09/2026: XML real da Performe+ e da Performe+ NAO tem <xNome> no <prest>
  // XSD permite xNome mas a SEFIN aparentemente rejeita quando vem antes de fone/email
  // Por padrao nao incluir (igual XMLs reais autorizados)
  const incluirXnome = process.env.NFSE_INCLUIR_XNOME === '1';
  const nomePrest = company.name || company.legal_name || '';
  const nomePrestXml = (incluirXnome && nomePrest) ? `\n      <xNome>${escXml(nomePrest)}</xNome>` : '';

  // Endereco do prestador - NAO enviar por padrao
  // Descoberto 03/09/2026: XMLs reais (Performe+ e Performe+) NAO tem <end> no <prest>
  // So a empresa tem endereco no bloco <emit> da NFSe (gerado pela SEFIN)
  // Por padrao nao enviar - se necessario setar NFSE_INCLUIR_END_PREST=1
  const incluirEndPrest = process.env.NFSE_INCLUIR_END_PREST === '1';
  const logrPrest = limpaLogradouro(company.street);
  const nroPrest = extraiNumero(company.street, company.street2);
  const bairroPrest = company.district || company.street2 || '';
  const cepPrest = limpaDoc(company.zip || '');
  const endPrestXml = (incluirEndPrest && (logrPrest || nroPrest !== 'S/N')) ?
    xmlEndereco(ibge, cepPrest, logrPrest, nroPrest, bairroPrest) : '';

  // --- Tomador (TCInfoPessoa) ---
  // Ordem XSD: CNPJ/CPF, [CAEPF], [IM], xNome, [end], [fone], [email]
  const docTomador = limpaDoc(partner._cnpj || partner.vat || '');
  const isCpfTomador = docTomador.length === 11;
  const docTomadorTag = isCpfTomador ? 'CPF' : 'CNPJ';
  const nomeTomador = partner.legal_name || partner.name || '';
  const emailTomador = partner.email || '';
  const foneTomador = limpaDoc(partner.phone || '');
  const nroTomador = extraiNumero(partner.street, partner.street2, partner.number);
  const logrTomador = limpaLogradouro(partner.street);
  const bairroTomador = partner.district || partner.street2 || '';
  const cepTomador = limpaDoc(partner.zip || '');
  let ibgeTomador = ibgeFromCity(partner.city_id || partner._cidade);
  // Se nao achou pelo Odoo, busca pelo CEP via ViaCEP
  if (!ibgeTomador && cepTomador) {
    ibgeTomador = await ibgeFromCep(cepTomador);
  }
  // Fallback final: codigo do prestador (so funciona se tomador for do mesmo municipio)
  if (!ibgeTomador) ibgeTomador = ibge;

  // --- Servico (TCServ) ---
  const firstProduct = lines[0] && lines[0].product_id ? (products[lines[0].product_id[0]] || {}) : {};
  const cTribNac = firstProduct.x_performe_codigo_tributacao || c.c_trib_nac_padrao;
  const cNBS = firstProduct.x_performe_c_nbs || c.c_nbs_padrao;

  // Descricao do servico (xDescServ) — obrigatória, NAO pode ser vazia
  // Deve conter: nome do produto/servico + quantidade + valor unitario
  // Formato: "GPA - Pessoas PRO (Qtd: 1 x R$ 5000.00 = R$ 5000.00) - Termos e condicoes: ..."
  let xDescServ = firstProduct.x_performe_descricao_nfse || '';
  if (!xDescServ) {
    // Monta descricao completa a partir das linhas da fatura
    const partes = lines.map(l => {
      const nome = l.name || '';
      const qtd = l.quantity || 0;
      const valorUnit = l.price_unit || 0;
      const valorTotal = l.price_subtotal || 0;
      // Busca nome do produto se tiver product_id
      const prod = l.product_id && l.product_id[0] ? (products[l.product_id[0]] || {}) : {};
      const nomeProduto = prod.name || '';
      // Formato: "Nome do Produto (Qtd: X x R$ Y,YY = R$ Z,ZZ)"
      const nomeFinal = nomeProduto || nome;
      if (nomeFinal && qtd && valorUnit) {
        return nomeFinal + ' (Qtd: ' + qtd + ' x R$ ' + Number(valorUnit).toFixed(2) + ' = R$ ' + Number(valorTotal).toFixed(2) + ')';
      }
      return nomeFinal || nome || '';
    }).filter(Boolean);
    xDescServ = partes.join(' | ');
  }
  if (!xDescServ && firstProduct.name) {
    xDescServ = String(firstProduct.name);
  }
  if (!xDescServ && move.narration) {
    xDescServ = String(move.narration).substring(0, 2000);
  }
  if (!xDescServ) {
    xDescServ = 'Servico prestado conforme contrato';
  }
  // Adiciona "Termos e condicoes" se houver (do campo name da linha)
  // Mas so se nao for repeticao do que ja tem
  const termosCondicoes = lines.map(l => l.name || '').filter(n => /termos.*cond/i.test(n)).join(' ');
  if (termosCondicoes && !xDescServ.toLowerCase().includes('termos')) {
    xDescServ = xDescServ + ' - ' + termosCondicoes;
  }
  // Remove tags HTML da descricao (narration do Odoo pode conter HTML)
  xDescServ = xDescServ.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (xDescServ.length > 2000) xDescServ = xDescServ.substring(0, 2000);

  console.log('[NFSE-XML] xDescServ=' + xDescServ.substring(0, 100) + (xDescServ.length > 100 ? '...' : ''));

  // --- Valores (TCInfoValores) ---
  // Ordem XSD: vServPrest, [vDescCondIncond], [vDedRed], trib
  // TCVServPrest: [vReceb], vServ
  // TCInfoTributacao: tribMun, [tribFed], totTrib
  // TCTribMunicipal: tribISSQN, [cPaisResult], [tpImunidade], [exigSusp], [BM], tpRetISSQN, [pAliq]
  // TCTribTotal (choice): vTotTrib | pTotTrib | indTotTrib | pTotTribSN
  const vServ = fmtValor(move.amount_untaxed || move.amount_total);
  // tpRetISSQN: 1=Nao Retido, 2=Retido pelo Tomador, 3=Retido pelo Intermediario
  const tpRetISSQN = firstProduct.x_performe_iss_retido === true ? '2' : '1';
  const pTotTribSN = fmtValor(c.p_tot_trib_sn);

  // --- IBS/CBS (NT 004/2025 v2.0 - XSD v1.01 de 09/02/2026) ---
  // DESCOBERTO 03/09/2026: XMLs reais autorizados (Performe+ e Performe+) NAO tem bloco IBSCBS!
  // NT 004/2025 v2.0 SUSPENDEU a obrigatoriedade do IBSCBS em 10/12/2025
  // - Pode omitir o grupo inteiro -> emissao aceita (suspensao ativa)
  // - Se incluir, XSD valida estritamente e SEFIN pode rejeitar por erros sutis
  // Conclusao: por padrao NAO incluir IBSCBS (igual XMLs reais autorizados)
  // Para incluir, setar env var NFSE_INCLUIR_IBSCBS=1 (e ajustar valores no painel admin)
  const incluirIbsCbs = process.env.NFSE_INCLUIR_IBSCBS === '1';
  const ibsCbs = getIbsCbsConfig();
  let ibsCbsXml = '';
  if (incluirIbsCbs && ibsCbs.habilitado) {
    // Mapeia valores antigos do painel admin para o novo formato XSD v1.01:
    // - CINOP (1-2 digitos) -> cIndOp (6 digitos, default 110101 = prestacao presencial)
    // - cClassTrib (1-2 digitos) -> cClassTrib (6 digitos, default 000001)
    // - CST_ibs/CST_cbs (2 digitos) -> CST unico (3 digitos, default 000)
    let cIndOp = String(ibsCbs.cinop || '').replace(/\D/g, '');
    if (cIndOp.length !== 6) cIndOp = '110101'; // default: prestacao de servico presencial
    let cClassTrib = String(ibsCbs.cClassTrib || '').replace(/\D/g, '');
    if (cClassTrib.length !== 6) cClassTrib = '000001'; // default
    let cstIbsCbs = String(ibsCbs.cst_ibs || ibsCbs.cst_cbs || '').replace(/\D/g, '');
    if (cstIbsCbs.length !== 3) cstIbsCbs = '000'; // default: tributacao regular

    // finNFSe: 0=NFS-e regular (unico valor valido no XSD v1.01 atual)
    // indDest: 0=destinatario e o proprio tomador (default para prestacao de servico)
    ibsCbsXml = `
    <IBSCBS>
      <finNFSe>0</finNFSe>
      <cIndOp>${cIndOp}</cIndOp>
      <indDest>0</indDest>
      <valores>
        <trib>
          <gIBSCBS>
            <CST>${cstIbsCbs}</CST>
            <cClassTrib>${cClassTrib}</cClassTrib>
          </gIBSCBS>
        </trib>
      </valores>
    </IBSCBS>`;
    console.log('[NFSE-XML] IBS/CBS INCLUIDO (XSD v1.01): finNFSe=0 cIndOp=' + cIndOp + ' indDest=0 CST=' + cstIbsCbs + ' cClassTrib=' + cClassTrib);
  } else {
    console.log('[NFSE-XML] IBS/CBS NAO incluido (NFSE_INCLUIR_IBSCBS=' + incluirIbsCbs + ', habilitado=' + ibsCbs.habilitado + ') - igual XMLs reais autorizados');
  }

  // --- Monta o XML conforme XSD ---
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DPS versao="${c.versao}" xmlns="${NS}">
  <infDPS Id="${infDpsId}">
    <tpAmb>${c.tp_amb}</tpAmb>
    <dhEmi>${dhEmi}</dhEmi>
    <verAplic>${escXml(c.ver_aplic)}</verAplic>
    <serie>${escXml(serie)}</serie>
    <nDPS>${nDPS}</nDPS>
    <dCompet>${dCompet}</dCompet>
    <tpEmit>1</tpEmit>
    <cLocEmi>${ibge}</cLocEmi>
    <prest>
      <CNPJ>${cnpjPrest}</CNPJ>${imPrestXml}${nomePrestXml}${endPrestXml}${fonePrestXml}${emailPrestXml}
      <regTrib>
        <opSimpNac>${c.op_simp_nac}</opSimpNac>
        <regApTribSN>${c.reg_ap_trib_sn}</regApTribSN>
        <regEspTrib>${c.reg_esp_trib}</regEspTrib>
      </regTrib>
    </prest>
    <toma>
      <${docTomadorTag}>${docTomador}</${docTomadorTag}>
      <xNome>${escXml(nomeTomador)}</xNome>${xmlEndereco(ibgeTomador, cepTomador, logrTomador, nroTomador, bairroTomador)}${foneTomador.length >= 10 ? '\n      <fone>' + foneTomador + '</fone>' : ''}${emailTomador ? '\n      <email>' + escXml(emailTomador) + '</email>' : ''}
    </toma>
    <serv>
      <locPrest>
        <cLocPrestacao>${ibge}</cLocPrestacao>
      </locPrest>
      <cServ>
        <cTribNac>${escXml(cTribNac)}</cTribNac>
        <xDescServ>${escXml(xDescServ)}</xDescServ>
        <cNBS>${escXml(cNBS)}</cNBS>
      </cServ>
    </serv>
    <valores>
      <vServPrest>
        <vServ>${vServ}</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>1</tribISSQN>
          <tpRetISSQN>${tpRetISSQN}</tpRetISSQN>
        </tribMun>
        <totTrib>
          <pTotTribSN>${pTotTribSN}</pTotTribSN>
        </totTrib>
      </trib>
    </valores>${ibsCbsXml}
  </infDPS>
</DPS>`;

  console.log('[NFSE-XML] DPS gerado. infDpsId=' + infDpsId + ' nDPS=' + nDPS + ' vServ=' + vServ);
  return { xml, infDpsId };
}

module.exports = { gerarXmlDPS, NS };
