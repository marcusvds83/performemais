/**
 * Nytro Bot — Widget de Chat para Site
 * Design inspirado no WhatsApp com a logo da Nytro
 */

(function() {
  'use strict';
  if (window.__NYTRO_CHAT_LOADED__) return;
  window.__NYTRO_CHAT_LOADED__ = true;
  // Cache buster
  var _ts = Date.now();

  const VERCEL_URL = 'https://vercel-nytro-git-main-nytro3.vercel.app';
  const API_ENDPOINT = VERCEL_URL + '/api/chat';
  const LOGO_URL = VERCEL_URL + '/api/logo';
  const PRIMARY_COLOR = '#0F766E';
  const ACCENT_COLOR = '#10B981';
  const WHATSAPP_GREEN = '#25D366';
  const WHATSAPP_BG = '#ECE5DD';
  const WHATSAPP_OUT = '#FFFFFF';
  const WHATSAPP_IN = '#DCF8C6';
  const SESSION_ID = 'web-' + Math.random().toString(36).slice(2, 12);

  let isOpen = false;
  let messages = [{ role: 'assistant', content: 'Olá! Sou o assistente virtual da Nytro. Como posso te ajudar hoje?' }];
  let isLoading = false;

  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    
    #nytro-bubble {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: linear-gradient(135deg, ${WHATSAPP_GREEN}, ${ACCENT_COLOR});
      box-shadow: 0 4px 20px rgba(37, 211, 102, 0.4);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999998;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    #nytro-bubble:hover {
      transform: scale(1.08);
      box-shadow: 0 6px 28px rgba(37, 211, 102, 0.5);
    }
    #nytro-bubble svg {
      width: 30px;
      height: 30px;
      fill: white;
    }
    #nytro-bubble .nytro-badge {
      position: absolute;
      top: -2px;
      right: -2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #25D366;
      border: 2.5px solid white;
      animation: nytro-pulse 2s infinite;
    }
    @keyframes nytro-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    #nytro-window {
      position: fixed;
      bottom: 90px;
      right: 20px;
      width: 380px;
      max-width: calc(100vw - 40px);
      height: 580px;
      max-height: calc(100vh - 120px);
      background: ${WHATSAPP_BG};
      border-radius: 12px;
      box-shadow: 0 8px 40px rgba(0, 0, 0, 0.2);
      display: none;
      flex-direction: column;
      overflow: hidden;
      z-index: 999999;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    #nytro-window.open {
      display: flex;
      animation: nytro-slide 0.3s ease;
    }
    @keyframes nytro-slide {
      from { opacity: 0; transform: translateY(15px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .nytro-header {
      background: linear-gradient(135deg, ${PRIMARY_COLOR}, ${ACCENT_COLOR});
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .nytro-header img {
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: white;
      object-fit: contain;
      padding: 2px;
    }
    .nytro-header-info {
      flex: 1;
      color: white;
    }
    .nytro-header-name {
      font-size: 16px;
      font-weight: 600;
      margin: 0;
    }
    .nytro-header-status {
      font-size: 12px;
      opacity: 0.85;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .nytro-header-status::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #34d399;
    }
    .nytro-close {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      padding: 4px;
      opacity: 0.8;
    }
    .nytro-close:hover { opacity: 1; }
    .nytro-close svg { width: 22px; height: 22px; fill: white; }

    .nytro-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      background: ${WHATSAPP_BG};
      background-image: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="1" fill="%23ddd"/></svg>');
      scroll-behavior: smooth;
    }
    .nytro-body::-webkit-scrollbar { width: 5px; }
    .nytro-body::-webkit-scrollbar-thumb { background: #c1c1c1; border-radius: 3px; }

    .nytro-bubble-msg {
      max-width: 75%;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 14px;
      line-height: 1.45;
      margin-bottom: 8px;
      position: relative;
      box-shadow: 0 1px 1px rgba(0,0,0,0.1);
      word-wrap: break-word;
    }
    .nytro-bubble-bot {
      background: ${WHATSAPP_OUT};
      border-top-left-radius: 0;
      align-self: flex-start;
    }
    .nytro-bubble-user {
      background: ${WHATSAPP_IN};
      border-top-right-radius: 0;
      align-self: flex-end;
      margin-left: auto;
    }
    .nytro-bubble-time {
      font-size: 10px;
      color: #999;
      float: right;
      margin-top: 4px;
      margin-left: 8px;
    }
    .nytro-bubble-lead {
      background: #e7f5ee;
      border: 1px solid #a7f3d0;
      color: #065f46;
      font-size: 12px;
      padding: 8px 12px;
      border-radius: 8px;
      margin-bottom: 8px;
      text-align: center;
    }

    .nytro-typing {
      display: flex;
      gap: 4px;
      padding: 10px 14px;
      background: ${WHATSAPP_OUT};
      border-radius: 8px;
      border-top-left-radius: 0;
      width: fit-content;
      margin-bottom: 8px;
      box-shadow: 0 1px 1px rgba(0,0,0,0.1);
    }
    .nytro-typing span {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #999;
      animation: nytro-typing 1.4s infinite;
    }
    .nytro-typing span:nth-child(2) { animation-delay: 0.2s; }
    .nytro-typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes nytro-typing {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-6px); opacity: 1; }
    }

    .nytro-suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px 12px;
      background: ${WHATSAPP_BG};
    }
    .nytro-suggestion-btn {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 6px 14px;
      font-size: 12px;
      color: ${PRIMARY_COLOR};
      cursor: pointer;
      transition: all 0.2s;
      font-family: inherit;
      box-shadow: 0 1px 1px rgba(0,0,0,0.05);
    }
    .nytro-suggestion-btn:hover {
      background: ${WHATSAPP_IN};
      border-color: ${ACCENT_COLOR};
    }

    .nytro-input-bar {
      padding: 8px 12px;
      background: #f0f0f0;
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .nytro-input-wrap {
      flex: 1;
      background: white;
      border-radius: 24px;
      display: flex;
      align-items: center;
      padding: 2px 4px 2px 14px;
    }
    .nytro-input {
      flex: 1;
      border: none;
      padding: 10px 4px;
      font-size: 14px;
      outline: none;
      font-family: inherit;
      background: transparent;
    }
    .nytro-send-btn {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: none;
      background: ${WHATSAPP_GREEN};
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: transform 0.2s;
    }
    .nytro-send-btn:hover { transform: scale(1.05); }
    .nytro-send-btn:disabled { opacity: 0.5; }
    .nytro-send-btn svg { width: 20px; height: 20px; fill: white; }

    @media (max-width: 480px) {
      #nytro-window {
        bottom: 0;
        right: 0;
        width: 100%;
        height: 100%;
        max-height: 100%;
        border-radius: 0;
      }
      #nytro-bubble {
        bottom: 16px;
        right: 16px;
      }
    }
  `;
  document.head.appendChild(style);

  // Bubble
  const bubble = document.createElement('div');
  bubble.id = 'nytro-bubble';
  bubble.innerHTML = `
    <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
    <div class="nytro-badge"></div>
  `;
  bubble.onclick = toggleChat;
  document.body.appendChild(bubble);

  // Window
  const win = document.createElement('div');
  win.id = 'nytro-window';
  win.innerHTML = `
    <div class="nytro-header">
      <img src="${LOGO_URL}" alt="Nytro" style="width:42px;height:42px;flex-shrink:0;" />
      <div class="nytro-header-info">
        <div class="nytro-header-name">Assistente Nytro</div>
        <div class="nytro-header-status">Online agora</div>
      </div>
      <button class="nytro-close" id="nytro-close-btn">
        <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>
    <div class="nytro-body" id="nytro-body"></div>
    <div class="nytro-suggestions" id="nytro-suggestions">
      <button class="nytro-suggestion-btn" data-text="Quero saber sobre o Nytro Fiscal Cloud">Emissão NF-e / NFs-e</button>
      <button class="nytro-suggestion-btn" data-text="Quais soluções a Nytro oferece?">Soluções Nytro</button>
      <button class="nytro-suggestion-btn" data-text="Como funciona o ERP Odoo?">ERP Odoo</button>
    </div>
    <div class="nytro-input-bar">
      <div class="nytro-input-wrap">
        <input type="text" class="nytro-input" id="nytro-input" placeholder="Digite uma mensagem" autocomplete="off" />
      </div>
      <button class="nytro-send-btn" id="nytro-send-btn">
        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </div>
  `;
  document.body.appendChild(win);

  // Events
  document.getElementById('nytro-close-btn').onclick = function() { isOpen = false; win.classList.remove('open'); };
  document.getElementById('nytro-send-btn').onclick = function() { sendFromInput(); };
  document.getElementById('nytro-input').addEventListener('keydown', function(e) { if (e.key === 'Enter') sendFromInput(); });
  
  document.querySelectorAll('.nytro-suggestion-btn').forEach(function(btn) {
    btn.onclick = function() { sendMessage(btn.getAttribute('data-text')); };
  });

  function toggleChat() {
    isOpen = !isOpen;
    if (isOpen) {
      win.classList.add('open');
      setTimeout(function() { document.getElementById('nytro-input').focus(); }, 300);
      renderMessages();
    } else {
      win.classList.remove('open');
    }
  }

  function sendFromInput() {
    var input = document.getElementById('nytro-input');
    var text = input.value.trim();
    if (!text || isLoading) return;
    input.value = '';
    sendMessage(text);
  }

  function getTime() {
    var d = new Date();
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  }

  function renderMessages() {
    var body = document.getElementById('nytro-body');
    body.innerHTML = '';
    messages.forEach(function(msg) {
      var div = document.createElement('div');
      div.className = 'nytro-bubble-msg ' + (msg.role === 'user' ? 'nytro-bubble-user' : 'nytro-bubble-bot');
      div.innerHTML = msg.content.replace(/</g, '&lt;') + '<span class="nytro-bubble-time">' + getTime() + '</span>';
      body.appendChild(div);
    });
    if (isLoading) {
      var typing = document.createElement('div');
      typing.className = 'nytro-typing';
      typing.innerHTML = '<span></span><span></span><span></span>';
      body.appendChild(typing);
    }
    body.scrollTop = body.scrollHeight;

    var sug = document.getElementById('nytro-suggestions');
    var hasUserMsg = messages.some(function(m) { return m.role === 'user'; });
    sug.style.display = hasUserMsg ? 'none' : 'flex';
  }

  function sendMessage(text) {
    if (isLoading) return;
    messages.push({ role: 'user', content: text });
    isLoading = true;
    renderMessages();

    fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        message: text,
        history: messages.slice(0, -1).map(function(m) {
          return { role: m.role, content: m.content };
        }),
      }),
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      messages.push({ role: 'assistant', content: data.reply });
      if (data.leadCreated) {
        messages.push({ role: 'assistant', content: '✅ Seu contato foi registrado! Um especialista da Nytro entrará em contato em até 1 dia útil.' });
      }
    })
    .catch(function() {
      messages.push({ role: 'assistant', content: 'Desculpe, tive um problema técnico. Pode tentar novamente?' });
    })
    .finally(function() {
      isLoading = false;
      renderMessages();
    });
  }

  setTimeout(function() { if (isOpen) renderMessages(); }, 100);
})();
