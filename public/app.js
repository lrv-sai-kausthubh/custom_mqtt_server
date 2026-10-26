(() => {
  'use strict';

  const TOKEN_KEY = 'homelink.session';
  const BACKEND_URL_KEY = 'homelink.backendUrl';
  const CUSTOM_STATIONS_KEY = 'homelink.customStations';
  const TUNED_STATION_KEY = 'homelink.tunedStation';
  const $ = (selector) => document.querySelector(selector);

  const elements = {
    authView: $('#auth-view'), workspaceView: $('#workspace-view'), authForm: $('#auth-form'),
    authTitle: $('#auth-title'), authSubtitle: $('#auth-subtitle'), authSubmit: $('#auth-submit'),
    modeSignin: $('#mode-signin'), modeSignup: $('#mode-signup'), authMessage: $('#auth-message'),
    email: $('#email'), password: $('#password'), signout: $('#signout-button'),
    userEmail: $('#user-email'), userRole: $('#user-role'), userAvatar: $('#user-avatar'),
    stateBanner: $('#state-banner'), stateSymbol: $('#state-symbol'), stateTitle: $('#state-title'),
    stateDescription: $('#state-description'), refreshAccess: $('#refresh-access'),
    mqttPanel: $('#mqtt-panel'), brokerStatus: $('#broker-status'), publishForm: $('#publish-form'),
    topic: $('#topic'), message: $('#message'), publishButton: $('#publish-button'),
    publishMessage: $('#publish-message'), messageFeed: $('#message-feed'), clearFeed: $('#clear-feed'),
    adminPanel: $('#admin-panel'), openLogs: $('#open-logs'), reloadUsers: $('#reload-users'), userFilter: $('#user-filter'),
    usersTableBody: $('#users-table-body'), statTotal: $('#stat-total'), statPending: $('#stat-pending'),
    statApproved: $('#stat-approved'), adminMessage: $('#admin-message'), toast: $('#toast'),
    frequencyValue: $('#frequency-value'), frequencyDial: $('#frequency-dial'), stationName: $('#station-name'),
    stationTopic: $('#station-topic'), stationList: $('#station-list'), feedTopic: $('#feed-topic'),
    scanAll: $('#scan-all'), toggleCustom: $('#toggle-custom'), customForm: $('#custom-station-form'),
    customFrequency: $('#custom-frequency'), customName: $('#custom-name'), customTopic: $('#custom-topic'),
    customMessage: $('#custom-message'), signalMeter: $('#signal-meter'), tunerStatus: $('#tuner-status'),
    backendToggle: $('#backend-toggle'), backendLabel: $('#backend-label'), backendForm: $('#backend-form'),
    backendUrl: $('#backend-url'), backendMessage: $('#backend-message'), backendReset: $('#backend-reset')
  };

  const runtimeConfig = window.HOMELINK_CONFIG || {};
  const DEFAULT_STATIONS = [
    { id: 'scan', frequency: 88.1, name: 'Scan all stations', topic: 'home/#', publish: 'home/test', preset: true },
    { id: 'test', frequency: 91.3, name: 'Test signal', topic: 'home/test', publish: 'home/test', preset: true },
    { id: 'living-room', frequency: 94.7, name: 'Living room', topic: 'home/living-room/#', publish: 'home/living-room/command', preset: true },
    { id: 'kitchen', frequency: 98.1, name: 'Kitchen', topic: 'home/kitchen/#', publish: 'home/kitchen/command', preset: true },
    { id: 'bedroom', frequency: 101.5, name: 'Bedroom', topic: 'home/bedroom/#', publish: 'home/bedroom/command', preset: true },
    { id: 'security', frequency: 104.3, name: 'Security', topic: 'home/security/#', publish: 'home/security/command', preset: true },
    { id: 'energy', frequency: 107.1, name: 'Energy', topic: 'home/energy/#', publish: 'home/energy/command', preset: true }
  ];

  let authToken = window.localStorage.getItem(TOKEN_KEY) || '';
  let backendUrl = window.location.origin;
  let currentAccess = null;
  let socket = null;
  let isSignupMode = false;
  let toastTimer = null;
  let usersCache = [];
  let busy = false;
  let stations = [];
  let currentStation = null;
  let signalTimer = null;
  let tuneTimer = null;

  function setNotice(element, message, kind = '') {
    if (!element) return;
    element.textContent = message;
    element.classList.remove('hidden', 'error', 'success', 'pending');
    if (kind) element.classList.add(kind);
  }

  function hideNotice(element) {
    if (!element) return;
    element.textContent = '';
    element.classList.add('hidden');
    element.classList.remove('error', 'success', 'pending');
  }

  function showToast(message, isError = false) {
    elements.toast.textContent = message;
    elements.toast.classList.remove('hidden', 'error');
    if (isError) elements.toast.classList.add('error');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 4200);
  }

  function setSessionToken(token) {
    authToken = token || '';
    if (authToken) window.localStorage.setItem(TOKEN_KEY, authToken);
    else window.localStorage.removeItem(TOKEN_KEY);
  }

  function clearStoredSession() {
    setSessionToken('');
    currentAccess = null;
  }

  // ---------------------------------------------------------------
  // Backend URL discovery
  // ---------------------------------------------------------------

  function normalizeBaseUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch (_) {}
    return '';
  }

  async function resolveBackendUrl() {
    const saved = normalizeBaseUrl(window.localStorage.getItem(BACKEND_URL_KEY) || '');
    if (saved) return { url: saved, source: 'saved' };

    const fixed = normalizeBaseUrl(runtimeConfig.backendUrl || '');
    if (fixed) return { url: fixed, source: 'config' };

    // Local development is normally served directly by the Node backend.
    // A hosted frontend (Vercel / niat.tech) must use the discovered tunnel.
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);
    if (localHost) {
      return { url: window.location.origin, source: 'same-origin-live' };
    }

    const supabaseUrl = normalizeBaseUrl(runtimeConfig.supabaseUrl || '');
    const supabaseKey = String(runtimeConfig.supabaseAnonKey || '').trim();
    const table = String(runtimeConfig.discoveryTable || 'app_discovery').trim();

    if (supabaseUrl && supabaseKey && /^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      try {
        const response = await fetch(
          `${supabaseUrl}/rest/v1/${table}?select=backend_url,updated_at&id=eq.true&limit=1`,
          {
            headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
            cache: 'no-store'
          }
        );
        if (response.ok) {
          const rows = await response.json();
          const discovered = normalizeBaseUrl(Array.isArray(rows) && rows[0] ? rows[0].backend_url : '');
          if (discovered) return { url: discovered, source: 'discovery' };
        }
      } catch (_) {
        // Fall through to same-origin.
      }
    }

    return { url: window.location.origin, source: 'same-origin' };
  }

  function updateBackendLabel(source) {
    const sameOrigin = backendUrl === window.location.origin;
    const host = (() => {
      try { return new URL(backendUrl).host; } catch (_) { return backendUrl; }
    })();
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);

    if (!sameOrigin) elements.backendLabel.textContent = host;
    else if (source === 'same-origin-live' || localHost) elements.backendLabel.textContent = 'same origin';
    else elements.backendLabel.textContent = 'not configured';
    elements.backendUrl.value = sameOrigin ? '' : backendUrl;

    if (source === 'discovery') {
      setNotice(elements.backendMessage, `Automatically discovered ${backendUrl} from Supabase.`, 'success');
    } else if (source === 'config') {
      setNotice(elements.backendMessage, `Using the backend URL from config.js: ${backendUrl}`, 'success');
    } else if (source === 'saved') {
      setNotice(elements.backendMessage, `Using the saved backend URL: ${backendUrl}`, 'success');
    } else if (source === 'same-origin-live') {
      setNotice(elements.backendMessage, `This page is served by the backend at ${backendUrl}.`, 'success');
    } else if (!localHost) {
      setNotice(
        elements.backendMessage,
        'Automatic discovery did not find a backend URL. Paste the current Cloudflare Tunnel URL here, or set backendUrl in config.js.',
        'error'
      );
    }

    if (elements.openLogs) elements.openLogs.href = `${backendUrl}/logs.html`;
  }

  function setupBackendSettings() {
    elements.backendToggle.addEventListener('click', () => {
      elements.backendForm.classList.toggle('hidden');
    });

    elements.backendForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const url = normalizeBaseUrl(elements.backendUrl.value);
      if (!url) {
        setNotice(elements.backendMessage, 'Enter a full URL such as https://example.trycloudflare.com.', 'error');
        return;
      }
      window.localStorage.setItem(BACKEND_URL_KEY, url);
      window.location.reload();
    });

    elements.backendReset.addEventListener('click', () => {
      window.localStorage.removeItem(BACKEND_URL_KEY);
      window.location.reload();
    });
  }

  // ---------------------------------------------------------------
  // Stations and topic filters
  // ---------------------------------------------------------------

  function isValidTopicFilterClient(filter) {
    if (typeof filter !== 'string') return false;
    const topic = filter.trim();
    if (topic.length < 6 || topic.length > 128) return false;
    if (!/^home\/[A-Za-z0-9_/+#-]+$/.test(topic)) return false;
    if (topic.includes('//') || topic.endsWith('/')) return false;

    const levels = topic.split('/');
    for (let i = 0; i < levels.length; i += 1) {
      const level = levels[i];
      if (level === '#') {
        if (i !== levels.length - 1) return false;
      } else if (level.includes('#') || (level.includes('+') && level !== '+')) {
        return false;
      }
    }
    return true;
  }

  function derivePublishTopic(filter) {
    let topic = filter;
    if (topic.endsWith('/#')) topic = topic.slice(0, -2) + '/command';
    topic = topic.replace(/\+/g, 'device').replace(/#/g, 'command');
    if (
      !/^home\/[A-Za-z0-9_/-]+$/.test(topic) ||
      topic.includes('//') ||
      topic.endsWith('/') ||
      topic.length > 128
    ) {
      return 'home/test';
    }
    return topic;
  }

  function loadCustomStations() {
    try {
      const raw = JSON.parse(window.localStorage.getItem(CUSTOM_STATIONS_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((station) =>
          station &&
          typeof station.frequency === 'number' &&
          station.frequency >= 88 &&
          station.frequency <= 108 &&
          typeof station.name === 'string' &&
          typeof station.topic === 'string' &&
          isValidTopicFilterClient(station.topic)
        )
        .map((station) => ({
          id: typeof station.id === 'string' ? station.id : `custom-${station.frequency}`,
          frequency: Math.round(station.frequency * 10) / 10,
          name: station.name.slice(0, 28),
          topic: station.topic,
          publish: derivePublishTopic(station.topic),
          preset: false
        }));
    } catch (_) {
      return [];
    }
  }

  function saveCustomStations() {
    const custom = stations
      .filter((station) => !station.preset)
      .map(({ id, frequency, name, topic }) => ({ id, frequency, name, topic }));
    window.localStorage.setItem(CUSTOM_STATIONS_KEY, JSON.stringify(custom));
  }

  function loadStations() {
    stations = [...DEFAULT_STATIONS, ...loadCustomStations()].sort((a, b) => a.frequency - b.frequency);
    const savedId = window.localStorage.getItem(TUNED_STATION_KEY);
    currentStation = stations.find((station) => station.id === savedId) || stations[0];
  }

  function nearestStation(frequency) {
    return stations.reduce(
      (best, station) => (
        Math.abs(station.frequency - frequency) < Math.abs(best.frequency - frequency) ? station : best
      ),
      stations[0]
    );
  }

  function renderStations() {
    elements.stationList.replaceChildren();

    for (const station of stations) {
      const row = document.createElement('div');
      row.className = 'station-row';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'station-button';
      button.dataset.stationId = station.id;
      button.classList.toggle('active', station.id === currentStation.id);

      const frequency = document.createElement('span');
      frequency.className = 'station-freq';
      frequency.textContent = station.frequency.toFixed(1);

      const info = document.createElement('span');
      info.className = 'station-info';
      const name = document.createElement('strong');
      name.textContent = station.name;
      const topic = document.createElement('small');
      topic.textContent = station.topic;
      info.append(name, topic);

      button.append(frequency, info);
      button.addEventListener('click', () => tuneTo(station));

      row.append(button);

      if (!station.preset) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'station-delete';
        remove.title = `Remove ${station.name}`;
        remove.setAttribute('aria-label', `Remove ${station.name}`);
        remove.textContent = '×';
        remove.addEventListener('click', () => removeStation(station));
        row.append(remove);
      }

      elements.stationList.append(row);
    }
  }

  function updateTunerUI() {
    if (!currentStation) return;
    elements.frequencyValue.textContent = currentStation.frequency.toFixed(1);
    elements.frequencyDial.value = String(currentStation.frequency);
    elements.stationName.textContent = currentStation.name;
    elements.stationTopic.textContent = currentStation.topic;
    elements.feedTopic.textContent = currentStation.topic;
    elements.topic.value = currentStation.publish || derivePublishTopic(currentStation.topic);

    for (const button of elements.stationList.querySelectorAll('.station-button')) {
      button.classList.toggle('active', button.dataset.stationId === currentStation.id);
    }
  }

  function resetFeed(topic) {
    const empty = document.createElement('div');
    empty.className = 'empty-feed';
    const icon = document.createElement('span');
    icon.className = 'empty-feed-icon';
    icon.textContent = '⌁';
    const title = document.createElement('strong');
    title.textContent = 'Waiting for a signal';
    const detail = document.createElement('span');
    detail.textContent = `Tuned to ${topic}. Publish a message or wait for a device.`;
    empty.append(icon, title, detail);
    elements.messageFeed.replaceChildren(empty);
  }

  function flashSignal() {
    elements.signalMeter.classList.add('live');
    clearTimeout(signalTimer);
    signalTimer = setTimeout(() => elements.signalMeter.classList.remove('live'), 650);
  }

  function tuneTo(station) {
    if (!station) return;
    const changed = !currentStation || currentStation.id !== station.id;
    currentStation = station;
    window.localStorage.setItem(TUNED_STATION_KEY, station.id);
    updateTunerUI();

    if (changed) resetFeed(station.topic);

    if (!socket || !socket.connected) {
      elements.tunerStatus.textContent = 'Waiting for connection…';
      return;
    }

    elements.tunerStatus.textContent = 'Tuning…';
    clearTimeout(tuneTimer);
    tuneTimer = setTimeout(() => {
      if (elements.tunerStatus.textContent === 'Tuning…') elements.tunerStatus.textContent = 'No response';
    }, 5000);

    socket.timeout(5000).emit('tune', { topic: station.topic }, (timeoutError, reply) => {
      clearTimeout(tuneTimer);
      if (timeoutError) {
        elements.tunerStatus.textContent = 'No response';
        return;
      }
      if (!reply || !reply.ok) {
        elements.tunerStatus.textContent = 'Tune failed';
        showToast((reply && reply.error) || 'Could not tune this station.', true);
        return;
      }
      elements.tunerStatus.textContent = 'Receiving';
      flashSignal();
    });
  }

  function removeStation(station) {
    if (station.preset) return;
    if (!window.confirm(`Remove the custom station "${station.name}"?`)) return;

    const wasCurrent = currentStation.id === station.id;
    stations = stations.filter((entry) => entry.id !== station.id);
    saveCustomStations();

    if (wasCurrent) {
      currentStation = stations[0];
      window.localStorage.setItem(TUNED_STATION_KEY, currentStation.id);
    }
    renderStations();
    updateTunerUI();
    if (wasCurrent) tuneTo(currentStation);
  }

  function addCustomStation(event) {
    event.preventDefault();
    hideNotice(elements.customMessage);

    const rawFrequency = Number(elements.customFrequency.value);
    const frequency = Math.round(rawFrequency * 10) / 10;
    const name = elements.customName.value.trim();
    const topic = elements.customTopic.value.trim();

    if (!Number.isFinite(rawFrequency) || rawFrequency < 88 || rawFrequency > 108) {
      setNotice(elements.customMessage, 'Choose a frequency between 88.0 and 108.0.', 'error');
      return;
    }
    if (!name) {
      setNotice(elements.customMessage, 'Give the station a name.', 'error');
      return;
    }
    if (!isValidTopicFilterClient(topic)) {
      setNotice(elements.customMessage, 'Use a filter beginning with home/ (for example home/garage/#).', 'error');
      return;
    }
    if (stations.some((station) => station.topic === topic)) {
      setNotice(elements.customMessage, 'A station already uses that topic filter.', 'error');
      return;
    }
    if (stations.some((station) => Math.abs(station.frequency - frequency) < 0.3)) {
      setNotice(elements.customMessage, 'That frequency is too close to another station. Leave at least 0.3 MHz.', 'error');
      return;
    }

    const station = {
      id: `custom-${Date.now()}`,
      frequency: Math.round(frequency * 10) / 10,
      name: name.slice(0, 28),
      topic,
      publish: derivePublishTopic(topic),
      preset: false
    };

    stations = [...stations, station].sort((a, b) => a.frequency - b.frequency);
    saveCustomStations();
    renderStations();
    tuneTo(station);
    elements.customForm.reset();
    elements.customForm.classList.add('hidden');
    showToast(`Added ${station.name} at ${station.frequency.toFixed(1)} FM.`);
  }

  // ---------------------------------------------------------------
  // API and auth
  // ---------------------------------------------------------------

  async function readError(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        message: `The backend at ${backendUrl} did not return JSON (HTTP ${response.status}). Check the backend URL in connection settings.`,
        accountStatus: null
      };
    }
    let body = {};
    try { body = await response.json(); } catch (_) {}
    return {
      message: body.error || `Request failed (${response.status}).`,
      accountStatus: body.status || null
    };
  }

  async function apiFetch(path, options = {}, { handleAuthFailure = true } = {}) {
    const headers = new Headers(options.headers || {});
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    let response;
    try {
      response = await fetch(`${backendUrl}${path}`, { ...options, headers, cache: 'no-store' });
    } catch (_) {
      throw new Error(`Could not reach the backend at ${backendUrl}. Check the tunnel URL in connection settings.`);
    }

    if (!response.ok) {
      const details = await readError(response);
      if (response.status === 401 && handleAuthFailure) {
        clearStoredSession();
        showAuth('Your session expired or is no longer valid. Please sign in again.', 'error');
      }
      const error = new Error(details.message);
      error.status = response.status;
      error.accountStatus = details.accountStatus;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  function setAuthMode(signup) {
    isSignupMode = signup;
    elements.modeSignin.classList.toggle('active', !signup);
    elements.modeSignup.classList.toggle('active', signup);
    elements.modeSignin.setAttribute('aria-selected', String(!signup));
    elements.modeSignup.setAttribute('aria-selected', String(signup));
    elements.authTitle.textContent = signup ? 'Create your account' : 'Sign in';
    elements.authSubtitle.textContent = signup
      ? 'Register now. An administrator must approve your account before you can sign in.'
      : 'Only accounts approved by an administrator can sign in.';
    elements.authSubmit.innerHTML = signup
      ? '<span>Create account</span><span aria-hidden="true">→</span>'
      : '<span>Sign in</span><span aria-hidden="true">→</span>';
    elements.password.autocomplete = signup ? 'new-password' : 'current-password';
    hideNotice(elements.authMessage);
  }

  function showAuth(message = '', kind = '') {
    disconnectSocket();
    currentAccess = null;
    elements.authView.classList.remove('hidden');
    elements.workspaceView.classList.add('hidden');
    elements.mqttPanel.classList.add('hidden');
    elements.adminPanel.classList.add('hidden');
    if (message) setNotice(elements.authMessage, message, kind);
    else hideNotice(elements.authMessage);
  }

  function accountStatusNotice(status) {
    if (status === 'rejected') {
      return 'Your account access was not approved. Contact the administrator if you believe this is a mistake.';
    }
    return 'Your application is still pending administrator approval. You cannot sign in until it is approved. No email is sent; try signing in again later.';
  }

  function setState(status, role) {
    elements.stateBanner.classList.remove('approved', 'rejected');
    elements.mqttPanel.classList.add('hidden');
    elements.adminPanel.classList.add('hidden');

    if (status === 'approved') {
      elements.stateBanner.classList.add('approved');
      elements.stateSymbol.textContent = '✓';
      elements.stateTitle.textContent = 'Access approved';
      elements.stateDescription.textContent = 'Your account is approved. Tune a station below to receive MQTT messages.';
      elements.mqttPanel.classList.remove('hidden');
      connectSocket();
      if (role === 'admin') {
        elements.adminPanel.classList.remove('hidden');
        loadAdminUsers().catch((error) => setNotice(elements.adminMessage, error.message, 'error'));
      }
    } else if (status === 'rejected') {
      elements.stateBanner.classList.add('rejected');
      elements.stateSymbol.textContent = '×';
      elements.stateTitle.textContent = 'Access not approved';
      elements.stateDescription.textContent = accountStatusNotice('rejected');
      disconnectSocket();
    } else {
      elements.stateSymbol.textContent = '…';
      elements.stateTitle.textContent = 'Waiting for administrator approval';
      elements.stateDescription.textContent = accountStatusNotice('pending');
      disconnectSocket();
    }
  }

  async function loadWorkspace() {
    if (!authToken) {
      showAuth();
      return;
    }
    elements.authView.classList.add('hidden');
    elements.workspaceView.classList.remove('hidden');
    elements.userEmail.textContent = 'Checking account…';
    elements.userRole.textContent = 'Verifying access';
    elements.userAvatar.textContent = '…';
    elements.refreshAccess.disabled = true;
    try {
      const result = await apiFetch('/api/access/me');
      currentAccess = result;
      elements.userEmail.textContent = result.user.email || 'Signed-in user';
      elements.userRole.textContent = result.role === 'admin' ? 'Administrator' : 'Standard account';
      elements.userAvatar.textContent = (result.user.email || 'U').trim().charAt(0).toUpperCase();
      setState(result.status, result.role);
    } catch (error) {
      if (error.status === 401) return;
      if (error.accountStatus) {
        clearStoredSession();
        showAuth(accountStatusNotice(error.accountStatus), error.accountStatus === 'rejected' ? 'error' : 'pending');
        return;
      }
      elements.stateSymbol.textContent = '!';
      elements.stateTitle.textContent = 'Could not check account access';
      elements.stateDescription.textContent = error.message;
      showToast(error.message, true);
    } finally {
      elements.refreshAccess.disabled = false;
    }
  }

  // ---------------------------------------------------------------
  // Socket / radio receiver
  // ---------------------------------------------------------------

  function disconnectSocket() {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
    setBrokerStatus(false, 'Not connected');
    if (elements.tunerStatus) elements.tunerStatus.textContent = 'Off air';
  }

  function setBrokerStatus(isOnline, label) {
    elements.brokerStatus.classList.toggle('status-online', isOnline);
    elements.brokerStatus.classList.toggle('status-offline', !isOnline);
    elements.brokerStatus.innerHTML = `<span class="status-dot"></span><span>${label}</span>`;
  }

  function connectSocket() {
    if (!authToken || !window.io || !currentAccess || currentAccess.status !== 'approved' || socket) return;
    setBrokerStatus(false, 'Connecting…');
    socket = window.io(backendUrl, { auth: { token: authToken } });

    socket.on('connect', () => {
      setBrokerStatus(true, 'Backend connected');
      if (currentStation) tuneTo(currentStation);
    });

    socket.on('disconnect', () => {
      setBrokerStatus(false, 'Disconnected');
      elements.tunerStatus.textContent = 'Off air';
    });

    socket.on('connect_error', (error) => {
      setBrokerStatus(false, 'Access/connection error');
      elements.tunerStatus.textContent = 'Off air';
      showToast(error.message || 'The live connection could not be authorized.', true);
      if (socket) {
        socket.disconnect();
        socket = null;
      }
    });

    socket.on('access-revoked', (payload) => {
      clearStoredSession();
      showAuth(accountStatusNotice(payload && payload.status), 'error');
    });

    socket.on('tuned', () => {
      elements.tunerStatus.textContent = socket && socket.connected ? 'Receiving' : 'Off air';
    });

    socket.on('mqtt-status', (status) => {
      setBrokerStatus(status === 'connected', status === 'connected' ? 'Broker connected' : 'Broker disconnected');
      if (status !== 'connected') elements.tunerStatus.textContent = 'Broker offline';
    });

    socket.on('mqtt-message', (entry) => {
      addMessage(entry.topic, entry.message, entry.receivedAt);
      flashSignal();
    });
  }

  function addMessage(topic, message, receivedAt = new Date().toISOString()) {
    const empty = elements.messageFeed.querySelector('.empty-feed');
    if (empty) empty.remove();

    const card = document.createElement('article');
    card.className = 'message-entry';
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const topicEl = document.createElement('span');
    topicEl.className = 'message-topic';
    topicEl.textContent = topic || '(unknown topic)';
    const timeEl = document.createElement('time');
    const date = new Date(receivedAt || Date.now());
    timeEl.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
    meta.append(topicEl, timeEl);

    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = String(message ?? '');

    card.append(meta, body);
    elements.messageFeed.prepend(card);
    while (elements.messageFeed.children.length > 50) elements.messageFeed.lastElementChild.remove();
  }

  // ---------------------------------------------------------------
  // Sign in / sign out
  // ---------------------------------------------------------------

  async function submitAuth(event) {
    event.preventDefault();
    if (busy) return;
    hideNotice(elements.authMessage);

    const email = elements.email.value.trim();
    const password = elements.password.value;
    if (password.length < 8) {
      setNotice(elements.authMessage, 'Use a password with at least 8 characters.', 'error');
      return;
    }

    busy = true;
    elements.authSubmit.disabled = true;
    elements.authSubmit.textContent = isSignupMode ? 'Creating account…' : 'Signing in…';

    try {
      const result = await apiFetch(
        isSignupMode ? '/api/auth/register' : '/api/auth/login',
        { method: 'POST', body: JSON.stringify({ email, password }) },
        { handleAuthFailure: false }
      );

      if (isSignupMode) {
        setAuthMode(false);
        elements.email.value = email;
        elements.password.value = '';
        setNotice(
          elements.authMessage,
          result.message || 'Account created. An administrator must approve it before you can sign in.',
          'pending'
        );
      } else {
        setSessionToken(result.token);
        elements.password.value = '';
        await loadWorkspace();
      }
    } catch (error) {
      if (error.accountStatus === 'pending') {
        setNotice(elements.authMessage, accountStatusNotice('pending'), 'pending');
      } else if (error.accountStatus === 'rejected') {
        setNotice(elements.authMessage, accountStatusNotice('rejected'), 'error');
      } else {
        setNotice(elements.authMessage, error.message || 'Could not complete authentication.', 'error');
      }
    } finally {
      busy = false;
      elements.authSubmit.disabled = false;
      elements.authSubmit.innerHTML = isSignupMode
        ? '<span>Create account</span><span aria-hidden="true">→</span>'
        : '<span>Sign in</span><span aria-hidden="true">→</span>';
    }
  }

  async function signOut() {
    const token = authToken;
    clearStoredSession();
    disconnectSocket();
    showAuth();
    elements.email.value = '';
    elements.password.value = '';
    setAuthMode(false);
    if (!token) return;
    try {
      await fetch(`${backendUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch (_) {
      // The local session is already cleared; an unreachable server will expire it later.
    }
  }

  async function refreshAccess() {
    if (!authToken) {
      showAuth('Please sign in again to check your access.', 'error');
      return;
    }
    await loadWorkspace();
  }

  // ---------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------

  function statusBadge(status) {
    const span = document.createElement('span');
    span.className = `badge-status badge-${status}`;
    span.textContent = status;
    return span;
  }

  function renderAdminUsers() {
    const filter = elements.userFilter.value;
    const filtered = filter === 'all' ? usersCache : usersCache.filter((user) => user.status === filter);
    elements.usersTableBody.replaceChildren();
    elements.statTotal.textContent = String(usersCache.length);
    elements.statPending.textContent = String(usersCache.filter((user) => user.status === 'pending').length);
    elements.statApproved.textContent = String(usersCache.filter((user) => user.status === 'approved').length);
    if (!filtered.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'table-empty';
      td.textContent = filter === 'pending' ? 'No pending accounts. Nice and tidy.' : 'No accounts match this filter.';
      tr.append(td);
      elements.usersTableBody.append(tr);
      return;
    }
    for (const user of filtered) {
      const tr = document.createElement('tr');
      const accountTd = document.createElement('td');
      const email = document.createElement('strong');
      email.textContent = user.email || '(email unavailable)';
      const id = document.createElement('span');
      id.className = 'user-id';
      id.textContent = user.user_id;
      accountTd.append(email, id);
      const statusTd = document.createElement('td');
      statusTd.append(statusBadge(user.status));
      const createdTd = document.createElement('td');
      createdTd.textContent = formatDate(user.created_at);
      const reviewedTd = document.createElement('td');
      reviewedTd.textContent = formatDate(user.reviewed_at);
      const actionTd = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'action-group';
      if (user.status !== 'approved') {
        actions.append(makeActionButton('Approve', 'button-approve', () => updateApproval(user.user_id, 'approved')));
      }
      if (user.status !== 'rejected') {
        actions.append(makeActionButton('Reject', 'button-reject', () => updateApproval(user.user_id, 'rejected')));
      }
      if (!actions.children.length) actions.textContent = 'No action';
      actionTd.append(actions);
      tr.append(accountTd, statusTd, createdTd, reviewedTd, actionTd);
      elements.usersTableBody.append(tr);
    }
  }

  function makeActionButton(label, className, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button button-small ${className}`;
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function loadAdminUsers() {
    elements.reloadUsers.disabled = true;
    elements.usersTableBody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading access requests…</td></tr>';
    hideNotice(elements.adminMessage);
    try {
      const result = await apiFetch('/api/admin/users');
      usersCache = Array.isArray(result.users) ? result.users : [];
      renderAdminUsers();
    } catch (error) {
      setNotice(elements.adminMessage, error.message, 'error');
      elements.usersTableBody.innerHTML = '<tr><td colspan="5" class="table-empty">Could not load accounts.</td></tr>';
      if (/administrator access/i.test(error.message)) showToast('The signed-in account is not authorized as an administrator.', true);
    } finally {
      elements.reloadUsers.disabled = false;
    }
  }

  async function updateApproval(userId, status) {
    const user = usersCache.find((entry) => entry.user_id === userId);
    const label = user?.email || 'this account';
    if (!window.confirm(`${status === 'approved' ? 'Approve' : 'Reject'} ${label}?`)) return;
    try {
      await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/approval`, {
        method: 'PATCH', body: JSON.stringify({ status })
      });
      setNotice(elements.adminMessage, `${label} was ${status}.`, 'success');
      await loadAdminUsers();
    } catch (error) {
      setNotice(elements.adminMessage, error.message, 'error');
    }
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------

  function setupUI() {
    elements.modeSignin.addEventListener('click', () => setAuthMode(false));
    elements.modeSignup.addEventListener('click', () => setAuthMode(true));
    elements.authForm.addEventListener('submit', submitAuth);
    elements.signout.addEventListener('click', signOut);
    elements.refreshAccess.addEventListener('click', refreshAccess);
    elements.reloadUsers.addEventListener('click', () => loadAdminUsers().catch((error) => setNotice(elements.adminMessage, error.message, 'error')));
    elements.userFilter.addEventListener('change', renderAdminUsers);

    elements.frequencyDial.addEventListener('input', () => {
      const station = nearestStation(Number(elements.frequencyDial.value));
      if (station && (!currentStation || station.id !== currentStation.id)) tuneTo(station);
      else if (currentStation) elements.frequencyDial.value = String(currentStation.frequency);
    });

    elements.scanAll.addEventListener('click', () => {
      const scan = stations.find((station) => station.id === 'scan') || stations.find((station) => station.topic === 'home/#');
      if (scan) tuneTo(scan);
    });

    elements.toggleCustom.addEventListener('click', () => {
      elements.customForm.classList.toggle('hidden');
      if (!elements.customForm.classList.contains('hidden')) elements.customFrequency.focus();
    });

    elements.customForm.addEventListener('submit', addCustomStation);

    elements.clearFeed.addEventListener('click', () => resetFeed(currentStation ? currentStation.topic : 'home/#'));

    elements.publishForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!socket || !socket.connected) {
        elements.publishMessage.textContent = 'The live connection is not ready. Check the backend/broker status.';
        elements.publishMessage.className = 'inline-message error';
        return;
      }
      const topic = elements.topic.value.trim();
      const message = elements.message.value;
      elements.publishButton.disabled = true;
      elements.publishMessage.textContent = 'Transmitting…';
      elements.publishMessage.className = 'inline-message';
      socket.timeout(5000).emit('publish-message', { topic, message }, (timeoutError, reply) => {
        elements.publishButton.disabled = false;
        if (timeoutError) {
          elements.publishMessage.textContent = 'No confirmation from the backend. Check the connection.';
          elements.publishMessage.className = 'inline-message error';
        } else if (!reply?.ok) {
          elements.publishMessage.textContent = reply?.error || 'Publish failed.';
          elements.publishMessage.className = 'inline-message error';
        } else {
          elements.publishMessage.textContent = 'Accepted by the MQTT broker.';
          elements.publishMessage.className = 'inline-message success';
          elements.message.value = '';
          showToast('Message transmitted.');
        }
      });
    });
  }

  async function init() {
    setupUI();
    setupBackendSettings();

    const resolved = await resolveBackendUrl();
    backendUrl = resolved.url;
    updateBackendLabel(resolved.source);

    loadStations();
    renderStations();
    updateTunerUI();
    resetFeed(currentStation.topic);

    if (authToken) await loadWorkspace();
    else showAuth();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
