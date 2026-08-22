/**
 * AI Agent Factory - Embeddable Website Chat Widget
 * Usage: <script src="https://your-domain.com/widget.js" data-business-id="biz-tonys-barber" data-color="#2563eb"></script>
 */

(function () {
  const currentScript = document.currentScript || Array.from(document.querySelectorAll('script')).pop();
  const businessId = currentScript ? currentScript.getAttribute('data-business-id') : 'biz-tonys-barber';
  const themeColor = (currentScript && currentScript.getAttribute('data-color')) || '#2563eb';

  // Derive the API origin from the script src so the widget works when embedded
  // on an EXTERNAL business website (different origin than the platform server).
  // Falls back to same-origin when no src is available (e.g. local dev).
  let apiOrigin = '';
  try {
    if (currentScript && currentScript.src) {
      const u = new URL(currentScript.src);
      apiOrigin = u.origin;
    }
  } catch (e) { /* same-origin fallback */ }

  if (!businessId) {
    console.error('AI Agent Factory Widget: Missing data-business-id attribute on script tag.');
    return;
  }

  let conversationId = localStorage.getItem('aaf_widget_conv_' + businessId) || null;
  let isOpen = false;

  // Polling state (Task 25): closes the human-handoff reply loop. The widget
  // polls for NEW messages in its own conversation (owner/human replies) using
  // a message-id cursor. One loop per widget instance; failures are silent and
  // retried on the next tick; no credentials or internals are ever logged.
  const POLL_INTERVAL_MS = 3000;
  let lastMessageId = null;
  let pollTimer = null;
  const renderedMessageIds = new Set();

  // Inject CSS
  const style = document.createElement('style');
  style.innerHTML = `
    .aaf-widget-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999999;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .aaf-widget-button {
      width: 60px;
      height: 60px;
      border-radius: 30px;
      background: ${themeColor};
      color: #fff;
      border: none;
      box-shadow: 0 4px 14px rgba(0,0,0,0.25);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .aaf-widget-button:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 20px rgba(0,0,0,0.3);
    }
    .aaf-widget-box {
      display: none;
      position: fixed;
      bottom: 90px;
      right: 20px;
      width: 380px;
      max-width: calc(100vw - 40px);
      height: 520px;
      max-height: calc(100vh - 120px);
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.18);
      border: 1px solid #e5e7eb;
      flex-direction: column;
      overflow: hidden;
      z-index: 999999;
    }
    .aaf-widget-header {
      background: ${themeColor};
      color: #ffffff;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .aaf-widget-header h4 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }
    .aaf-widget-header span {
      font-size: 12px;
      opacity: 0.9;
    }
    .aaf-widget-close {
      background: none;
      border: none;
      color: #fff;
      font-size: 20px;
      cursor: pointer;
    }
    .aaf-widget-messages {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      background: #f9fafb;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .aaf-msg {
      max-width: 80%;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.4;
      word-wrap: break-word;
    }
    .aaf-msg-user {
      align-self: flex-end;
      background: ${themeColor};
      color: #ffffff;
      border-bottom-right-radius: 2px;
    }
    .aaf-msg-agent {
      align-self: flex-start;
      background: #e5e7eb;
      color: #1f2937;
      border-bottom-left-radius: 2px;
    }
    .aaf-msg-system {
      align-self: center;
      background: #fef3c7;
      color: #92400e;
      font-size: 12px;
      text-align: center;
      padding: 6px 12px;
    }
    .aaf-widget-input-row {
      padding: 12px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      gap: 8px;
      background: #fff;
    }
    .aaf-widget-input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #d1d5db;
      border-radius: 20px;
      outline: none;
      font-size: 14px;
    }
    .aaf-widget-input:focus {
      border-color: ${themeColor};
    }
    .aaf-widget-send {
      background: ${themeColor};
      color: #fff;
      border: none;
      padding: 0 16px;
      border-radius: 20px;
      cursor: pointer;
      font-weight: 600;
    }
    .aaf-typing {
      font-size: 12px;
      color: #6b7280;
      font-style: italic;
      padding: 4px 8px;
    }
  `;
  document.head.appendChild(style);

  // Widget Container HTML
  const container = document.createElement('div');
  container.className = 'aaf-widget-container';
  container.innerHTML = `
    <button class="aaf-widget-button" id="aaf-toggle-btn" aria-label="Chat">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
    </button>
    <div class="aaf-widget-box" id="aaf-box">
      <div class="aaf-widget-header">
        <div>
          <h4 id="aaf-biz-name">AI Receptionist</h4>
          <span>Online • Instant Assistant</span>
        </div>
        <button class="aaf-widget-close" id="aaf-close-btn">&times;</button>
      </div>
      <div class="aaf-widget-messages" id="aaf-messages">
        <div class="aaf-msg aaf-msg-agent">
          Hello! 👋 Welcome! How can I assist you today? Feel free to ask about our services, opening hours, prices, or book an appointment!
        </div>
      </div>
      <div class="aaf-widget-input-row">
        <input type="text" class="aaf-widget-input" id="aaf-input" placeholder="Ask anything or book..." />
        <button class="aaf-widget-send" id="aaf-send-btn">Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(container);

  const toggleBtn = document.getElementById('aaf-toggle-btn');
  const closeBtn = document.getElementById('aaf-close-btn');
  const box = document.getElementById('aaf-box');
  const messagesDiv = document.getElementById('aaf-messages');
  const inputEl = document.getElementById('aaf-input');
  const sendBtn = document.getElementById('aaf-send-btn');

  function toggleWidget() {
    isOpen = !isOpen;
    box.style.display = isOpen ? 'flex' : 'none';
    if (isOpen) inputEl.focus();
  }

  toggleBtn.addEventListener('click', toggleWidget);
  closeBtn.addEventListener('click', toggleWidget);

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;

    // Append user message
    const userMsg = document.createElement('div');
    userMsg.className = 'aaf-msg aaf-msg-user';
    userMsg.textContent = text;
    messagesDiv.appendChild(userMsg);

    inputEl.value = '';
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    // Typing indicator
    const typing = document.createElement('div');
    typing.className = 'aaf-typing';
    typing.textContent = 'AI is typing...';
    messagesDiv.appendChild(typing);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;

    try {
      const res = await fetch(apiOrigin + '/api/runtime/chat?business=' + encodeURIComponent(businessId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-business-id': businessId },
        body: JSON.stringify({
          tenantId: businessId,
          userMessage: text,
          conversationId: conversationId,
          channel: 'web_chat'
        })
      });

      const data = await res.json();
      typing.remove();

      if (data.conversationId) {
        conversationId = data.conversationId;
        localStorage.setItem('aaf_widget_conv_' + businessId, conversationId);
        startPolling();
      }
      // The POST response already carries the reply — render it directly and
      // advance the poll cursor so polling never rediscovers it.
      if (data.messageId) {
        lastMessageId = data.messageId;
        renderedMessageIds.add(data.messageId);
      }

      const agentMsg = document.createElement('div');
      agentMsg.className = 'aaf-msg aaf-msg-agent';
      agentMsg.textContent = data.reply || 'Thank you!';
      messagesDiv.appendChild(agentMsg);

      if (data.status === 'WAITING_FOR_HUMAN') {
        const sysMsg = document.createElement('div');
        sysMsg.className = 'aaf-msg aaf-msg-system';
        sysMsg.textContent = '⚠️ A human agent has been notified and will join shortly.';
        messagesDiv.appendChild(sysMsg);
      }
    } catch (err) {
      typing.remove();
      const errMsg = document.createElement('div');
      errMsg.className = 'aaf-msg aaf-msg-system';
      errMsg.textContent = 'Connection issue. Please try again.';
      messagesDiv.appendChild(errMsg);
    }

    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') sendMessage();
  });

  // --- Message polling (Task 25) -------------------------------------------
  // Renders a server message into the transcript, deduped by id.
  function renderServerMessage(m) {
    if (!m || !m.id || renderedMessageIds.has(m.id)) return;
    renderedMessageIds.add(m.id);
    const el = document.createElement('div');
    if (m.sender === 'customer') el.className = 'aaf-msg aaf-msg-user';
    else if (m.sender === 'system') el.className = 'aaf-msg aaf-msg-system';
    else el.className = 'aaf-msg aaf-msg-agent'; // agent + human_agent
    el.textContent = m.content || '';
    messagesDiv.appendChild(el);
  }

  // One lightweight poll for messages newer than the cursor. Pure GET; a
  // failure is retried on the next tick and never surfaced to the customer.
  async function pollOnce() {
    if (!conversationId) return;
    let url = apiOrigin + '/api/runtime/conversations/' + encodeURIComponent(conversationId) +
      '/messages?business=' + encodeURIComponent(businessId);
    if (lastMessageId) url += '&after=' + encodeURIComponent(lastMessageId);
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return;
    const data = await res.json();
    const msgs = (data && Array.isArray(data.messages)) ? data.messages : [];
    let appended = false;
    for (const m of msgs) {
      if (!renderedMessageIds.has(m.id)) { renderServerMessage(m); appended = true; }
    }
    if (msgs.length > 0) lastMessageId = msgs[msgs.length - 1].id;
    if (appended) messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  // Recursive setTimeout (never overlapping requests, single loop). Starts
  // only when a conversation exists; stopping is simply not rescheduling.
  function startPolling() {
    if (pollTimer || !conversationId) return;
    const tick = async () => {
      try {
        await pollOnce();
      } catch (e) {
        /* transient network failure — retried on the next tick */
      }
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  // A conversation restored from a previous page load starts polling
  // immediately (bootstrap renders the transcript on the first tick).
  if (conversationId) startPolling();
})();
