/**
 * services/nfse-pdf.js — Gerador de PDF DANFSe (modelo DANFSe v2.0)
 * ====================================================================
 * Replica o layout oficial do DANFSe Nacional v2.0, com:
 *   - Badge verde "NFSe" no canto superior esquerdo
 *   - Titulo "DANFSe v2.0" centralizado e sublinhado
 *   - Logo da empresa (Performe+) ao lado do badge
 *   - QR Code da chave de acesso (lado direito)
 *   - Grid com bordas finas cinzas
 *   - Secoes: Identificacao, Prestador, Tomador, Servico, Tributacao, Valores
 *   - Rodape com tributos aproximados (Lei 12.741/2012)
 */

const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
const path = require('path');
const fs = require('fs');
const config = require('../config');

// === Carrega logo como Buffer ===
// Prioridade: 1) Arquivo local (deploy via git), 2) Firebase (persistente), 3) URL env var
let LOGO_BUF = null;
let logoLoaded = false;

async function loadLogoFromFirebase() {
  try {
    // Usa Firestore REST API (sem firebase-admin, sem gRPC, sem erro OpenSSL)
    const fbRest = require('./firebase-rest');
    const doc = await fbRest.getDoc(config.firebase.collection, 'logo');
    if (!doc || !doc.logoBase64) return null;
    return Buffer.from(doc.logoBase64, 'base64');
  } catch (e) {
    return null;
  }
}

async function ensureLogo() {
  if (logoLoaded) return LOGO_BUF;
  logoLoaded = true;

  // 1) Arquivo local (assets/logo-performe.jpg) — vem via git deploy
  try {
    const logoPath = path.join(__dirname, '..', 'assets', 'logo-performe.jpg');
    if (fs.existsSync(logoPath)) {
      LOGO_BUF = fs.readFileSync(logoPath);
      console.log('[NFSE-PDF] Logo carregada do arquivo local: ' + LOGO_BUF.length + ' bytes');
      return LOGO_BUF;
    }
  } catch (e) {
    console.warn('[NFSE-PDF] Erro ao carregar logo local: ' + e.message);
  }

  // 2) Firebase Firestore (persiste entre deploys)
  try {
    const fbLogo = await loadLogoFromFirebase();
    if (fbLogo && fbLogo.length > 100) {
      LOGO_BUF = fbLogo;
      console.log('[NFSE-PDF] Logo carregada do Firebase: ' + LOGO_BUF.length + ' bytes');
      return LOGO_BUF;
    }
  } catch (e) {
    console.warn('[NFSE-PDF] Erro ao carregar logo do Firebase: ' + e.message);
  }

  // 3) URL (variavel de ambiente do Vercel)
  const logoUrl = process.env.PERFORME_LOGO_URL || process.env.ODOO_LOGO_URL || '';
  if (logoUrl) {
    try {
      console.log('[NFSE-PDF] Tentando baixar logo da URL: ' + logoUrl);
      const resp = await fetch(logoUrl, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const arrayBuf = await resp.arrayBuffer();
        LOGO_BUF = Buffer.from(arrayBuf);
        console.log('[NFSE-PDF] Logo baixada da URL: ' + LOGO_BUF.length + ' bytes');
        return LOGO_BUF;
      }
    } catch (e) {
      console.warn('[NFSE-PDF] Erro ao baixar logo da URL: ' + e.message);
    }
  }

  console.warn('[NFSE-PDF] Nenhuma logo encontrada (local, Firebase ou URL).');
  return LOGO_BUF;
}

// === Helpers de formatacao ===
function fmtCnpj(cnpj) {
  const d = (cnpj || '').replace(/[^0-9]/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return cnpj || '';
}
function fmtCep(cep) {
  const d = (cep || '').replace(/[^0-9]/g, '');
  if (d.length === 8) return d.replace(/^(\d{5})(\d{3})$/, '$1-$2');
  return cep || '';
}
function fmtMoeda(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
}
function fmtFone(f) {
  const d = (f || '').replace(/[^0-9]/g, '');
  if (d.length === 11) return '(' + d.substring(0, 2) + ') ' + d.substring(2, 7) + '-' + d.substring(7);
  if (d.length === 10) return '(' + d.substring(0, 2) + ') ' + d.substring(2, 6) + '-' + d.substring(6);
  return f || '';
}
function fmtDataHora(iso) {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yy = dt.getFullYear();
    const hh = String(dt.getHours()).padStart(2, '0');
    const mi = String(dt.getMinutes()).padStart(2, '0');
    const ss = String(dt.getSeconds()).padStart(2, '0');
    return dd + '/' + mm + '/' + yy + ' ' + hh + ':' + mi + ':' + ss;
  } catch (_) { return iso; }
}
function fmtData(iso) {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    return String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0') + '/' + dt.getFullYear();
  } catch (_) { return iso; }
}
function fmtCNAE(c) {
  const d = (c || '').replace(/[^0-9]/g, '');
  if (d.length === 6) return d.substring(0, 2) + '.' + d.substring(2, 4) + '.' + d.substring(4);
  return c || '';
}
function fmtNBS(c) {
  const d = (c || '').replace(/[^0-9]/g, '');
  if (d.length === 9) return d.substring(0, 1) + '.' + d.substring(1, 5) + '.' + d.substring(5, 7) + '.' + d.substring(7);
  return c || '';
}
function fmtIBGE(ibge) {
  const d = (ibge || '').replace(/[^0-9]/g, '');
  if (d.length === 7) return d.substring(0, 2) + '.' + d.substring(2);
  return ibge || '';
}

function xmlTag(xml, tag) {
  const re = new RegExp('<(?:\\w+:)?' + tag + '[^>]*>([\\s\\S]*?)<\/(?:\\w+:)?' + tag + '>', 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}
function xmlAttr(xml, tag, attr) {
  const re = new RegExp('<(?:\\w+:)?' + tag + '\\s[^>]*' + attr + '="([^"]*)"', 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}
function generateQR(text) {
  return new Promise((resolve, reject) => {
    try {
      const buf = bwipjs.toBuffer({
        bcid: 'qrcode', text: text || ' ', scale: 3, height: 10, includetext: false,
      });
      resolve(buf);
    } catch (e) { reject(e); }
  });
}

// === Layout constants (A4) ===
const PW = 595.28;
const PH = 841.89;
const M = 10; // margem
const LW = 0.5;
const GRAY_BG = '#F0F0F0';
const BORDER = '#999999';
const BLACK = '#000000';
const GREEN_DARK = '#006633';
const WHITE = '#FFFFFF';
const PAD = 4;

// === Drawing helpers ===
function hline(doc, y, x0, x1, color, w) {
  doc.moveTo(x0, y).lineTo(x1, y).lineWidth(w || LW).strokeColor(color || BORDER).stroke();
}
function vline(doc, x, y0, y1, color, w) {
  doc.moveTo(x, y0).lineTo(x, y1).lineWidth(w || LW).strokeColor(color || BORDER).stroke();
}
function fillRect(doc, x, y, w, h, color) {
  doc.save().rect(x, y, w, h).fill(color || GRAY_BG).restore();
}
function txt(doc, x, y, text, opts) {
  const o = { ...opts };
  doc.text(text, x, y, o);
}
function labelRow(doc, y, labels, widths, startX) {
  // Desenha labels em negrito numa linha
  doc.font('Helvetica-Bold').fontSize(6).fillColor(BLACK);
  let x = startX || M;
  for (let i = 0; i < labels.length; i++) {
    doc.text(labels[i], x + PAD, y + 2, { width: widths[i] - PAD * 2, lineBreak: false });
    x += widths[i];
  }
}
function valueRow(doc, y, values, widths, startX, opts) {
  doc.font('Helvetica').fontSize(7).fillColor(BLACK);
  let x = startX || M;
  for (let i = 0; i < values.length; i++) {
    const o = { width: widths[i] - PAD * 2, lineBreak: false };
    if (opts && opts.aligns) o.align = opts.aligns[i];
    doc.text(values[i] || '-', x + PAD, y + 2, o);
    x += widths[i];
  }
}
function sectionHeader(doc, y, text, totalW, startX) {
  const sx = startX || M;
  fillRect(doc, sx, y, totalW, 16, GRAY_BG);
  hline(doc, y, sx, sx + totalW, BORDER, 0.7);
  doc.font('Helvetica-Bold').fontSize(7).fillColor(BLACK);
  doc.text(text, sx + PAD, y + 5, { width: totalW - PAD * 2, lineBreak: false });
  return y + 16;
}

// === Gerador principal ===
async function gerarPdfDanfse(nfseXml) {
  return new Promise(async (resolve, reject) => {
    let doc;
    try {
      doc = new PDFDocument({ size: [PW, PH], margin: 0, bufferPages: true });
    } catch (e) {
      console.error('[NFSE-PDF] Erro ao criar PDFDocument:', e.message);
      return reject(e);
    }
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end', () => {
      console.log('[NFSE-PDF] PDF gerado com sucesso: ' + bufs.reduce((a, b) => a + b.length, 0) + ' bytes');
      resolve(Buffer.concat(bufs));
    });
    doc.on('error', (e) => {
      console.error('[NFSE-PDF] Erro no stream do PDF:', e.message);
      reject(e);
    });

    try {
      const CW = PW - M * 2; // conteudo width

      // --- Parseia dados do XML de retorno da SEFIN ---
      // Extrai DPS primeiro (precisa de nDPS para o cabecalho)
      const dpsMatch = nfseXml.match(/<DPS[^>]*>[\s\S]*?<\/DPS>/i);
      const dpsXml = dpsMatch ? dpsMatch[0] : '';
      console.log('[NFSE-PDF] XML recebido: ' + nfseXml.length + ' bytes | DPS extraida: ' + (dpsXml ? 'sim' : 'nao'));
    const nDPS = xmlTag(dpsXml, 'nDPS');
    // Extrai nNFSe do XML de retorno da SEFIN
    const nNFSeMatch = nfseXml.match(/<nNFSe>(\d+)<\/nNFSe>/);
    const nNFSe = nNFSeMatch ? nNFSeMatch[1] : '';

    const Id = xmlAttr(nfseXml, 'infNFSe', 'Id') || '';
    const chaveAcesso = Id.replace('NFS', '');
    // No DANFSe, mostra nDPS como numero principal (controlado pelo emitente)
    // e nNFSe como referencia governamental
    const numeroPrincipal = nDPS || nNFSe || '-';
    const numeroGov = nNFSe !== '' && nNFSe !== nDPS ? nNFSe : '';
    const dhProc = xmlTag(nfseXml, 'dhProc');
    const xLocEmi = xmlTag(nfseXml, 'xLocEmi') || '';
    const xLocPrestacao = xmlTag(nfseXml, 'xLocPrestacao') || '';
    const xTribNac = xmlTag(nfseXml, 'xTribNac') || '';
    const verAplic = xmlTag(nfseXml, 'verAplic') || '';
    const ambGer = xmlTag(nfseXml, 'ambGer') || '2';
    const vLiq = xmlTag(nfseXml, 'vLiq') || '0';

    // Emitente
    const emitMatch = nfseXml.match(/<emit>[\s\S]*?<\/emit>/i);
    const emitXml = emitMatch ? emitMatch[0] : '';
    const emitCnpj = xmlTag(emitXml, 'CNPJ');
    const emitNome = xmlTag(emitXml, 'xNome');
    const emitLgr = xmlTag(emitXml, 'xLgr');
    const emitNro = xmlTag(emitXml, 'nro');
    const emitBairro = xmlTag(emitXml, 'xBairro');
    const emitCep = xmlTag(emitXml, 'CEP');
    const emitUF = xmlTag(emitXml, 'UF');
    const emitEmail = xmlTag(emitXml, 'email');
    const emitFone = xmlTag(emitXml, 'fone') || '';
    const emitIM = xmlTag(emitXml, 'IM') || '';

    const enderNacMatch = emitXml.match(/<enderNac>[\s\S]*?<\/enderNac>/i);
    const enderNacXml = enderNacMatch ? enderNacMatch[0] : '';
    const emitCMun = xmlTag(enderNacXml, 'cMun');

    // DPS (dpsXml e nDPS ja extraidos acima)
    const dhEmi = xmlTag(dpsXml, 'dhEmi');
    const dCompet = xmlTag(dpsXml, 'dCompet');
    const serie = xmlTag(dpsXml, 'serie');
    const opSimpNac = xmlTag(dpsXml, 'opSimpNac');
    const regApTribSN = xmlTag(dpsXml, 'regApTribSN');

    // Tomador
    const tomaMatch = nfseXml.match(/<toma>[\s\S]*?<\/toma>/i);
    const tomaXml = tomaMatch ? tomaMatch[0] : '';
    const tomaCnpj = xmlTag(tomaXml, 'CNPJ') || xmlTag(tomaXml, 'CPF');
    const tomaNome = xmlTag(tomaXml, 'xNome');
    const tomaLgr = xmlTag(tomaXml, 'xLgr');
    const tomaNro = xmlTag(tomaXml, 'nro');
    const tomaBairro = xmlTag(tomaXml, 'xBairro');
    const tomaCep = xmlTag(tomaXml, 'CEP');
    const tomaFone = xmlTag(tomaXml, 'fone');
    const tomaEmail = xmlTag(tomaXml, 'email');
    const tomaCmun = xmlTag(tomaXml, 'cMun');

    // Servico
    const cTribNac = xmlTag(dpsXml, 'cTribNac');
    const xDescServ = xmlTag(dpsXml, 'xDescServ');
    const cNBS = xmlTag(dpsXml, 'cNBS');
    const cLocPrestacao = xmlTag(dpsXml, 'cLocPrestacao');

    // Valores
    const vServ = xmlTag(dpsXml, 'vServ') || '0';
    const vDed = xmlTag(dpsXml, 'vDed') || '0';
    const vDescIncond = xmlTag(dpsXml, 'vDescIncond') || '0';
    const vDescCond = xmlTag(dpsXml, 'vDescCond') || '0';
    const vPIS = xmlTag(dpsXml, 'vPIS') || '0';
    const vCOFINS = xmlTag(dpsXml, 'vCOFINS') || '0';
    const vINSS = xmlTag(dpsXml, 'vINSS') || '0';
    const vIR = xmlTag(dpsXml, 'vIR') || '0';
    const vCSLL = xmlTag(dpsXml, 'vCSLL') || '0';
    const tribISSQN = xmlTag(dpsXml, 'tribISSQN');
    const tpRetISSQN = xmlTag(dpsXml, 'tpRetISSQN');
    const vBCISSQN = xmlTag(dpsXml, 'vBCISSQN') || vServ;
    const pAliqISSQN = xmlTag(dpsXml, 'pAliq');
    const vISSQN = xmlTag(dpsXml, 'vISSQN') || '0';
    const pTotTribSN = xmlTag(dpsXml, 'pTotTribSN') || '0';

    // === Borda da pagina ===
    console.log('[NFSE-PDF] Iniciando cabecalho...');
    doc.rect(M, M, CW, PH - M * 2).lineWidth(1).strokeColor(BLACK).stroke();

    // ==============================================
    // CABECALHO (y=10 a y=48)
    // ==============================================
    let y = M;
    const headerH = 42;

    // Logo da empresa (Performe+) — NO LUGAR do badge verde (canto esquerdo, grande)
    const logoBuf = await ensureLogo();
    if (logoBuf) {
      try {
        doc.image(logoBuf, M + 2, y + 2, { height: 36 });
      } catch (_) {
        doc.font('Helvetica-Bold').fontSize(14).fillColor(GREEN_DARK);
        doc.text('PERFORME+', M + 4, y + 10);
      }
    } else {
      // Fallback: badge verde "NFSe" se nao tiver logo
      fillRect(doc, M + 2, y + 2, 52, 22, GREEN_DARK);
      doc.font('Helvetica-Bold').fontSize(14).fillColor(WHITE);
      doc.text('NFSe', M + 6, y + 6, { width: 44, align: 'center' });
    }

    // "Nota Fiscal de Servicos Eletronica" ao lado da logo
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BLACK);
    doc.text('Nota Fiscal de Servi\u00e7os Eletr\u00f4nica', M + 58, y + 5, { width: 200, lineBreak: false });

    // Titulo central: DANFSe v2.0 (sublinhado)
    doc.font('Helvetica-Bold').fontSize(12).fillColor(BLACK);
    const titleX = M + CW / 2 - 80;
    doc.text('DANFSe v2.0', titleX, y + 4, { width: 160, align: 'center' });
    // Sublinhado
    const titleW = doc.widthOfString('DANFSe v2.0');
    const titleMid = titleX + 80;
    hline(doc, y + 17, titleMid - titleW / 2 - 2, titleMid + titleW / 2 + 2, BLACK, 1);
    // Subtitulo
    doc.font('Helvetica-Bold').fontSize(7).fillColor(BLACK);
    doc.text('Documento Auxiliar da NFS-e', titleX, y + 20, { width: 160, align: 'center' });

    // Info do municipio (canto superior direito)
    doc.font('Helvetica').fontSize(7).fillColor(BLACK);
    const rightInfoX = M + CW - 145;
    doc.text('Munic\u00edpio: ' + xLocEmi + ' - ' + (emitUF || ''), rightInfoX, y + 4, { width: 140, align: 'right' });
    doc.font('Helvetica').fontSize(6);
    const ambLabel = ambGer === '1' ? 'Producao' : 'Homologacao';
    doc.text('Ambiente: ' + ambLabel, rightInfoX, y + 13, { width: 140, align: 'right' });
    doc.text('Versao: ' + (verAplic || '1.01'), rightInfoX, y + 20, { width: 140, align: 'right' });

    // Linha divisoria abaixo do cabecalho
    y = M + headerH;
    hline(doc, y, M, M + CW, BLACK, 1);
    y += 2;

    // ==============================================
    // QR CODE (canto direito, ao lado da chave de acesso)
    // ==============================================
    console.log('[NFSE-PDF] Cabecalho OK. Gerando QR Code...');
    const qrX = M + CW - 100;
    const qrY = y + 2;
    try {
      const qrBuf = await generateQR(chaveAcesso);
      doc.image(qrBuf, qrX, qrY, { width: 50, height: 50 });
    } catch (_) {}
    // Texto do QR
    doc.font('Helvetica').fontSize(5).fillColor('#555555');
    doc.text('A autenticidade desta NFS-e pode ser', qrX - 40, qrY + 52, { width: 135, align: 'center' });
    doc.text('verificada pela leitura do QR Code ou', qrX - 40, qrY + 59, { width: 135, align: 'center' });
    doc.text('pela chave de acesso no portal nacional.', qrX - 40, qrY + 66, { width: 135, align: 'center' });

    // ==============================================
    // DADOS DA NFS-e (lado esquerdo do QR)
    // ==============================================
    const dataW = CW - 115;

    // Chave de acesso (full width)
    y = sectionHeader(doc, y, 'CHAVE DE ACESSO DA NFS-e', dataW);
    hline(doc, y, M, M + dataW, BORDER);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BLACK);
    doc.text(chaveAcesso, M + PAD, y + 2, { width: dataW - PAD * 2, lineBreak: false, characterSpacing: 0.5 });
    y += 14;

    // Numero da NFS-e | Data/Hora Emissao
    const halfW = dataW / 2;
    fillRect(doc, M, y, halfW, 11, GRAY_BG);
    fillRect(doc, M + halfW, y, halfW, 11, GRAY_BG);
    hline(doc, y, M, M + dataW, BORDER);
    vline(doc, M + halfW, y, y + 11, BORDER);
    doc.font('Helvetica-Bold').fontSize(6).fillColor(BLACK);
    doc.text('NUMERO DA NFS-e', M + PAD, y + 3, { width: halfW - PAD * 2, lineBreak: false });
    doc.text('DATA E HORA DA EMISSAO DA NFS-e', M + halfW + PAD, y + 3, { width: halfW - PAD * 2, lineBreak: false });
    y += 11;
    hline(doc, y, M, M + dataW, BORDER);
    vline(doc, M + halfW, y, y + 13, BORDER);
    doc.font('Helvetica').fontSize(7).fillColor(BLACK);
    doc.text(numeroPrincipal + (numeroGov ? ' (NFS-e Gov: ' + numeroGov + ')' : ''), M + PAD, y + 3, { width: halfW - PAD * 2, lineBreak: false });
    doc.text(fmtDataHora(dhProc), M + halfW + PAD, y + 3, { width: halfW - PAD * 2, lineBreak: false });
    y += 13;

    // Numero DPS | Serie DPS | Data/Hora Emissao DPS
    const thirdW = dataW / 3;
    fillRect(doc, M, y, thirdW, 11, GRAY_BG);
    fillRect(doc, M + thirdW, y, thirdW, 11, GRAY_BG);
    fillRect(doc, M + thirdW * 2, y, thirdW, 11, GRAY_BG);
    hline(doc, y, M, M + dataW, BORDER);
    vline(doc, M + thirdW, y, y + 11, BORDER);
    vline(doc, M + thirdW * 2, y, y + 11, BORDER);
    doc.font('Helvetica-Bold').fontSize(6).fillColor(BLACK);
    doc.text('NUMERO DA DPS', M + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    doc.text('SERIE DA DPS', M + thirdW + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    doc.text('DATA/HORA EMISSAO DPS', M + thirdW * 2 + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    y += 11;
    hline(doc, y, M, M + dataW, BORDER);
    vline(doc, M + thirdW, y, y + 13, BORDER);
    vline(doc, M + thirdW * 2, y, y + 13, BORDER);
    doc.font('Helvetica').fontSize(7).fillColor(BLACK);
    doc.text(nDPS, M + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    doc.text(serie, M + thirdW + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    doc.text(fmtDataHora(dhEmi), M + thirdW * 2 + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    y += 13;

    // Competencia | Situacao | Finalidade
    fillRect(doc, M, y, thirdW, 11, GRAY_BG);
    fillRect(doc, M + thirdW, y, thirdW, 11, GRAY_BG);
    fillRect(doc, M + thirdW * 2, y, thirdW, 11, GRAY_BG);
    hline(doc, y, M, M + dataW, BORDER);
    vline(doc, M + thirdW, y, y + 11, BORDER);
    vline(doc, M + thirdW * 2, y, y + 11, BORDER);
    doc.font('Helvetica-Bold').fontSize(6).fillColor(BLACK);
    doc.text('COMPETENCIA', M + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    doc.text('SITUACAO DA NFS-e', M + thirdW + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    doc.text('FINALIDADE', M + thirdW * 2 + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    y += 11;
    hline(doc, y, M, M + dataW, BORDER);
    vline(doc, M + thirdW, y, y + 13, BORDER);
    vline(doc, M + thirdW * 2, y, y + 13, BORDER);
    doc.font('Helvetica').fontSize(7).fillColor(BLACK);
    doc.text(fmtData(dCompet), M + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    doc.text('NFS-e Gerada', M + thirdW + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    doc.text('-', M + thirdW * 2 + PAD, y + 3, { width: thirdW - PAD * 2, lineBreak: false });
    y += 13;

    // Fecha area de dados (alinha com o QR code)
    y = Math.max(y, qrY + 72);

    // ==============================================
    // PRESTADOR / FORNECEDOR
    // ==============================================
    hline(doc, y, M, M + CW, BLACK, 0.7);
    y = sectionHeader(doc, y, 'PRESTADOR / FORNECEDOR', CW);

    // Labels
    const c1 = CW * 0.30;
    const c2 = CW * 0.25;
    const c3 = CW * 0.25;
    const c4 = CW * 0.20;
    const ws4 = [c1, c2, c3, c4];

    fillRect(doc, M, y, c1, 11, GRAY_BG); fillRect(doc, M + c1, y, c2, 11, GRAY_BG);
    fillRect(doc, M + c1 + c2, y, c3, 11, GRAY_BG); fillRect(doc, M + c1 + c2 + c3, y, c4, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + c1, y, y + 11, BORDER); vline(doc, M + c1 + c2, y, y + 11, BORDER); vline(doc, M + c1 + c2 + c3, y, y + 11, BORDER);
    labelRow(doc, y, ['Nome / Nome Empresarial', 'CNPJ / CPF / NIF', 'Indicador Municipal (IM)', 'Telefone'], ws4);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + c1, y, y + 14, BORDER); vline(doc, M + c1 + c2, y, y + 14, BORDER); vline(doc, M + c1 + c2 + c3, y, y + 14, BORDER);
    valueRow(doc, y, [emitNome || '', fmtCnpj(emitCnpj), emitIM || '-', fmtFone(emitFone)], ws4);
    y += 14;

    // Endereco | Municipio | Email | CEP
    fillRect(doc, M, y, c1, 11, GRAY_BG); fillRect(doc, M + c1, y, c2, 11, GRAY_BG);
    fillRect(doc, M + c1 + c2, y, c3, 11, GRAY_BG); fillRect(doc, M + c1 + c2 + c3, y, c4, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + c1, y, y + 11, BORDER); vline(doc, M + c1 + c2, y, y + 11, BORDER); vline(doc, M + c1 + c2 + c3, y, y + 11, BORDER);
    labelRow(doc, y, ['Endere\u00e7o', 'Munic\u00edpio / UF', 'E-mail', 'CEP / IBGE'], ws4);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + c1, y, y + 14, BORDER); vline(doc, M + c1 + c2, y, y + 14, BORDER); vline(doc, M + c1 + c2 + c3, y, y + 14, BORDER);
    const endPrest = [emitLgr, emitNro, emitBairro].filter(Boolean).join(', ');
    valueRow(doc, y, [endPrest, xLocEmi + ' / ' + (emitUF || ''), emitEmail || '', fmtCep(emitCep) + ' / ' + fmtIBGE(emitCMun)], ws4);
    y += 14;

    // Simples Nacional | Regime Tributacao
    const halfCW = CW / 2;
    fillRect(doc, M, y, halfCW, 11, GRAY_BG); fillRect(doc, M + halfCW, y, halfCW, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + halfCW, y, y + 11, BORDER);
    doc.font('Helvetica-Bold').fontSize(6).fillColor(BLACK);
    doc.text('Simples Nacional na Data de Compet\u00eancia', M + PAD, y + 3, { width: halfCW - PAD * 2, lineBreak: false });
    doc.text('Regime de Apura\u00e7\u00e3o Tribut\u00e1ria pelo SN', M + halfCW + PAD, y + 3, { width: halfCW - PAD * 2, lineBreak: false });
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + halfCW, y, y + 13, BORDER);
    const snLabel = opSimpNac === '1' ? 'N\u00e3o Optante' : opSimpNac === '2' ? 'Optante - MEI' : opSimpNac === '3' ? 'Optante - ME ou EPP' : '-';
    const regLabel = regApTribSN === '1' ? 'Regime de apura\u00e7\u00e3o dos tributos federais e municipal pelo SN' : regApTribSN === '2' ? 'Exclusivamente tributos municipais pelo SN' : '-';
    doc.font('Helvetica').fontSize(7).fillColor(BLACK);
    doc.text(snLabel, M + PAD, y + 3, { width: halfCW - PAD * 2, lineBreak: false });
    doc.text(regLabel, M + halfCW + PAD, y + 3, { width: halfCW - PAD * 2, lineBreak: false });
    y += 13;

    // ==============================================
    // TOMADOR / ADQUIRENTE
    // ==============================================
    hline(doc, y, M, M + CW, BLACK, 0.7);
    y = sectionHeader(doc, y, 'TOMADOR / ADQUIRENTE', CW);

    fillRect(doc, M, y, c1, 11, GRAY_BG); fillRect(doc, M + c1, y, c2, 11, GRAY_BG);
    fillRect(doc, M + c1 + c2, y, c3, 11, GRAY_BG); fillRect(doc, M + c1 + c2 + c3, y, c4, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + c1, y, y + 11, BORDER); vline(doc, M + c1 + c2, y, y + 11, BORDER); vline(doc, M + c1 + c2 + c3, y, y + 11, BORDER);
    labelRow(doc, y, ['Nome / Nome Empresarial', 'CNPJ / CPF / NIF', 'Indicador Municipal (IM)', 'Telefone'], ws4);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + c1, y, y + 14, BORDER); vline(doc, M + c1 + c2, y, y + 14, BORDER); vline(doc, M + c1 + c2 + c3, y, y + 14, BORDER);
    valueRow(doc, y, [tomaNome || '', fmtCnpj(tomaCnpj), '-', fmtFone(tomaFone)], ws4);
    y += 14;

    fillRect(doc, M, y, c1, 11, GRAY_BG); fillRect(doc, M + c1, y, c2, 11, GRAY_BG);
    fillRect(doc, M + c1 + c2, y, c3, 11, GRAY_BG); fillRect(doc, M + c1 + c2 + c3, y, c4, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + c1, y, y + 11, BORDER); vline(doc, M + c1 + c2, y, y + 11, BORDER); vline(doc, M + c1 + c2 + c3, y, y + 11, BORDER);
    labelRow(doc, y, ['Endere\u00e7o', 'Munic\u00edpio / UF', 'E-mail', 'CEP / IBGE'], ws4);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + c1, y, y + 14, BORDER); vline(doc, M + c1 + c2, y, y + 14, BORDER); vline(doc, M + c1 + c2 + c3, y, y + 14, BORDER);
    const endToma = [tomaLgr, tomaNro, tomaBairro].filter(Boolean).join(', ');
    valueRow(doc, y, [endToma, xLocPrestacao + ' / ' + (emitUF || ''), tomaEmail || '', fmtCep(tomaCep) + ' / ' + fmtIBGE(tomaCmun)], ws4);
    y += 14;

    // ==============================================
    // DESTINATARIO / INTERMEDIARIO
    // ==============================================
    hline(doc, y, M, M + CW, BLACK, 0.7);
    doc.font('Helvetica').fontSize(7).fillColor(BLACK);
    doc.text('DESTINAT\u00c1RIO DA OPERA\u00c7\u00c3O N\u00c3O IDENTIFICADO NA NFS-e', M + PAD, y + 3, { width: CW - PAD * 2, lineBreak: false });
    y += 11;
    doc.text('INTERMEDI\u00c1RIO DA OPERA\u00c7\u00c3O N\u00c3O IDENTIFICADO NA NFS-e', M + PAD, y, { width: CW - PAD * 2, lineBreak: false });
    y += 12;

    // ==============================================
    // SERVICO PRESTADO
    // ==============================================
    hline(doc, y, M, M + CW, BLACK, 0.7);
    y = sectionHeader(doc, y, 'SERVI\u00c7O PRESTADO', CW);

    // Codigo tributacao | NBS | Local prestacao
    const svc1 = CW * 0.30;
    const svc2 = CW * 0.20;
    const svc3 = CW * 0.50;
    const wsSvc = [svc1, svc2, svc3];

    fillRect(doc, M, y, svc1, 11, GRAY_BG); fillRect(doc, M + svc1, y, svc2, 11, GRAY_BG);
    fillRect(doc, M + svc1 + svc2, y, svc3, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + svc1, y, y + 11, BORDER); vline(doc, M + svc1 + svc2, y, y + 11, BORDER);
    labelRow(doc, y, ['C\u00f3d. Tributa\u00e7\u00e3o Nacional', 'C\u00f3d. NBS', 'Local da Presta\u00e7\u00e3o / UF / Pa\u00eds'], wsSvc);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + svc1, y, y + 14, BORDER); vline(doc, M + svc1 + svc2, y, y + 14, BORDER);
    valueRow(doc, y, [fmtCNAE(cTribNac), fmtNBS(cNBS), xLocPrestacao + ' / ' + (emitUF || '') + ' / -'], wsSvc);
    y += 14;

    // Descricao do servico
    hline(doc, y, M, M + CW, BORDER);
    doc.font('Helvetica-Bold').fontSize(6).fillColor(BLACK);
    doc.text('Descri\u00e7\u00e3o do Servi\u00e7o', M + PAD, y + 2, { width: CW - PAD * 2, lineBreak: false });
    y += 10;
    hline(doc, y, M, M + CW, BORDER);
    doc.font('Helvetica').fontSize(7).fillColor(BLACK);
    const descH = doc.heightOfString(xDescServ || '-', { width: CW - PAD * 2 });
    doc.text(xDescServ || '-', M + PAD, y + 2, { width: CW - PAD * 2 });
    y += Math.max(descH, 14) + 6;

    // ==============================================
    // TRIBUTACAO MUNICIPAL (ISSQN)
    // ==============================================
    hline(doc, y, M, M + CW, BLACK, 0.7);
    y = sectionHeader(doc, y, 'TRIBUTA\u00c7\u00c3O MUNICIPAL (ISSQN)', CW);

    const iss1 = CW * 0.22;
    const iss2 = CW * 0.28;
    const iss3 = CW * 0.25;
    const iss4 = CW * 0.25;
    const wsIss = [iss1, iss2, iss3, iss4];

    fillRect(doc, M, y, iss1, 11, GRAY_BG); fillRect(doc, M + iss1, y, iss2, 11, GRAY_BG);
    fillRect(doc, M + iss1 + iss2, y, iss3, 11, GRAY_BG); fillRect(doc, M + iss1 + iss2 + iss3, y, iss4, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + iss1, y, y + 11, BORDER); vline(doc, M + iss1 + iss2, y, y + 11, BORDER); vline(doc, M + iss1 + iss2 + iss3, y, y + 11, BORDER);
    labelRow(doc, y, ['Tipo Tributa\u00e7\u00e3o ISSQN', 'Munic\u00edpio Incid\u00eancia / UF', 'BC ISSQN', 'Al\u00edquota Aplicada'], wsIss);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + iss1, y, y + 14, BORDER); vline(doc, M + iss1 + iss2, y, y + 14, BORDER); vline(doc, M + iss1 + iss2 + iss3, y, y + 14, BORDER);
    const tpIssLabel = tribISSQN === '1' ? 'Opera\u00e7\u00e3o Tribut\u00e1vel' : tribISSQN === '2' ? 'Opera\u00e7\u00e3o N\u00e3o Tribut\u00e1vel' : '-';
    const aliqStr = pAliqISSQN ? (Number(pAliqISSQN) * 100).toFixed(2) + '%' : '-';
    valueRow(doc, y, [tpIssLabel, xLocEmi + ' / ' + (emitUF || ''), fmtMoeda(vBCISSQN), aliqStr], wsIss);
    y += 14;

    fillRect(doc, M, y, iss1, 11, GRAY_BG); fillRect(doc, M + iss1, y, iss2, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + iss1, y, y + 11, BORDER); vline(doc, M + iss1 + iss2, y, y + 11, BORDER);
    labelRow(doc, y, ['Reten\u00e7\u00e3o do ISSQN', 'ISSQN Apurado', '', ''], [iss1, iss2, iss3, iss4]);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + iss1, y, y + 14, BORDER); vline(doc, M + iss1 + iss2, y, y + 14, BORDER);
    const retISSLabel = tpRetISSQN === '1' ? 'N\u00e3o Retido' : tpRetISSQN === '2' ? 'Retido pelo Tomador' : tpRetISSQN === '3' ? 'Retido pelo Intermedi\u00e1rio' : '-';
    valueRow(doc, y, [retISSLabel, fmtMoeda(vISSQN), '', ''], [iss1, iss2, iss3, iss4]);
    y += 14;

    // ==============================================
    // TRIBUTACAO FEDERAL
    // ==============================================
    hline(doc, y, M, M + CW, BLACK, 0.7);
    y = sectionHeader(doc, y, 'TRIBUTA\u00c7\u00c3O FEDERAL (EXCETO CBS)', CW);

    const fed1 = CW * 0.20;
    const fed2 = CW * 0.20;
    const fed3 = CW * 0.30;
    const fed4 = CW * 0.30;
    const wsFed = [fed1, fed2, fed3, fed4];

    fillRect(doc, M, y, fed1, 11, GRAY_BG); fillRect(doc, M + fed1, y, fed2, 11, GRAY_BG);
    fillRect(doc, M + fed1 + fed2, y, fed3, 11, GRAY_BG); fillRect(doc, M + fed1 + fed2 + fed3, y, fed4, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + fed1, y, y + 11, BORDER); vline(doc, M + fed1 + fed2, y, y + 11, BORDER); vline(doc, M + fed1 + fed2 + fed3, y, y + 11, BORDER);
    labelRow(doc, y, ['PIS', 'COFINS', 'IRRF', 'CSLL'], wsFed);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + fed1, y, y + 14, BORDER); vline(doc, M + fed1 + fed2, y, y + 14, BORDER); vline(doc, M + fed1 + fed2 + fed3, y, y + 14, BORDER);
    valueRow(doc, y, [fmtMoeda(vPIS), fmtMoeda(vCOFINS), fmtMoeda(vIR), fmtMoeda(vCSLL)], wsFed);
    y += 14;

    fillRect(doc, M, y, fed1, 11, GRAY_BG); fillRect(doc, M + fed1, y, fed2, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + fed1, y, y + 11, BORDER); vline(doc, M + fed1 + fed2, y, y + 11, BORDER);
    labelRow(doc, y, ['Contrib. Previdenci\u00e1ria - Retida', 'Descri\u00e7\u00e3o Contrib. Sociais', '', ''], [fed1, fed2, fed3, fed4]);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + fed1, y, y + 14, BORDER); vline(doc, M + fed1 + fed2, y, y + 14, BORDER);
    valueRow(doc, y, [fmtMoeda(vINSS), '0 - PIS/COFINS/CSLL N\u00e3o Retidos', '', ''], [fed1, fed2, fed3, fed4]);
    y += 14;

    // ==============================================
    // TRIBUTACAO IBS/CBS
    // ==============================================
    hline(doc, y, M, M + CW, BLACK, 0.7);
    y = sectionHeader(doc, y, 'TRIBUTA\u00c7\u00c3O IBS/CBS', CW);

    const ibs1 = CW * 0.25;
    const ibs2 = CW * 0.25;
    const ibs3 = CW * 0.25;
    const ibs4 = CW * 0.25;
    const wsIbs = [ibs1, ibs2, ibs3, ibs4];

    fillRect(doc, M, y, ibs1, 11, GRAY_BG); fillRect(doc, M + ibs1, y, ibs2, 11, GRAY_BG);
    fillRect(doc, M + ibs1 + ibs2, y, ibs3, 11, GRAY_BG); fillRect(doc, M + ibs1 + ibs2 + ibs3, y, ibs4, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + ibs1, y, y + 11, BORDER); vline(doc, M + ibs1 + ibs2, y, y + 11, BORDER); vline(doc, M + ibs1 + ibs2 + ibs3, y, y + 11, BORDER);
    labelRow(doc, y, ['CST / cClassTrib', 'Indicador / C\u00f3d. IBGE / Munic\u00edpio / UF', 'Excl. e Red. BC', 'BC Ap\u00f3s Excl./Red.'], wsIbs);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + ibs1, y, y + 14, BORDER); vline(doc, M + ibs1 + ibs2, y, y + 14, BORDER); vline(doc, M + ibs1 + ibs2 + ibs3, y, y + 14, BORDER);
    valueRow(doc, y, ['- / -', '- / - / - / -', fmtMoeda('0'), '-'], wsIbs);
    y += 14;

    fillRect(doc, M, y, ibs1, 11, GRAY_BG); fillRect(doc, M + ibs1, y, ibs2, 11, GRAY_BG);
    fillRect(doc, M + ibs1 + ibs2, y, ibs3, 11, GRAY_BG); fillRect(doc, M + ibs1 + ibs2 + ibs3, y, ibs4, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + ibs1, y, y + 11, BORDER); vline(doc, M + ibs1 + ibs2, y, y + 11, BORDER); vline(doc, M + ibs1 + ibs2 + ibs3, y, y + 11, BORDER);
    labelRow(doc, y, ['Red. Al\u00edq. IBS / CBS', 'Al\u00edquota IBS UF / Mun', 'Al\u00edquota CBS', 'Val. Apurado IBS / CBS'], wsIbs);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + ibs1, y, y + 14, BORDER); vline(doc, M + ibs1 + ibs2, y, y + 14, BORDER); vline(doc, M + ibs1 + ibs2 + ibs3, y, y + 14, BORDER);
    valueRow(doc, y, ['- / -', '- / -', '-', '- / -'], wsIbs);
    y += 14;

    // ==============================================
    // VALORES
    // ==============================================
    hline(doc, y, M, M + CW, BLACK, 0.7);
    y = sectionHeader(doc, y, 'VALOR TOTAL DA NFS-e', CW);

    const val1 = CW * 0.25;
    const val2 = CW * 0.25;
    const val3 = CW * 0.25;
    const val4 = CW * 0.25;
    const wsVal = [val1, val2, val3, val4];

    fillRect(doc, M, y, val1, 11, GRAY_BG); fillRect(doc, M + val1, y, val2, 11, GRAY_BG);
    fillRect(doc, M + val1 + val2, y, val3, 11, GRAY_BG); fillRect(doc, M + val1 + val2 + val3, y, val4, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + val1, y, y + 11, BORDER); vline(doc, M + val1 + val2, y, y + 11, BORDER); vline(doc, M + val1 + val2 + val3, y, y + 11, BORDER);
    labelRow(doc, y, ['Valor Servi\u00e7os', 'Dedu\u00e7\u00f5es Permitidas', 'Desconto Incondicionado', 'Desconto Condicionado'], wsVal);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + val1, y, y + 14, BORDER); vline(doc, M + val1 + val2, y, y + 14, BORDER); vline(doc, M + val1 + val2 + val3, y, y + 14, BORDER);
    valueRow(doc, y, [fmtMoeda(vServ), fmtMoeda(vDed), fmtMoeda(vDescIncond), fmtMoeda(vDescCond)], wsVal);
    y += 14;

    fillRect(doc, M, y, val1, 11, GRAY_BG); fillRect(doc, M + val1, y, val2, 11, GRAY_BG);
    fillRect(doc, M + val1 + val2, y, val3, 11, GRAY_BG); fillRect(doc, M + val1 + val2 + val3, y, val4, 11, GRAY_BG);
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + val1, y, y + 11, BORDER); vline(doc, M + val1 + val2, y, y + 11, BORDER); vline(doc, M + val1 + val2 + val3, y, y + 11, BORDER);
    labelRow(doc, y, ['Total Reten\u00e7\u00f5es', 'VALOR L\u00cdQUIDO DA NFS-e', 'Total IBS/CBS', 'VL L\u00cdQUIDO + IBS/CBS'], wsVal);
    y += 11;
    hline(doc, y, M, M + CW, BORDER);
    vline(doc, M + val1, y, y + 16, BORDER); vline(doc, M + val1 + val2, y, y + 16, BORDER); vline(doc, M + val1 + val2 + val3, y, y + 16, BORDER);
    // Valor liquido em destaque
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BLACK);
    doc.text(fmtMoeda(vLiq), M + val1 + val2 + PAD, y + 4, { width: val2 - PAD * 2, lineBreak: false });
    doc.font('Helvetica').fontSize(7).fillColor(BLACK);
    doc.text('-', M + PAD, y + 4, { width: val1 - PAD * 2, lineBreak: false });
    doc.text(fmtMoeda('0'), M + val1 + val2 + val3 + PAD, y + 4, { width: val3 - PAD * 2, lineBreak: false });
    doc.text(fmtMoeda('0'), M + val1 + val2 + val3 + val4 - (M + val1 + val2 + val3) + PAD, y + 4, { width: val4 - PAD * 2, lineBreak: false });
    y += 16;

    // ==============================================
    // INFORMACOES COMPLEMENTARES
    // ==============================================
    hline(doc, y, M, M + CW, BLACK, 0.7);
    y = sectionHeader(doc, y, 'INFORMA\u00c7\u00d5ES COMPLEMENTARES', CW);
    hline(doc, y, M, M + CW, BORDER);
    doc.font('Helvetica').fontSize(6).fillColor('#555555');
    doc.text('Totais aproximados dos Tributos cfe. Lei n\u00b0 12.741/2012: Federais: -; Estaduais: -; Municipais: -;', M + PAD, y + 3, { width: CW - PAD * 2 });
    y += 12;

    // ==============================================
    // RODAPE - Assinaturas
    // ==============================================
    y = Math.max(y, PH - M - 46);
    hline(doc, y, M, M + CW, BLACK, 0.7);
    const footH = 34;
    const footW3 = CW / 3;
    hline(doc, y + footH, M, M + CW, BLACK, 0.7);
    vline(doc, M + footW3, y, y + footH, BORDER);
    vline(doc, M + footW3 * 2, y, y + footH, BORDER);

    doc.font('Helvetica').fontSize(6).fillColor('#888888');
    doc.text('Data de Cientifica\u00e7\u00e3o', M + PAD, y + footH - 10, { width: footW3 - PAD * 2, align: 'center' });
    doc.text('Identifica\u00e7\u00e3o e Assinatura', M + footW3 + PAD, y + footH - 10, { width: footW3 - PAD * 2, align: 'center' });
    doc.text('Identifica\u00e7\u00e3o e Assinatura', M + footW3 * 2 + PAD, y + footH - 10, { width: footW3 - PAD * 2, align: 'center' });

    console.log('[NFSE-PDF] Todas as secoes desenhadas. Finalizando PDF...');

    } catch (e) {
      // Erro durante geracao do PDF - loga e finaliza doc pra nao ficar vazio
      console.error('[NFSE-PDF] ERRO durante geracao do PDF:', e.message);
      console.error(e.stack);
      // Tenta escrever mensagem de erro no PDF antes de finalizar
      try {
        doc.fillColor('red').fontSize(10).text('ERRO AO GERAR DANFSe: ' + e.message, 50, 50);
      } catch (_) {}
      // resolve com o que tiver (mesmo que PDF parcial/branco)
      // Importante: chamar doc.end() pra Promise resolver
    }

    doc.end();
  });
}

// Permite invalidar o cache da logo (usado apos upload via API)
function resetLogoCache() {
  LOGO_BUF = null;
  logoLoaded = false;
  console.log('[NFSE-PDF] Cache da logo invalidado.');
}

module.exports = { gerarPdfDanfse, ensureLogo, loadLogoFromFirebase, resetLogoCache };
