(() => {
  if (window.__uptelAssistantLoaded) return;
  window.__uptelAssistantLoaded = true;

  const BASE = '/uptel-assistant';
  let route = null;
  let suggestion = null;
  let opened = false;
  let appLayout = null;

  const host = document.createElement('div');
  host.id = 'uptel-assistant-root';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{all:initial;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f8fafc}
      *{box-sizing:border-box}.hidden{display:none!important}
      .launcher{position:fixed;right:22px;top:50%;z-index:2147483000;width:52px;height:52px;border:0;border-radius:16px;background:linear-gradient(135deg,#2781f6,#9b5cff);color:white;box-shadow:0 12px 30px #0007;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.2s transform}
      .launcher:hover{transform:translateY(-2px)}.launcher svg{width:27px;height:27px}.launcher-label{position:fixed;right:82px;top:calc(50% + 9px);z-index:2147482999;background:#111827;color:#fff;border:1px solid #374151;border-radius:8px;padding:7px 10px;font-size:12px;opacity:0;pointer-events:none;transition:.15s opacity}.launcher:hover+.launcher-label{opacity:1}
      .drawer{position:fixed;z-index:2147483001;right:0;top:0;bottom:0;width:min(440px,100vw);background:#171a22;border-left:1px solid #343846;box-shadow:-20px 0 45px #0008;display:flex;flex-direction:column;transform:translateX(102%);transition:.22s transform ease}.drawer.open{transform:translateX(0)}
      .header{padding:22px 22px 16px;border-bottom:1px solid #343846}.title-row{display:flex;justify-content:space-between;gap:12px}.title{font-size:24px;font-weight:750;letter-spacing:-.02em}.subtitle{font-size:13px;color:#a7afbf;margin-top:3px}.close{border:0;background:transparent;color:#a7afbf;font-size:28px;cursor:pointer;line-height:1}.badge{display:inline-flex;align-items:center;gap:8px;margin-top:12px;border:1px solid #20a464;border-radius:9px;color:#d8fbe8;padding:6px 10px;font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:#31d17c}.dot.off{background:#ef4444}.tabs{display:flex;gap:24px;padding:0 22px;border-bottom:1px solid #343846}.tab{border:0;background:transparent;color:#a7afbf;padding:14px 2px 12px;cursor:pointer;font-weight:650}.tab.active{color:#fff;border-bottom:2px solid #a66cff}
      .body{padding:18px 20px 24px;overflow:auto;flex:1}.card{background:#202530;border:1px solid #363d4c;border-radius:13px;padding:15px;margin-bottom:14px}.ai-row{display:flex;gap:11px;align-items:flex-start}.spark{flex:0 0 auto;width:38px;height:38px;border-radius:14px;background:linear-gradient(135deg,#2781f6,#9b5cff);display:flex;align-items:center;justify-content:center;font-size:20px}.ai-copy{font-size:14px;line-height:1.5;color:#e7eaf0}.section-title{font-size:15px;font-weight:750;margin-bottom:10px}.reply{white-space:pre-wrap;font-size:14px;line-height:1.55;color:#edf0f6;background:#171b23;border:1px solid #384151;border-radius:10px;padding:13px}.actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px}.btn{border:1px solid #475064;border-radius:9px;padding:10px 12px;background:#2a303c;color:#f8fafc;font-weight:680;cursor:pointer}.btn.primary{border:0;background:linear-gradient(90deg,#2781f6,#a855f7)}.btn.outline{grid-column:1/-1;background:transparent;border-color:#9b6bff;color:#c8aaff}.btn:disabled{opacity:.55;cursor:not-allowed}.summary{font-size:13px;line-height:1.65;color:#d8dce5}.summary b{color:#fff}.empty{text-align:center;padding:28px 12px;color:#a7afbf}.empty-icon{width:52px;height:52px;margin:0 auto 13px;border-radius:17px;background:linear-gradient(135deg,#2781f6,#9b5cff);display:flex;align-items:center;justify-content:center;font-size:25px}.error{color:#fecaca;background:#451a1a;border:1px solid #7f1d1d;border-radius:10px;padding:11px;font-size:13px;margin-bottom:12px}
      .chat-log{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}.bubble{border-radius:12px;padding:11px 12px;font-size:13px;line-height:1.5;white-space:pre-wrap}.bubble.user{background:#245db7;align-self:flex-end;max-width:88%}.bubble.ai{background:#252b36;border:1px solid #3a4252;align-self:flex-start;max-width:95%}.chat-form textarea{width:100%;min-height:90px;resize:vertical;border:1px solid #3c4557;border-radius:11px;background:#11151c;color:#fff;padding:12px;font:inherit}.chat-form .btn{width:100%;margin-top:9px}.footer{border-top:1px solid #343846;color:#99a2b3;font-size:11px;padding:12px 18px;text-align:center}.spinner{display:inline-block;width:15px;height:15px;border:2px solid #ffffff55;border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px;margin-right:7px}@keyframes spin{to{transform:rotate(360deg)}}
      @media(max-width:720px){.launcher{right:12px;bottom:78px;top:auto}.launcher-label{display:none}.drawer{width:100vw}}
    </style>
    <button class="launcher hidden" type="button" aria-label="Abrir Assistente Uptel" title="Assistente Uptel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l1.5 5.2L19 9l-5.5 1.8L12 16l-1.5-5.2L5 9l5.5-1.8L12 2Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></svg></button><span class="launcher-label">Assistente Uptel</span>
    <aside class="drawer" aria-label="Assistente Uptel">
      <header class="header"><div class="title-row"><div><div class="title">Assistente Uptel</div><div class="subtitle">Copiloto de atendimento</div></div><button class="close" aria-label="Fechar">×</button></div><div class="badge"><span class="dot"></span><span class="status-text">Verificando Zyloo…</span></div></header>
      <nav class="tabs"><button class="tab active" data-tab="suggestions">Sugestões</button><button class="tab" data-tab="chat">Chat</button></nav>
      <main class="body"><section class="suggestions-view"></section><section class="chat-view hidden"><div class="chat-log"><div class="bubble ai">Faça uma pergunta interna sobre a conversa. Nada será enviado ao cliente.</div></div><form class="chat-form"><textarea maxlength="2000" placeholder="Ex.: resuma o pedido e indique o próximo passo"></textarea><button class="btn primary" type="submit">Perguntar ao Assistente</button></form></section></main>
      <footer class="footer">A resposta só será enviada após aprovação do atendente.</footer>
    </aside>`;

  const $ = selector => root.querySelector(selector);
  const launcher = $('.launcher');
  const drawer = $('.drawer');
  const suggestionsView = $('.suggestions-view');

  function restoreChatwootLayout() {
    if (!appLayout) return;
    const { element, width, maxWidth, transition } = appLayout;
    element.style.width = width;
    element.style.maxWidth = maxWidth;
    element.style.transition = transition;
    appLayout = null;
  }

  function syncChatwootLayout() {
    const shouldReserveSpace = opened && route && window.innerWidth >= 1180;
    if (!shouldReserveSpace) {
      restoreChatwootLayout();
      return;
    }
    const element = document.querySelector('#app');
    if (!element) return;
    if (!appLayout) {
      appLayout = {
        element,
        width: element.style.width,
        maxWidth: element.style.maxWidth,
        transition: element.style.transition,
      };
    }
    const drawerWidth = Math.ceil(drawer.getBoundingClientRect().width) || 440;
    element.style.width = `calc(100% - ${drawerWidth}px)`;
    element.style.maxWidth = `calc(100% - ${drawerWidth}px)`;
    element.style.transition = 'width .22s ease, max-width .22s ease';
  }

  function parseRoute() {
    const account = location.pathname.match(/\/app\/accounts\/(\d+)/)?.[1];
    const conversation = location.pathname.match(/\/conversations\/(\d+)/)?.[1];
    return account && conversation ? { accountId: account, conversationId: conversation } : null;
  }

  function authHeaders() {
    try {
      const pair = document.cookie.split('; ').find(item => item.startsWith('cw_d_session_info='));
      if (!pair) return {};
      const session = JSON.parse(decodeURIComponent(pair.slice(pair.indexOf('=') + 1)));
      return Object.fromEntries(['access-token','token-type','client','expiry','uid'].filter(key => session[key]).map(key => [key, session[key]]));
    } catch { return {}; }
  }

  async function api(path, body) {
    const response = await fetch(`${BASE}${path}`, { method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body:JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Não foi possível consultar o assistente');
    return payload;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  }

  function emptyView(errorMessage = '') {
    suggestionsView.innerHTML = `${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ''}<div class="empty"><div class="empty-icon">✦</div><div class="section-title">Pronto para ajudar</div><p>O Assistente analisará somente a conversa aberta e preparará uma resposta para sua aprovação.</p><button class="btn primary analyze" type="button">Analisar conversa</button></div>`;
    $('.analyze')?.addEventListener('click', generateSuggestion);
  }

  function renderSuggestion(data) {
    suggestion = data;
    suggestionsView.innerHTML = `<div class="card ai-row"><div class="spark">✦</div><div class="ai-copy">Analisei a conversa e o cadastro disponível. Preparei uma resposta com os próximos passos.</div></div><div class="card"><div class="section-title">Resposta sugerida</div><div class="reply">${escapeHtml(data.suggestedReply)}</div><div class="actions"><button class="btn primary insert" type="button">Inserir no campo</button><button class="btn copy" type="button">Copiar</button><button class="btn outline regenerate" type="button">Gerar outra</button></div></div><div class="card summary"><div class="section-title">Resumo da conversa</div><div>${escapeHtml(data.summary)}</div><div>• <b>Interesse:</b> ${escapeHtml(data.interest)}</div><div>• <b>Empresa:</b> ${escapeHtml(data.company)}</div><div>• <b>Próxima ação:</b> ${escapeHtml(data.nextAction)}</div></div>`;
    $('.insert').addEventListener('click', () => insertIntoComposer(data.suggestedReply));
    $('.copy').addEventListener('click', () => copyText(data.suggestedReply));
    $('.regenerate').addEventListener('click', generateSuggestion);
  }

  async function generateSuggestion() {
    if (!route) return;
    suggestionsView.innerHTML = '<div class="empty"><span class="spinner"></span>Analisando a conversa…</div>';
    try { renderSuggestion(await api('/api/suggest', route)); }
    catch (error) { emptyView(error.message); }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Resposta copiada.'); }
    catch { toast('Não foi possível copiar automaticamente.'); }
  }

  function insertIntoComposer(text) {
    const editor = document.querySelector('.reply-box .ProseMirror[contenteditable="true"]');
    if (!editor) { copyText(text); toast('Campo de resposta não encontrado; a resposta foi copiada.'); return; }
    drawer.classList.remove('open'); opened = false; syncChatwootLayout();
    editor.focus();
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      copyText(text);
      toast('A resposta foi copiada; cole-a no campo de mensagem.');
      return;
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:text }));
    toast('Resposta inserida. Revise antes de enviar.');
  }

  function toast(message) {
    const node = document.createElement('div');
    node.textContent = message;
    Object.assign(node.style,{position:'fixed',zIndex:'2147483647',left:'50%',bottom:'28px',transform:'translateX(-50%)',background:'#111827',color:'#fff',border:'1px solid #374151',borderRadius:'9px',padding:'10px 14px',fontSize:'13px',boxShadow:'0 10px 30px #0008'});
    document.body.appendChild(node); setTimeout(() => node.remove(), 2600);
  }

  async function updateStatus() {
    try {
      const response = await fetch(`${BASE}/api/status`, { credentials:'same-origin' });
      const status = await response.json();
      $('.status-text').textContent = status.configured ? 'Zyloo configurado' : 'Zyloo não configurado';
      $('.dot').classList.toggle('off', !status.configured);
    } catch { $('.status-text').textContent = 'Assistente indisponível'; $('.dot').classList.add('off'); }
  }

  function syncRoute() {
    const next = parseRoute();
    const changed = next?.conversationId !== route?.conversationId || next?.accountId !== route?.accountId;
    route = next;
    launcher.classList.toggle('hidden', !route);
    if (!route) { drawer.classList.remove('open'); opened = false; syncChatwootLayout(); }
    if (changed) { suggestion = null; emptyView(); }
  }

  launcher.addEventListener('click', () => { opened = !opened; drawer.classList.toggle('open', opened); syncChatwootLayout(); if (opened) updateStatus(); });
  $('.close').addEventListener('click', () => { opened = false; drawer.classList.remove('open'); syncChatwootLayout(); });
  root.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    root.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
    $('.suggestions-view').classList.toggle('hidden', tab.dataset.tab !== 'suggestions');
    $('.chat-view').classList.toggle('hidden', tab.dataset.tab !== 'chat');
  }));
  $('.chat-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!route) return;
    const textarea = $('.chat-form textarea'); const prompt = textarea.value.trim(); if (!prompt) return;
    const log = $('.chat-log'); log.insertAdjacentHTML('beforeend', `<div class="bubble user">${escapeHtml(prompt)}</div><div class="bubble ai pending"><span class="spinner"></span>Pensando…</div>`); textarea.value = '';
    try { const data = await api('/api/chat', { ...route, prompt }); $('.pending').textContent = data.answer; }
    catch (error) { $('.pending').textContent = `Erro: ${error.message}`; }
    $('.pending')?.classList.remove('pending'); log.scrollTop = log.scrollHeight;
  });

  const originalPushState = history.pushState;
  history.pushState = function(...args){ originalPushState.apply(this,args); queueMicrotask(syncRoute); };
  const originalReplaceState = history.replaceState;
  history.replaceState = function(...args){ originalReplaceState.apply(this,args); queueMicrotask(syncRoute); };
  addEventListener('popstate', syncRoute);
  addEventListener('resize', syncChatwootLayout);
  new MutationObserver(syncRoute).observe(document.body, { childList:true, subtree:true });
  emptyView(); syncRoute(); updateStatus();
})();
