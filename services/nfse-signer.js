/**
 * services/nfse-signer.js — Assinatura digital XMLDSig (RSA-SHA256)
 * ================================================================
 * Assina elementos XML no padrao SPED NFS-e v1.01.
 * Suporta tanto <infDPS> (emissao) quanto <infEvento> (cancelamento).
 * 
 * Algoritmos (conforme nfse-js, implementacao de referencia do SPED NFS-e Nacional):
 *   - Canonicalization: http://www.w3.org/TR/2001/REC-xml-c14n-20010315 (C14N 1.0)
 *   - Signature:       http://www.w3.org/2001/04/xmldsig-more#rsa-sha256
 *   - Digest:          http://www.w3.org/2001/04/xmlenc#sha256
 *   - Transform:       enveloped-signature + C14N 1.0
 */

const { SignedXml } = require('xml-crypto');

const NS_SPED = 'http://www.sped.fazenda.gov.br/nfse';

const ALG_C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ALG_SIG = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const ALG_DIGEST = 'http://www.w3.org/2001/04/xmlenc#sha256';
const ALG_ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

/**
 * Detecta automaticamente o tipo de XML e retorna o nome do elemento raiz
 * e o nome do elemento a assinar.
 */
function detectarTipoXml(xmlString) {
  if (xmlString.includes('<infDPS')) {
    return { raiz: 'DPS', info: 'infDPS' };
  }
  if (xmlString.includes('<infPedReg')) {
    return { raiz: 'pedRegEvento', info: 'infPedReg' };
  }
  if (xmlString.includes('<infEvento')) {
    return { raiz: 'EventoNfse', info: 'infEvento' };
  }
  throw new Error('Elemento infDPS, infPedReg ou infEvento nao encontrado no XML.');
}

/**
 * Assina XML com XMLDSig (RSA-SHA256 + C14N 1.0).
 * Detecta automaticamente se e DPS ou Evento de cancelamento.
 * @param {string} xmlString - XML completo (sem assinatura)
 * @param {object} cert - { privateKeyPem, certPem }
 * @returns {string} XML assinado
 */
async function assinarXml(xmlString, cert) {
  const { privateKeyPem, certPem } = cert;
  if (!privateKeyPem || !certPem) {
    throw new Error('Certificado ou chave privada nao disponivel para assinatura.');
  }

  const tipo = detectarTipoXml(xmlString);
  console.log('[NFSE-SIGNER] Tipo detectado: ' + tipo.raiz + '/' + tipo.info);

  // Extrai o Id do elemento info
  const idMatch = xmlString.match(new RegExp('<' + tipo.info + ' Id="([^"]+)"'));
  if (!idMatch) {
    throw new Error('Elemento ' + tipo.info + ' sem Id no XML.');
  }
  const infoId = idMatch[1];
  console.log('[NFSE-SIGNER] Assinando ' + tipo.info + ' Id=' + infoId);

  // Cria o signador
  const sig = new SignedXml({
    privateKey: privateKeyPem,
    publicCert: certPem,
    signatureAlgorithm: ALG_SIG,
    canonicalizationAlgorithm: ALG_C14N,
  });

  // XPath para o elemento info dentro do raiz
  const xpath = "/*[local-name()='" + tipo.raiz + "' and namespace-uri()='" + NS_SPED + "']/*[local-name()='" + tipo.info + "' and namespace-uri()='" + NS_SPED + "']";

  sig.addReference({
    xpath: xpath,
    transforms: [ALG_ENVELOPED, ALG_C14N],
    digestAlgorithm: ALG_DIGEST,
  });

  sig.keyInfoProvider = {
    getKeyInfo: () => {
      const certB64 = certPem
        .replace(/-----BEGIN CERTIFICATE-----/g, '')
        .replace(/-----END CERTIFICATE-----/g, '')
        .replace(/\s+/g, '');
      return '<X509Data><X509Certificate>' + certB64 + '</X509Certificate></X509Data>';
    },
  };

  sig.computeSignature(xmlString);
  const xmlAssinado = sig.getSignedXml();

  console.log('[NFSE-SIGNER] XML assinado com sucesso. Tamanho: ' + xmlAssinado.length + ' bytes');
  return xmlAssinado;
}

module.exports = { assinarXml };
