/**
 * services/trib-config.js — Configuracao Tributaria Runtime (IBS/CBS + futuros)
 * ======================================================================
 * Lê/grava config em data/trib-config.json (persiste entre restarts no mesmo deploy).
 * Quando Firebase estiver disponível, pode ser migrado para Firestore.
 *
 * Uso:
 *   const { getTribConfig, saveTribConfig, getIbsCbsConfig } = require('./trib-config');
 *   const ibsCbs = getIbsCbsConfig(); // { cinop, cClassTrib, cst_ibs, cst_cbs, pIBS, pCBS, habilitado }
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'trib-config.json');

/** Valores padrão caso o arquivo não exista */
const DEFAULTS = {
  ibs_cbs: {
    habilitado: true,
    cinop: '01',
    cClassTrib: '01',
    cst_ibs: '91',
    cst_cbs: '91',
    pIBS: '0.00',
    pCBS: '0.00',
  },
};

let _cache = null;
let _cacheMtime = 0;

/** Lê o arquivo de config do disco (com cache em memória) */
function _readFile() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    // Re-lê se o arquivo mudou desde a última leitura
    if (_cache && stat.mtimeMs === _cacheMtime) return _cache;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const data = JSON.parse(raw);
    _cache = data;
    _cacheMtime = stat.mtimeMs;
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return DEFAULTS;
    console.error('[TRIB-CONFIG] Erro ao ler:', err.message);
    return DEFAULTS;
  }
}

/** Grava o arquivo de config no disco e atualiza o cache */
function _writeFile(data) {
  // Garante que o diretório existe
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
  _cache = data;
  _cacheMtime = fs.statSync(CONFIG_PATH).mtimeMs;
}

/** Retorna a config tributária completa */
function getTribConfig() {
  return _readFile();
}

/** Retorna apenas o bloco IBS/CBS (para uso no XML) */
function getIbsCbsConfig() {
  const data = _readFile();
  const ibsCbs = (data && data.ibs_cbs) || DEFAULTS.ibs_cbs;
  return {
    habilitado: ibsCbs.habilitado !== false,
    cinop: String(ibsCbs.cinop || '01'),
    cClassTrib: String(ibsCbs.cClassTrib || '01'),
    cst_ibs: String(ibsCbs.cst_ibs || '91'),
    cst_cbs: String(ibsCbs.cst_cbs || '91'),
    pIBS: parseFloat(ibsCbs.pIBS || 0),
    pCBS: parseFloat(ibsCbs.pCBS || 0),
  };
}

/** Salva o bloco IBS/CBS e retorna o resultado */
function saveIbsCbsConfig(novosValores) {
  const data = _readFile();
  // Mescla apenas os campos permitidos
  const CAMPOS_PERMITIDOS = ['habilitado', 'cinop', 'cClassTrib', 'cst_ibs', 'cst_cbs', 'pIBS', 'pCBS'];
  if (!data.ibs_cbs) data.ibs_cbs = {};
  for (const campo of CAMPOS_PERMITIDOS) {
    if (novosValores[campo] !== undefined) {
      data.ibs_cbs[campo] = novosValores[campo];
    }
  }
  _writeFile(data);
  return data.ibs_cbs;
}

/** Retorna os metadados (opcoes de CINOP, CST, etc) */
function getMeta() {
  const data = _readFile();
  return (data && data._meta) || DEFAULTS._meta || {};
}

module.exports = { getTribConfig, getIbsCbsConfig, saveIbsCbsConfig, getMeta, DEFAULTS };
