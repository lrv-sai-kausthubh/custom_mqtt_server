(() => {
  'use strict';

  const TOKEN_KEY = 'homelink.session';
  const MAX_ENTRIES = 1000;
  const $ = (selector) => document.querySelector(selector);

  const elements = {
    connectionLabel: $('#connection-label'),
    connectionDot: $('#connection-dot'),
    error: $('#logs-error'),
    levelFilter: $('#level-filter'),
    search: $('#log-search'),
    autoScroll: $('#auto-scroll'),
    logCount: $('#log-count'),
    logList: $('#log-list'),
    bufferLimit: $('#buffer-limit'),
    pause: $('#toggle-pause'),
    pauseLabel: $('#pause-label'),
    clear: $('#clear-view')
  };

  const state = {
    socket: null,
    logs: [],
    paused: false,
    filter: 'all',
    search: '',
    autoScroll: true
  };

  const token = window.localStorage.getItem(TOKEN_KEY) || '';

  function setStatus(text, connected) {
    elements.connectionLabel.textContent = text;
    elements.connectionDot.classList.toggle('offline', !connected);
  }

  function showError(message) {
    elements.error.textContent = message;
    elements.error.classList.add('error');
    elements.error.classList.remove('hidden');
  }

  function hideError() {
    elements.error.textContent = '';
    elements.error.classList.add('hidden');
    elements.error.classList.remove('error');
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    const time = date.toLocaleTimeString([], { hour12: false });
    return `${time}.${String(date.getMilliseconds()).padStart(3, '0')}`;
  }

  function formatValue(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') {
      const cleaned = value.replace(/[\r\n\t]+/g, ' ');
      if (cleaned === '') return '""';
      return /[\s"=]/.test(cleaned) ? JSON.stringify(cleaned) : cleaned;
    }
    return String(value);
  }

  function detailText(entry) {
    const details = entry && entry.details && typeof entry.details === 'object' ? entry.details : {};
    return Object.entries(details)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(' ');
  }

  function matches(entry) {
    if (state.filter !== 'all' && entry.level !== state.filter) return false;
    if (!state.search) return true;
    const haystack = `${entry.ts || ''} ${entry.level || ''} ${entry.event || ''} ${entry.line || ''} ${detailText(entry)}`.toLowerCase();
    return haystack.includes(state.search);
  }

  function makeRow(entry) {
    const row = document.createElement('div');
    row.className = `log-row level-${entry.level || 'info'}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = formatTime(entry.ts);

    const level = document.createElement('span');
    level.className = 'log-level';
    level.textContent = entry.level || 'info';

    const event = document.createElement('span');
    event.className = 'log-event';
    event.textContent = entry.event || '(unknown)';

    const details = document.createElement('span');
    details.className = 'log-details';
    const text = detailText(entry);
    details.textContent = text || '—';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'log-copy';
    copy.title = 'Copy this log line';
    copy.setAttribute('aria-label', 'Copy this log line');
    copy.textContent = '⧉';
    copy.addEventListener('click', async () => {
      const line = entry.line || `${entry.ts || ''} ${entry.level || ''} ${entry.event || ''} ${text}`.trim();
      try {
        await navigator.clipboard.writeText(line);
        copy.textContent = '✓';
        setTimeout(() => { copy.textContent = '⧉'; }, 1200);
      } catch (_error) {
        // Older browsers may block clipboard access. Select the details instead.
        const range = document.createRange();
        range.selectNodeContents(details);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });

    row.append(time, level, event, details, copy);
    return row;
  }

  function updateCount(visible) {
    elements.logCount.textContent = `${visible} / ${state.logs.length} entries`;
  }

  function visibleRows() {
    return elements.logList.querySelectorAll('.log-row').length;
  }

  function scrollToBottom() {
    if (state.autoScroll) elements.logList.scrollTop = elements.logList.scrollHeight;
  }

  function renderAll() {
    const fragment = document.createDocumentFragment();
    let visible = 0;
    for (const entry of state.logs) {
      if (!matches(entry)) continue;
      fragment.append(makeRow(entry));
      visible += 1;
    }

    elements.logList.replaceChildren();
    if (visible === 0) {
      const empty = document.createElement('div');
      empty.className = 'logs-empty';
      empty.textContent = state.logs.length === 0
        ? 'No log entries yet. New backend events will appear here.'
        : 'No entries match this filter.';
      elements.logList.append(empty);
    } else {
      elements.logList.append(fragment);
    }
    updateCount(visible);
    scrollToBottom();
  }

  function appendEntry(entry) {
    if (!matches(entry)) {
      updateCount(visibleRows());
      return;
    }

    const empty = elements.logList.querySelector('.logs-empty');
    if (empty) empty.remove();
    elements.logList.append(makeRow(entry));
    while (visibleRows() > MAX_ENTRIES) {
      const first = elements.logList.querySelector('.log-row');
      if (!first) break;
      first.remove();
    }
    updateCount(visibleRows());
    scrollToBottom();
  }

  function trimLogs() {
    if (state.logs.length > MAX_ENTRIES) {
      state.logs.splice(0, state.logs.length - MAX_ENTRIES);
    }
  }

  function setPaused(paused) {
    state.paused = paused;
    elements.pause.textContent = paused ? 'Resume' : 'Pause';
    elements.pause.classList.toggle('button-primary', paused);
    elements.pause.classList.toggle('button-outline', !paused);
    elements.pauseLabel.textContent = paused ? 'Paused' : 'Live';
    if (!paused) renderAll();
  }

  function subscribe() {
    if (!state.socket || !state.socket.connected) return;
    state.socket.timeout(6000).emit('subscribe-logs', (timeoutError, reply) => {
      if (timeoutError) {
        showError('The backend did not answer the log subscription. Check that the server is running.');
        setStatus('No answer', false);
        return;
      }
      if (!reply || !reply.ok) {
        showError((reply && reply.error) || 'Administrator access is required. Sign in with an admin account.');
        setStatus('Access denied', false);
        state.socket.disconnect();
        return;
      }

      hideError();
      state.logs = Array.isArray(reply.logs) ? reply.logs.slice(-MAX_ENTRIES) : [];
      elements.bufferLimit.textContent = String(reply.limit || MAX_ENTRIES);
      renderAll();
      setStatus('Live', true);
    });
  }

  function connect() {
    if (!token) {
      setStatus('Not signed in', false);
      showError('No saved session was found. Sign in to the workspace first, then open Server logs from the admin panel.');
      return;
    }
    if (!window.io) {
      setStatus('Socket.IO missing', false);
      showError('The Socket.IO client did not load. Reload the page.');
      return;
    }

    state.socket = window.io({ auth: { token, logsOnly: true } });

    state.socket.on('connect', () => {
      setStatus('Connected', true);
      subscribe();
    });

    state.socket.on('log-entry', (entry) => {
      if (!entry || !entry.event) return;
      state.logs.push(entry);
      trimLogs();
      if (!state.paused) appendEntry(entry);
      else updateCount(visibleRows());
    });

    state.socket.on('connect_error', (error) => {
      setStatus('Disconnected', false);
      showError(error && error.message ? error.message : 'Could not connect to the backend.');
    });

    state.socket.on('disconnect', () => {
      setStatus('Disconnected', false);
    });
  }

  function setupControls() {
    elements.levelFilter.addEventListener('change', () => {
      state.filter = elements.levelFilter.value;
      renderAll();
    });

    let searchTimer = null;
    elements.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = elements.search.value.trim().toLowerCase();
        renderAll();
      }, 120);
    });

    elements.autoScroll.addEventListener('change', () => {
      state.autoScroll = elements.autoScroll.checked;
      if (state.autoScroll) scrollToBottom();
    });

    elements.logList.addEventListener('scroll', () => {
      if (!state.autoScroll) return;
      const atBottom = elements.logList.scrollTop + elements.logList.clientHeight >= elements.logList.scrollHeight - 36;
      if (!atBottom) {
        state.autoScroll = false;
        elements.autoScroll.checked = false;
      }
    });

    elements.pause.addEventListener('click', () => setPaused(!state.paused));

    elements.clear.addEventListener('click', () => {
      state.logs = [];
      renderAll();
    });
  }

  setupControls();
  connect();
})();
