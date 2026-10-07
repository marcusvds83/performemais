/**
 * Performe+ Fiscal Cloud — Frontend App
 * ======================================
 */

(function() {
  'use strict';

  // --- State ---
  let API_KEY = localStorage.getItem('nfse_api_key') || '';
  let allNfses = [];
  let currentNfse = null;
  let refreshTimer = null;
  let sefinTimer = null;

  // --- URL Routing ---
  const TAB_PATHS = {
    painel: '/painel',
    docs: '/documentacao',
    impostos: '/impostos',
    setup: '/setup',
    campos: '/campo-odoo'
  };
  const PATH_TO_TAB = {};
  for (const [tab, path] of Object.entries(TAB_PATHS)) PATH_TO_TAB[path] = tab;

  function resolveTabFromPath() {
    const p = window.location.pathname.replace(/\/+$/, '');
    return PATH_TO_TAB[p] || 'painel';
  }

  // --- DOM ---
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // --- Init ---
  function init() {
    if (API_KEY) {
      showDashboard();
    } else {
      showAuth();
    }
    bindEvents();
  }

  // --- Auth ---
  function showAuth() {
    $('#auth-screen').classList.remove('hidden');
    $('#dashboard').classList.add('hidden');
    clearInterval(refreshTimer);
    clearInterval(sefinTimer);
  }

  function showDashboard() {
    $('#auth-screen').classList.add('hidden');
    $('#dashboard').classList.remove('hidden');
    loadCertStatus();
    // Data loading and timers are handled by switchTab via initTabs
  }

  function bindEvents() {
    $('#auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = $('#api-key-input').value.trim();
      if (!key) return;
      $('#auth-error').textContent = 'Verificando...';
      try {
        const r = await apiFetch('/api/v1/nfse/dashboard', key);
        if (!r.ok) {
          const data = await r.json();
          $('#auth-error').textContent = data.erro || 'API Key invalida';
          return;
        }
        API_KEY = key;
        localStorage.setItem('nfse_api_key', key);
        showDashboard();
      } catch (err) {
        $('#auth-error').textContent = 'Erro de conexao com o servidor';
      }
    });

    $('#btn-logout').addEventListener('click', () => {
      API_KEY = '';
      localStorage.removeItem('nfse_api_key');
      showAuth();
      $('#api-key-input').value = '';
      $('#auth-error').textContent = '';
    });

    $('#btn-refresh').addEventListener('click', () => {
      const btn = $('#btn-refresh');
      btn.classList.add('spinning');
      loadDashboard().finally(() => setTimeout(() => btn.classList.remove('spinning'), 300));
    });

    $('#search-input').addEventListener('input', renderTable);
    $('#filter-status').addEventListener('change', renderTable);

    // Modal events
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay')) closeModal();
    });
    $('#modal-copy').addEventListener('click', copyXml);
    $('#modal-download-xml').addEventListener('click', () => downloadFile('xml'));
    $('#modal-download-pdf').addEventListener('click', () => downloadFile('pdf'));
    $('#modal-consultar-sefin').addEventListener('click', consultarSefinFromModal);
    $('#modal-reattach').addEventListener('click', () => {
      if (!currentNfse) return;
      const id = currentNfse.id;
      closeModal();
      setTimeout(() => window._reattach(id), 200);
    });

    $('#sefin-result-close').addEventListener('click', () => {
      $('#sefin-result-overlay').classList.add('hidden');
    });
    $('#sefin-result-overlay').addEventListener('click', (e) => {
      if (e.target === $('#sefin-result-overlay')) $('#sefin-result-overlay').classList.add('hidden');
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        $('#sefin-result-overlay').classList.add('hidden');
      }
    });
  }

  // --- API ---
  async function apiFetch(path, key) {
    return fetch(path, {
      headers: { 'X-Api-Key': key || API_KEY },
    });
  }

  // --- Load Dashboard ---
  async function loadDashboard() {
    try {
      const r = await apiFetch('/api/v1/nfse/dashboard');
      if (r.status === 401) {
        showAuth();
        return;
      }
      const data = await r.json();

      // Environment badge
      const badge = $('#env-badge');
      if (data.ambiente === 'PRODUCAO') {
        badge.textContent = 'PRODUCAO';
        badge.className = 'topbar-env prod';
      } else {
        badge.textContent = 'HOMOLOGACAO';
        badge.className = 'topbar-env hom';
      }

      // Odoo status
      const odooInd = $('#odoo-indicator');
      if (data.conectado_odoo) {
        odooInd.className = 'status-indicator online';
      } else {
        odooInd.className = 'status-indicator offline';
      }

      allNfses = data.nfses || [];

      // KPIs
      const resumo = data.resumo || {};
      $('#kpi-total').textContent = resumo.total || 0;
      $('#kpi-autorizadas').textContent = resumo.autorizadas || 0;
      $('#kpi-pendentes').textContent = resumo.pendentes || 0;
      $('#kpi-erros').textContent = resumo.erros || 0;
      $('#kpi-canceladas').textContent = resumo.canceladas || 0;
      $('#kpi-valor').textContent = formatCurrency(resumo.valor_total_autorizado || 0);

      // Last update
      $('#last-update').textContent = 'Atualizado: ' + formatDateTime(new Date());

      renderTable();
    } catch (err) {
      console.error('[Dashboard] Load error:', err);
    }
  }

  // --- Load SEFIN Status ---
  async function loadSefinStatus() {
    const ind = $('#sefin-indicator');
    const msg = $('#sefin-msg');
    const url = $('#sefin-url');
    const lat = $('#sefin-latency');

    ind.className = 'status-indicator checking';
    msg.textContent = 'Verificando...';
    msg.className = 'sefin-msg checking';

    try {
      const r = await apiFetch('/api/v1/nfse/dashboard/sefin-status');
      const data = await r.json();

      url.textContent = data.url || '--';

      if (data.status === 'online') {
        ind.className = 'status-indicator online';
        msg.textContent = data.mensagem;
        msg.className = 'sefin-msg online';
        lat.textContent = data.latency_ms ? data.latency_ms + 'ms' : '';
        $('#sefin-bar').style.borderLeftColor = 'var(--accent)';
      } else if (data.status === 'sem_certificado') {
        ind.className = 'status-indicator warning';
        msg.textContent = data.mensagem;
        msg.className = 'sefin-msg offline';
        lat.textContent = '';
        $('#sefin-bar').style.borderLeftColor = 'var(--warning)';
      } else {
        ind.className = 'status-indicator offline';
        msg.textContent = data.mensagem;
        msg.className = 'sefin-msg offline';
        lat.textContent = '';
        $('#sefin-bar').style.borderLeftColor = 'var(--danger)';
      }
    } catch (err) {
      ind.className = 'status-indicator offline';
      msg.textContent = 'Erro ao verificar';
      msg.className = 'sefin-msg offline';
    }
  }

  // --- Load Cert Status ---
  async function loadCertStatus() {
    try {
      const r = await apiFetch('/api/v1/nfse/dashboard/cert-status');
      const data = await r.json();
      const ind = $('#cert-indicator');
      if (data.carregado) {
        ind.className = 'status-indicator online';
        ind.title = 'Cert: ' + (data.info?.subject?.CN || 'OK') + ' | Exp: ' + (data.info?.validade || '?');
      } else {
        ind.className = 'status-indicator offline';
        ind.title = 'Certificado nao carregado';
      }
    } catch (err) {
      $('#cert-indicator').className = 'status-indicator offline';
    }
  }

  // --- Render Table (draw) ---
  function renderTable() {
    const search = ($('#search-input').value || '').toLowerCase();
    const statusFilter = $('#filter-status').value;

    let filtered = allNfses.filter(n => {
      if (statusFilter && n.status_nfse !== statusFilter) return false;
      if (search) {
        const haystack = [
          n.fatura, n.parceiro, n.chave_acesso, n.cnpj_tomador, n.numero_nfse
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });

    $('#result-count').textContent = filtered.length + ' registro' + (filtered.length !== 1 ? 's' : '');

    const tbody = $('#table-body');

    if (!filtered.length) {
      tbody.innerHTML = '<tr class="tr-empty"><td colspan="9"><div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><p>Nenhuma NFS-e encontrada</p></div></td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(n => {
      const statusClass = n.status_nfse || '';
      const statusLabel = STATUS_LABELS[statusClass] || statusClass;
      const dateStr = n.data_emissao || n.data_fatura || '';
      const dateFormatted = formatDate(dateStr);
      const timeFormatted = formatTime(dateStr);
      const cnpjMasked = maskCnpj(n.cnpj_tomador);

      return '<tr data-id="' + n.id + '">' +
        '<td><span class="td-status-dot ' + statusClass + '" data-tooltip="' + statusLabel + '"></span></td>' +
        '<td class="td-fatura">' + esc(n.fatura) + '</td>' +
        '<td class="td-nfse">' + (n.numero_nfse ? esc(String(n.numero_nfse)) : '--') + '</td>' +
        '<td class="td-cliente">' + esc(n.parceiro) + '</td>' +
        '<td class="td-cnpj">' + (cnpjMasked || '--') + '</td>' +
        '<td class="td-valor">' + formatCurrency(n.valor_total) + '</td>' +
        '<td class="td-data">' + dateFormatted + (timeFormatted ? '<div class="td-data-time">' + timeFormatted + '</div>' : '') + '</td>' +
        '<td class="td-chave">' + (n.chave_acesso ? '<a href="#" onclick="window._openXml(' + n.id + ');return false" title="Clique para ver XML">' + esc(n.chave_acesso.substring(0, 28)) + '...</a>' : '--') + '</td>' +
        '<td class="td-actions"><div class="action-group">' +
          '<button class="btn-action" data-tooltip="Ver XML" onclick="window._openXml(' + n.id + ')" ' + (!n.tem_xml && !n.chave_acesso ? 'disabled' : '') + '>&lt;/&gt;</button>' +
          '<button class="btn-action btn-action-pdf" data-tooltip="PDF" onclick="window._downloadPdf(' + n.id + ')" ' + (!n.tem_xml && !n.chave_acesso ? 'disabled' : '') + '>PDF</button>' +
          '<button class="btn-action" data-tooltip="Consultar gov.br" onclick="window._consultarSefin(' + n.id + ')" ' + (!n.chave_acesso ? 'disabled' : '') + '>&#x1F310;</button>' +
          (n.status_nfse === 'autorizada' ? '<button class="btn-action" data-tooltip="Re-anexar PDF+XML ao Odoo" onclick="window._reattach(' + n.id + ')" style="color:var(--warning)">&#x21BB;</button>' : '') +
        '</div></td>' +
      '</tr>';
    }).join('');
  }

  // --- Global action handlers ---
  window._openXml = function(id) {
    const nf = allNfses.find(n => n.id === id);
    if (!nf) return;
    currentNfse = nf;
    $('#modal-title').textContent = 'XML — NFS-e ' + (nf.numero_nfse || nf.fatura);
    $('#modal-info').textContent = nf.fatura + ' | ' + nf.parceiro + ' | ' + formatCurrency(nf.valor_total);
    $('#modal-xml-content').textContent = 'Carregando XML...';

    // Try loading from Odoo field, then from SEFIN
    openModal();

    // Fetch XML content for viewing
    apiFetch('/api/v1/nfse/dashboard/' + id + '/xml')
      .then(r => {
        if (!r.ok) throw new Error('Nao disponivel');
        return r.text();
      })
      .then(xml => {
        $('#modal-xml-content').textContent = xml;
      })
      .catch(() => {
        $('#modal-xml-content').textContent = 'XML nao disponivel. Tente consultar no gov.br.';
      });
  };

  window._downloadPdf = function(id) {
    window.open('/api/v1/nfse/dashboard/' + id + '/pdf?api_key=' + encodeURIComponent(API_KEY), '_blank');
  };

  window._consultarSefin = async function(id) {
    const nf = allNfses.find(n => n.id === id);
    if (!nf) return;

    $('#sefin-result-body').innerHTML =
      '<div class="sefin-result-card loading"><div class="sefin-result-title" style="color:var(--info)">Consultando gov.br / SEFIN...</div>' +
      '<div class="sefin-result-detail">Chave: <code>' + esc(nf.chave_acesso) + '</code></div></div>';
    $('#sefin-result-overlay').classList.remove('hidden');

    try {
      const r = await apiFetch('/api/v1/nfse/dashboard/' + id + '/consultar');
      const data = await r.json();

      if (data.existe_sefin) {
        $('#sefin-result-body').innerHTML =
          '<div class="sefin-result-card found">' +
          '<div class="sefin-result-title found">NFS-e Encontrada no Portal gov.br</div>' +
          '<div class="sefin-result-detail">' +
          'Fatura: <code>' + esc(nf.fatura) + '</code><br>' +
          'NFS-e: <code>' + esc(data.numero_nfse || '?') + '</code><br>' +
          'Chave: <code>' + esc(data.chave_acesso) + '</code>' +
          (data.dados ? '<br>DFSe: <code>' + esc(data.dados.nDFSe || '') + '</code>' : '') +
          '</div></div>';
      } else {
        $('#sefin-result-body').innerHTML =
          '<div class="sefin-result-card not-found">' +
          '<div class="sefin-result-title not-found">NFS-e NAO Encontrada no Portal</div>' +
          '<div class="sefin-result-detail">' +
          'Fatura: <code>' + esc(nf.fatura) + '</code><br>' +
          'Chave: <code>' + esc(data.chave_acesso || nf.chave_acesso) + '</code><br>' +
          (data.erro ? 'Motivo: ' + esc(data.erro) : 'A nota pode nao ter sido registrada pela SEFIN.') +
          '</div></div>';
      }
    } catch (err) {
      $('#sefin-result-body').innerHTML =
        '<div class="sefin-result-card not-found">' +
        '<div class="sefin-result-title not-found">Erro na Consulta</div>' +
        '<div class="sefin-result-detail">' + esc(err.message) + '</div></div>';
    }
  };

  function consultarSefinFromModal() {
    if (!currentNfse) return;
    const id = currentNfse.id;
    closeModal();
    setTimeout(() => window._consultarSefin(id), 200);
  }

  // --- Modal ---
  function openModal() {
    $('#modal-overlay').classList.remove('hidden');
  }
  function closeModal() {
    $('#modal-overlay').classList.add('hidden');
    currentNfse = null;
  }

  function copyXml() {
    const text = $('#modal-xml-content').textContent;
    navigator.clipboard.writeText(text).then(() => {
      const btn = $('#modal-copy');
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = 'Copiar'; }, 1500);
    });
  }

  // --- Re-attach PDF+XML to Odoo ---
  window._reattach = async function(id) {
    const nf = allNfses.find(n => n.id === id);
    if (!nf) return;
    if (!confirm('Re-anexar PDF + XML da NFS-e ' + (nf.numero_nfse || nf.fatura) + ' ao chatter do Odoo?')) return;
    try {
      const r = await fetch('/api/v1/nfse/re-attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ move_id: id }),
      });
      const data = await r.json();
      if (data.sucesso) {
        alert('PDF + XML re-anexados com sucesso!\nVerifique o chatter da fatura ' + nf.fatura + ' no Odoo.');
      } else {
        alert('Falha: ' + (data.erro || 'Erro desconhecido'));
      }
    } catch (err) {
      alert('Erro: ' + err.message);
    }
  };

  function downloadFile(type) {
    if (!currentNfse) return;
    window.open('/api/v1/nfse/dashboard/' + currentNfse.id + '/' + type + '?api_key=' + encodeURIComponent(API_KEY), '_blank');
  }

  // --- Formatters ---
  function formatCurrency(v) {
    return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(s) {
    if (!s) return '--';
    const d = parseDate(s);
    if (!d) return s;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  function formatTime(s) {
    if (!s) return '';
    const d = parseDate(s);
    if (!d) return '';
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDateTime(d) {
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function parseDate(s) {
    if (!s) return null;
    // Handle ISO and Odoo format: 2025-08-29 18:30:00 or 2025-08-29T18:30:00
    const d = new Date(s.replace(' ', 'T'));
    return isNaN(d) ? null : d;
  }

  function maskCnpj(cnpj) {
    if (!cnpj) return '';
    const d = cnpj.replace(/\D/g, '');
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    return d;
  }

  function esc(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // --- Status Labels ---
  const STATUS_LABELS = {
    'autorizada': 'Autorizada',
    'pendente': 'Pendente',
    'processando': 'Processando',
    'erro': 'Erro',
    'cancelada': 'Cancelada',
    'cancelar_solicitado': 'Cancel. Solicitado',
  };

  // --- Tab Navigation + URL Routing ---
  function initTabs() {
    const tabs = document.querySelectorAll('#main-tabs .tab-btn');
    const panels = { painel: $('#tab-painel'), docs: $('#tab-docs'), impostos: $('#tab-impostos'), setup: $('#tab-setup'), campos: $('#tab-campos') };

    function switchTab(tabName, pushState) {
      // Update active button
      tabs.forEach(b => b.classList.remove('active'));
      const activeBtn = document.querySelector('#main-tabs .tab-btn[data-tab="' + tabName + '"]');
      if (activeBtn) activeBtn.classList.add('active');
      // Show/hide panels
      Object.entries(panels).forEach(function(entry) {
        var key = entry[0], panel = entry[1];
        if (!panel) return;
        if (key === tabName) panel.classList.remove('hidden');
        else panel.classList.add('hidden');
      });
      // Pause/resume auto-refresh
      if (tabName === 'painel') {
        if (!refreshTimer) { refreshTimer = setInterval(loadDashboard, 10000); sefinTimer = setInterval(loadSefinStatus, 30000); }
        loadDashboard();
      } else {
        clearInterval(refreshTimer); clearInterval(sefinTimer); refreshTimer = null; sefinTimer = null;
      }
      // Load tab-specific data
      if (tabName === 'docs') loadDocsConfig();
      if (tabName === 'impostos') loadImpostosConfig();
      if (tabName === 'setup') loadSetupStatus();
      // Update URL
      if (pushState && TAB_PATHS[tabName]) {
        history.pushState({ tab: tabName }, '', TAB_PATHS[tabName]);
      }
    }

    // Click handlers
    tabs.forEach(function(btn) {
      btn.addEventListener('click', function() {
        switchTab(btn.dataset.tab, true);
      });
    });

    // Back/forward navigation
    window.addEventListener('popstate', function(e) {
      var tab = (e.state && e.state.tab) || resolveTabFromPath();
      switchTab(tab, false);
    });

    // Initial tab from URL — redirect / to /painel
    var initialTab = resolveTabFromPath();
    if (window.location.pathname.replace(/\/+$/, '') === '' || window.location.pathname === '/') {
      history.replaceState({ tab: 'painel' }, '', '/painel');
    }
    switchTab(initialTab, false);
  }

  // --- Docs: Load Config ---
  async function loadDocsConfig() {
    try {
      const r = await apiFetch('/api/v1/nfse/admin/docs');
      const d = await r.json();
      const c = d.config || {};
      $('#impostos-config-atual').innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">' +
        [['Cidade', c.cidade], ['UF', c.uf], ['IBGE', c.codigo_ibge], ['Ambiente', d.ambiente],
         ['ISS %', c.aliquota_iss], ['C. Trib.', c.c_trib_nac], ['NBS', c.c_nbs],
         ['Simples Nac', c.op_simp_nac], ['Carga Trib %', c.p_tot_trib_sn], ['Serie', c.serie],
         ['Ver. App', c.ver_aplic]].map(([k,v]) =>
          '<div style="padding:8px;background:var(--bg-input);border-radius:6px;border:1px solid var(--border)"><div style="color:var(--text-muted);font-size:0.7rem">' + k + '</div><div style="color:var(--text-primary);font-weight:600;font-size:0.85rem">' + (v || '--') + '</div></div>'
        ).join('') + '</div>';
    } catch (e) { $('#impostos-config-atual').innerHTML = '<p style="color:var(--danger)">Erro ao carregar: ' + e.message + '</p>'; }
  }

  // --- Impostos Tab ---
  // let produtosCache = []; // Removido: aba Impostos nao tem mais secao de produtos
  async function loadImpostosConfig() {
    try {
      const r = await apiFetch('/api/v1/nfse/admin/docs');
      const d = await r.json();
      const c = d.config || {};
      const ibs = c.ibs_cbs || {};
      $('#impostos-config-atual').innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">' +
        [['Cidade', c.cidade], ['UF', c.uf], ['IBGE', c.codigo_ibge], ['Ambiente', d.ambiente],
         ['ISS %', c.aliquota_iss], ['C. Trib.', c.c_trib_nac], ['NBS', c.c_nbs],
         ['Simples Nac', c.op_simp_nac], ['Carga Trib %', c.p_tot_trib_sn], ['Serie', c.serie],
         ['Ver. App', c.ver_aplic],
         ['CINOP', ibs.cinop], ['CST IBS', ibs.cst_ibs], ['CST CBS', ibs.cst_cbs],
         ['pIBS %', ibs.pIBS], ['pCBS %', ibs.pCBS], ['IBS/CBS', ibs.habilitado ? 'ATIVO' : 'DESATIVADO']
        ].map(function(pair) {
          var k = pair[0], v = pair[1];
          var highlight = (k === 'IBS/CBS' && v === 'ATIVO') ? 'border-color:var(--accent)' : '';
          return '<div style="padding:8px;background:var(--bg-input);border-radius:6px;border:1px solid var(--border);' + highlight + '"><div style="color:var(--text-muted);font-size:0.7rem">' + k + '</div><div style="color:var(--text-primary);font-weight:600;font-size:0.85rem">' + (v || '--') + '</div></div>';
        }).join('') + '</div>';
    } catch (e) { $('#impostos-config-atual').innerHTML = '<p style="color:var(--danger)">Erro ao carregar</p>'; }

    // Carrega IBS/CBS
    loadIbsCbsConfig();
  }

  // --- IBS/CBS Config ---
  function loadIbsCbsConfig() {
    apiFetch('/api/v1/nfse/admin/tributacao')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.sucesso) return;
        var ibs = d.ibs_cbs || {};
        $('#ibs-cbs-habilitado').checked = ibs.habilitado !== false;
        $('#trib-cinop').value = ibs.cinop || '01';
        $('#trib-cclass').value = ibs.cClassTrib || '01';
        $('#trib-cst-ibs').value = ibs.cst_ibs || '91';
        $('#trib-cst-cbs').value = ibs.cst_cbs || '91';
        $('#trib-pibs').value = ibs.pIBS || '0.00';
        $('#trib-pcbs').value = ibs.pCBS || '0.00';
        updateIbsCbsPreview(ibs);
        $('#ibs-cbs-status').textContent = 'Configuracao carregada';
        $('#ibs-cbs-status').style.color = 'var(--accent)';
      })
      .catch(function() { /* silencioso */ });
  }

  function updateIbsCbsPreview(ibs) {
    var vBC = '1000.00'; // exemplo
    var vIBS = (Number(vBC) * Number(ibs.pIBS || 0) / 100).toFixed(2);
    var vCBS = (Number(vBC) * Number(ibs.pCBS || 0) / 100).toFixed(2);
    var xml =
      '&lt;IBSCBS&gt;\n' +
      '  &lt;CINOP&gt;' + (ibs.cinop || '01') + '&lt;/CINOP&gt;\n' +
      '  &lt;cClassTrib&gt;' + (ibs.cClassTrib || '01') + '&lt;/cClassTrib&gt;\n' +
      '  &lt;IBS&gt;\n' +
      '    &lt;CST&gt;' + (ibs.cst_ibs || '91') + '&lt;/CST&gt;\n' +
      '    &lt;vBCIBS&gt;' + vBC + '&lt;/vBCIBS&gt;\n' +
      '    &lt;pIBS&gt;' + Number(ibs.pIBS || 0).toFixed(2) + '&lt;/pIBS&gt;\n' +
      '    &lt;vIBS&gt;' + vIBS + '&lt;/vIBS&gt;\n' +
      '  &lt;/IBS&gt;\n' +
      '  &lt;CBS&gt;\n' +
      '    &lt;CST&gt;' + (ibs.cst_cbs || '91') + '&lt;/CST&gt;\n' +
      '    &lt;vBCcbs&gt;' + vBC + '&lt;/vBCcbs&gt;\n' +
      '    &lt;pCBS&gt;' + Number(ibs.pCBS || 0).toFixed(2) + '&lt;/pCBS&gt;\n' +
      '    &lt;vCBS&gt;' + vCBS + '&lt;/vCBS&gt;\n' +
      '  &lt;/CBS&gt;\n' +
      '&lt;/IBSCBS&gt;';
    $('#ibs-cbs-xml-preview').textContent = xml;
  }

  // Atualiza preview ao mudar qualquer campo
  ['trib-cinop','trib-cclass','trib-cst-ibs','trib-cst-cbs','trib-pibs','trib-pcbs','ibs-cbs-habilitado'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function() {
      updateIbsCbsPreview({
        cinop: $('#trib-cinop').value,
        cClassTrib: $('#trib-cclass').value,
        cst_ibs: $('#trib-cst-ibs').value,
        cst_cbs: $('#trib-cst-cbs').value,
        pIBS: $('#trib-pibs').value,
        pCBS: $('#trib-pcbs').value,
      });
    });
  });

  // Salvar IBS/CBS
  $('#btn-salvar-trib').addEventListener('click', async function() {
    var btn = $('#btn-salvar-trib'); btn.disabled = true; btn.textContent = 'Salvando...';
    var status = $('#trib-salvar-status'); status.textContent = '';
    var payload = {
      habilitado: $('#ibs-cbs-habilitado').checked,
      cinop: $('#trib-cinop').value,
      cClassTrib: $('#trib-cclass').value,
      cst_ibs: $('#trib-cst-ibs').value,
      cst_cbs: $('#trib-cst-cbs').value,
      pIBS: parseFloat($('#trib-pibs').value) || 0,
      pCBS: parseFloat($('#trib-pcbs').value) || 0,
    };
    try {
      var r = await fetch('/api/v1/nfse/admin/tributacao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify(payload),
      });
      var d = await r.json();
      if (d.sucesso) {
        status.textContent = 'Salvo! Proxima emissao ja usara estes valores.';
        status.style.color = 'var(--accent)';
        // Atualiza preview
        updateIbsCbsPreview(payload);
        // Atualiza o card de config acima
        loadImpostosConfig();
      } else {
        status.textContent = 'Erro: ' + (d.erro || '');
        status.style.color = 'var(--danger)';
      }
    } catch (e) { status.textContent = 'Erro: ' + e.message; status.style.color = 'var(--danger)'; }
    btn.disabled = false; btn.textContent = 'Salvar Configuracao IBS/CBS';
  });

  // Salvar IM
  $('#btn-salvar-im').addEventListener('click', async () => {
    const im = $('#inp-im-empresa').value.trim();
    if (!im) { alert('Informe a Inscricao Municipal.'); return; }
    const btn = $('#btn-salvar-im'); btn.disabled = true;
    const status = $('#im-salvar-status'); status.textContent = 'Salvando...';
    try {
      const r = await fetch('/api/v1/nfse/admin/impostos/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ inscricao_municipal: im }),
      });
      const d = await r.json();
      status.textContent = d.sucesso ? 'Salvo!' : 'Erro: ' + (d.erro || '');
      status.style.color = d.sucesso ? 'var(--accent)' : 'var(--danger)';
    } catch (e) { status.textContent = 'Erro: ' + e.message; status.style.color = 'var(--danger)'; }
    btn.disabled = false;
  });

  // --- Campos Tab ---
  $('#btn-verificar-campos').addEventListener('click', async () => {
    const btn = $('#btn-verificar-campos'); btn.disabled = true; btn.textContent = 'Verificando...';
    try {
      const r = await apiFetch('/api/v1/nfse/admin/campos/status');
      const d = await r.json();
      if (d.erro) { alert(d.erro); return; }
      const html = '<div style="margin-bottom:8px;color:var(--text-primary);font-weight:600">' + d.existentes + '/' + d.total + ' campos existem | ' + d.faltantes + ' faltante(s)</div>' +
        (d.campos || []).map(c => '<div class="campo-item"><span class="campo-dot ' + (c.existe ? 'ok' : 'missing') + '"></span><span class="campo-nome">' + c.nome + '</span><span class="campo-modelo">' + c.modelo + '</span><span class="campo-label">' + (c.existe ? 'OK' : 'FALTANDO') + ' — ' + c.label + '</span></div>').join('');
      $('#campos-status-lista').innerHTML = html;
    } catch (e) { alert('Erro: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Verificar Campos';
  });

  $('#btn-criar-campos').addEventListener('click', async () => {
    const btn = $('#btn-criar-campos'); btn.disabled = true; btn.textContent = 'Criando...';
    try {
      const r = await fetch('/api/v1/nfse/admin/campos/criar', { method: 'POST', headers: { 'X-Api-Key': API_KEY } });
      const d = await r.json();
      alert('Criados: ' + (d.criados || []).join(', ') + '\nPulados: ' + (d.pulados || []).join(', ') + (d.erros.length ? '\nErros: ' + d.erros.join(', ') : ''));
      // Re-verifica
      if (d.criados && d.criados.length) document.getElementById('btn-verificar-campos').click();
    } catch (e) { alert('Erro: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Criar Campos Ausentes';
  });

  $('#btn-criar-actions').addEventListener('click', async () => {
    const btn = $('#btn-criar-actions'); btn.disabled = true; btn.textContent = 'Criando Actions...';
    try {
      const r = await fetch('/api/v1/nfse/admin/campos/server-actions', { method: 'POST', headers: { 'X-Api-Key': API_KEY } });
      const d = await r.json();

      if (d.saas_restriction) {
        // Odoo SaaS bloqueou - mostra modal com codigo pronto pra copiar
        const resumo = (d.acoes || []).map(a => {
          const statusIcon = a.status === 'criada' ? 'OK' : (a.status === 'atualizada' ? 'OK' : 'manual');
          return '[' + statusIcon + '] ' + a.nome + (a.id ? ' (id=' + a.id + ')' : '') + (a.erro ? ' — ' + a.erro.substring(0, 100) : '');
        }).join('\n');

        const html = '<div style="font-family:Inter,sans-serif;line-height:1.5">' +
          '<div style="background:rgba(234,179,8,0.1);border:1px solid #eab308;border-radius:8px;padding:12px;margin-bottom:16px">' +
            '<strong style="color:#eab308">Atencao:</strong> Odoo Online (SaaS) bloqueia criacao/atualizacao de Server Actions via API (XML-RPC).<br>' +
            'Voce precisa criar as 2 acoes manualmente no Odoo Studio e colar os codigos abaixo.' +
          '</div>' +
          '<div style="margin-bottom:8px;font-size:0.85rem;color:var(--text-muted)">Resumo:</div>' +
          '<pre style="background:var(--surface);padding:8px;border-radius:6px;margin-bottom:16px;font-size:0.78rem;white-space:pre-wrap">' + esc(resumo || '(sem dados)') + '</pre>' +
          '<h3 style="margin:0 0 4px 0;font-size:0.95rem">Passo a passo no Odoo:</h3>' +
          '<ol style="margin:0 0 16px 16px;font-size:0.85rem;padding-left:16px">' +
            '<li>Ative o <b>Modo Desenvolvedor</b> (icone 🐞 no canto superior direito)</li>' +
            '<li>Va em <b>Configuracao > Tecnico > Acoes do Servidor</b></li>' +
            '<li>Clique <b>Novo</b></li>' +
            '<li>Preencha: <b>Nome da acao</b> = <code>Emitir NFS-e</code>, <b>Modelo</b> = <code>Fatura (account.move)</code></li>' +
            '<li>Em <b>Acao</b> escolha <b>Executar codigo Python</b></li>' +
            '<li>Cole o codigo abaixo no campo <b>Codigo Python</b></li>' +
            '<li>Em <b>Vincular com</b> escolha <code>Fatura (account.move)</code> e <b>Visualizacao formulario</b></li>' +
            '<li>Salve. Repita para <b>Cancelar NFS-e</b> com o outro codigo.</li>' +
          '</ol>' +
          '<div style="margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">' +
            '<strong style="font-size:0.95rem">Acao 1: Emitir NFS-e</strong>' +
            '<button onclick="navigator.clipboard.writeText(document.getElementById(&quot;sa-emitir-code&quot;).textContent).then(function(b){b.textContent=&quot;Copiado!&quot;;setTimeout(function(){b.textContent=&quot;Copiar&quot;},2000)}.bind(this))" style="padding:4px 12px;border-radius:4px;border:1px solid var(--border);background:var(--accent);color:#fff;cursor:pointer;font-size:0.78rem">Copiar</button>' +
          '</div>' +
          '<pre id="sa-emitir-code" style="background:var(--surface);padding:10px;border-radius:6px;border:1px solid var(--border);font-family:JetBrains Mono,monospace;font-size:0.75rem;overflow:auto;max-height:300px;margin-bottom:20px">' + esc(d.codigos_prontos.emitir) + '</pre>' +
          '<div style="margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">' +
            '<strong style="font-size:0.95rem">Acao 2: Cancelar NFS-e</strong>' +
            '<button onclick="navigator.clipboard.writeText(document.getElementById(&quot;sa-cancelar-code&quot;).textContent).then(function(b){b.textContent=&quot;Copiado!&quot;;setTimeout(function(){b.textContent=&quot;Copiar&quot;},2000)}.bind(this))" style="padding:4px 12px;border-radius:4px;border:1px solid var(--border);background:var(--accent);color:#fff;cursor:pointer;font-size:0.78rem">Copiar</button>' +
          '</div>' +
          '<pre id="sa-cancelar-code" style="background:var(--surface);padding:10px;border-radius:6px;border:1px solid var(--border);font-family:JetBrains Mono,monospace;font-size:0.75rem;overflow:auto;max-height:300px">' + esc(d.codigos_prontos.cancelar) + '</pre>' +
        '</div>';

        // Reusa o modal existente (XML viewer)
        $('#modal-title').textContent = 'Server Actions - Cole no Odoo Studio';
        $('#modal-xml-content').innerHTML = html;
        $('#modal-info').textContent = '';
        $('#modal-overlay').classList.remove('hidden');
      } else {
        // Sucesso normal ou outro erro
        const lines = (d.acoes || []).map(a => a.nome + ': ' + a.status + (a.id ? ' (id=' + a.id + ')' : '') + (a.erro ? ' — ' + a.erro.substring(0, 100) : '')).join('\n');
        alert(lines + (d.mensagem_saas ? '\n\n' + d.mensagem_saas : ''));
      }
    } catch (e) { alert('Erro: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Criar Server Actions';
  });

  // --- Setup Tab ---
  async function loadSetupStatus() {
    try {
      const r = await apiFetch('/api/v1/nfse/dashboard/cert-status');
      const d = await r.json();
      const el = $('#cert-status-setup');
      if (d.carregado) {
        const info = d.info || {};
        el.innerHTML = '<span style="color:var(--accent);font-weight:600">Certificado OK</span> | ' + (info.subject?.CN || 'N/A') + ' | Validade: ' + (info.validade || '?');
      } else {
        el.innerHTML = '<span style="color:var(--danger);font-weight:600">Nenhum certificado carregado</span> — faca o upload abaixo.';
      }
    } catch (e) { $('#cert-status-setup').innerHTML = '<span style="color:var(--danger)">Erro ao verificar</span>'; }
  }

  // Upload Cert via UI
  $('#btn-upload-cert').addEventListener('click', async () => {
    const fileInput = document.getElementById('inp-cert-file');
    const senha = document.getElementById('inp-cert-senha').value.trim();
    const file = fileInput.files[0];
    if (!file) { alert('Selecione o arquivo PFX.'); return; }
    if (!senha) { alert('Digite a senha do certificado.'); return; }
    const btn = $('#btn-upload-cert'); btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      // Le o arquivo binario como DataURL e extrai apenas o base64 (sem o prefixo 'data:...;base64,')
      // (Antes usava file.text() que devolvia o binario como UTF-8 string - corrompia o PKCS12)
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          const idx = result.indexOf(';base64,');
          if (idx === -1) { reject(new Error('Falha ao ler arquivo como base64')); return; }
          resolve(result.substring(idx + 8));
        };
        reader.onerror = () => reject(reader.error || new Error('Erro de leitura'));
        reader.readAsDataURL(file);
      });
      const r = await fetch('/api/v1/nfse/certificado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ pfxBase64: b64, senha }),
      });
      const d = await r.json();
      if (d.sucesso) { alert('Certificado salvo com sucesso no Firebase!\n\n' + JSON.stringify(d.info, null, 2)); loadSetupStatus(); }
      else { alert('Erro: ' + (d.erro || '')); }
    } catch (e) { alert('Erro: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Enviar Certificado';
  });

  // Upload Logo via UI
  $('#btn-upload-logo').addEventListener('click', async () => {
    const fileInput = document.getElementById('inp-logo-file');
    const file = fileInput.files[0];
    if (!file) { alert('Selecione a imagem da logo.'); return; }
    const btn = $('#btn-upload-logo'); btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      // Le como DataURL e extrai apenas o base64 (mesmo fix do certificado)
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          const idx = result.indexOf(';base64,');
          if (idx === -1) { reject(new Error('Falha ao ler imagem como base64')); return; }
          resolve(result.substring(idx + 8));
        };
        reader.onerror = () => reject(reader.error || new Error('Erro de leitura'));
        reader.readAsDataURL(file);
      });
      const r = await fetch('/api/v1/nfse/certificado/logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ logoBase64: b64 }),
      });
      const d = await r.json();
      if (d.sucesso) {
        const preview = $('#logo-preview');
        preview.innerHTML = '<img src="data:image/png;base64,' + b64 + '" style="max-height:80px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card)"> <span style="color:var(--accent);font-weight:600;margin-left:12px">Logo salva! (' + d.tamanho + ' bytes)</span>';
        alert('Logo salva no Firebase! (' + d.tamanho + ' bytes)');
      } else { alert('Erro: ' + (d.erro || '')); }
    } catch (e) { alert('Erro: ' + e.message); }
    btn.disabled = false; btn.textContent = 'Enviar Logo';
  });

  // --- Start ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); initTabs(); });
  } else {
    init(); initTabs();
  }

})();
