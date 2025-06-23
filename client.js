// @path: public/client.js
document.addEventListener('DOMContentLoaded', () => {
    // ++ CAMBIO APLICADO AQUÍ ++
    const API_BASE_URL = 'http://22.ip.gl.ply.gg:18880';

    // --- State Management ---
    const state = {
        sessionId: localStorage.getItem('sessionId'),
        socket: null,
        chats: [],
        messages: {},
        activeJid: null,
        pollingInterval: null,
    };

    // --- DOM Elements ---
    const dom = {
        loginView: document.getElementById('login-view'),
        chatView: document.getElementById('chat-view'),
        loginStatus: document.getElementById('login-status'),
        qrImage: document.getElementById('qr-image'),
        sessionIdInput: document.getElementById('session-id-input'),
        connectSessionBtn: document.getElementById('connect-session-btn'),
        logoutBtn: document.getElementById('logout-btn'),
        chatList: document.getElementById('chat-list'),
        chatWelcome: document.getElementById('chat-welcome'),
        chatArea: document.getElementById('chat-area'),
        chatHeader: {
            avatar: document.getElementById('chat-avatar'),
            name: document.getElementById('chat-name'),
        },
        syncHistoryBtn: document.getElementById('sync-history-btn'),
        messageList: document.getElementById('message-list'),
        messageInput: document.getElementById('message-input'),
        sendBtn: document.getElementById('send-btn'),
    };

    // --- API Client ---
    const api = {
        async request(endpoint, options = {}) {
            const headers = { 'Content-Type': 'application/json', ...options.headers };
            if (state.sessionId) {
                headers['Authorization'] = `Bearer ${state.sessionId}`;
            }
            try {
                const response = await fetch(`${API_BASE_URL}${endpoint}`, { ...options, headers });
                if (!response.ok) {
                    if (response.status === 401) {
                         // Session expired or invalid
                        handleLogout();
                    }
                    const error = await response.json().catch(() => ({ error: 'Request failed' }));
                    throw new Error(error.error || `HTTP error! status: ${response.status}`);
                }
                // Handle responses with no content
                if (response.status === 204) {
                    return null;
                }
                return response.json();
            } catch (error) {
                console.error(`API Error on ${endpoint}:`, error);
                throw error;
            }
        },
        createSession: () => api.request('/session/create', { method: 'POST' }),
        getSessionStatus: () => api.request('/session/status'),
        getChats: () => api.request('/chats'),
        getHistory: (jid) => api.request(`/history/${encodeURIComponent(jid)}`),
        syncHistory: (jid) => api.request(`/history/sync/${encodeURIComponent(jid)}`, { method: 'POST' }),
        sendText: (jid, text) => api.request('/send/text', {
            method: 'POST',
            body: JSON.stringify({ jid, text }),
        }),
    };

    // --- UI Rendering ---
    const render = {
        login: (status, qr) => {
            dom.loginStatus.textContent = status;
            dom.qrImage.style.display = qr ? 'block' : 'none';
            dom.qrImage.src = qr || '';
            dom.loginView.classList.add('active');
            dom.chatView.classList.remove('active');
        },
        chatList: () => {
            dom.chatList.innerHTML = '';
            state.chats.sort((a, b) => (b.last_message_timestamp || 0) - (a.last_message_timestamp || 0));
            state.chats.forEach(chat => {
                const item = document.createElement('div');
                item.className = 'chat-item';
                item.dataset.jid = chat.jid;
                if (chat.jid === state.activeJid) {
                    item.classList.add('active');
                }
                item.innerHTML = `
                    <img src="${API_BASE_URL}/avatar/${chat.jid}" class="chat-item-avatar" alt="Avatar">
                    <div class="chat-item-info">
                        <div class="chat-item-header">
                            <span class="chat-item-name">${chat.name || chat.jid}</span>
                            <span class="chat-item-timestamp">${formatTimestamp(chat.last_message_timestamp, true)}</span>
                        </div>
                        <div class="chat-item-preview">
                            <span class="chat-item-last-message">${chat.last_message || ''}</span>
                            ${chat.unreadCount > 0 ? `<span class="unread-badge">${chat.unreadCount}</span>` : ''}
                        </div>
                    </div>
                `;
                item.addEventListener('click', () => selectChat(chat.jid));
                dom.chatList.appendChild(item);
            });
        },
        chatArea: (jid) => {
            const chat = state.chats.find(c => c.jid === jid);
            if (!chat) return;

            dom.chatWelcome.style.display = 'none';
            dom.chatArea.style.display = 'flex';

            dom.chatHeader.name.textContent = chat.name || chat.jid;
            dom.chatHeader.avatar.src = `${API_BASE_URL}/avatar/${jid}`;
            dom.messageList.innerHTML = '';

            const messages = state.messages[jid] || [];
            messages.forEach(msg => render.message(msg));
            scrollToBottom();
        },
        message: (msg, prepend = false) => {
            const container = document.createElement('div');
            container.className = `message-container ${msg.isOutgoing ? 'outgoing' : 'incoming'}`;
            container.dataset.id = msg.id;

            container.innerHTML = `
                <div class="message-bubble ${msg.isOutgoing ? 'outgoing' : 'incoming'}">
                    ${msg.text}
                </div>
                <div class="message-meta">
                    <span class="timestamp">${formatTimestamp(msg.timestamp)}</span>
                    ${msg.isOutgoing ? `<span class="status-icon">${getStatusIcon(msg.status)}</span>` : ''}
                </div>
            `;

            if (prepend) {
                 dom.messageList.prepend(container);
            } else {
                 dom.messageList.appendChild(container);
            }
        },
    };

    // --- Event Handlers & Logic ---
    function init() {
        if (state.sessionId) {
            checkSessionStatus();
        } else {
            startLoginFlow();
        }
        setupEventListeners();
    }

    function setupEventListeners() {
        dom.connectSessionBtn.addEventListener('click', () => {
            const sid = dom.sessionIdInput.value.trim();
            if (sid) {
                setSession(sid);
                checkSessionStatus();
            }
        });
        dom.logoutBtn.addEventListener('click', handleLogout);
        dom.sendBtn.addEventListener('click', sendMessage);
        dom.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });
        dom.syncHistoryBtn.addEventListener('click', syncHistory);
    }
    
    async function startLoginFlow() {
        try {
            render.login('Creating a new session...');
            const { sessionId } = await api.createSession();
            setSession(sessionId);
            render.login('Waiting for QR Code...');
            pollForConnection();
        } catch (error) {
            render.login(`Error: ${error.message}. Retrying...`, null);
            setTimeout(startLoginFlow, 5000);
        }
    }

    function checkSessionStatus() {
        if (state.pollingInterval) clearInterval(state.pollingInterval);
        render.login('Authenticating session...', null);

        api.getSessionStatus().then(status => {
            if (status.connected) {
                loadMainApp();
            } else {
                render.login('Scan QR to connect', status.qr);
                pollForConnection();
            }
        }).catch(error => {
            render.login(`Session invalid: ${error.message}. Please create a new one.`, null);
            setSession(null); // Clear invalid session
        });
    }
    
    function pollForConnection() {
        if (state.pollingInterval) clearInterval(state.pollingInterval);
        state.pollingInterval = setInterval(async () => {
            try {
                const status = await api.getSessionStatus();
                if (status.connected) {
                    clearInterval(state.pollingInterval);
                    loadMainApp();
                } else {
                    render.login('Scan QR to connect', status.qr);
                }
            } catch (error) {
                clearInterval(state.pollingInterval);
                render.login(`Polling error: ${error.message}.`, null);
            }
        }, 5000);
    }

    async function loadMainApp() {
        if (state.pollingInterval) clearInterval(state.pollingInterval);
        dom.loginView.classList.remove('active');
        dom.chatView.classList.add('active');
        
        initSocket();

        try {
            state.chats = await api.getChats();
            render.chatList();
        } catch (error) {
            console.error('Failed to load chats:', error);
            alert(`Could not load chats: ${error.message}`);
        }
    }
    
    async function selectChat(jid) {
        state.activeJid = jid;
        document.querySelectorAll('.chat-item.active').forEach(el => el.classList.remove('active'));
        document.querySelector(`.chat-item[data-jid="${jid}"]`).classList.add('active');
        
        render.chatArea(jid);

        try {
            const messages = await api.getHistory(jid);
            state.messages[jid] = messages;
            render.chatArea(jid); // Re-render with messages
        } catch(error) {
            alert(`Failed to load history for ${jid}: ${error.message}`);
        }
    }
    
    async function sendMessage() {
        const text = dom.messageInput.value.trim();
        if (!text || !state.activeJid) return;

        dom.messageInput.value = '';
        const tempId = `temp_${Date.now()}`;
        
        // Optimistic UI update
        const optimisticMessage = {
            id: tempId,
            jid: state.activeJid,
            text,
            isOutgoing: true,
            status: 'sending',
            timestamp: Date.now(),
        };
        state.messages[state.activeJid].push(optimisticMessage);
        render.message(optimisticMessage);
        scrollToBottom();

        try {
            const { messageId } = await api.sendText(state.activeJid, text);
            // Replace temporary message with final one from server
            const finalMessage = state.messages[state.activeJid].find(m => m.id === tempId);
            if (finalMessage) {
                finalMessage.id = messageId;
                finalMessage.status = 'sent';
                document.querySelector(`.message-container[data-id="${tempId}"]`)?.setAttribute('data-id', messageId);
                const statusEl = document.querySelector(`.message-container[data-id="${messageId}"] .status-icon`);
                if(statusEl) statusEl.innerHTML = getStatusIcon('sent');
            }
        } catch (error) {
            alert(`Failed to send message: ${error.message}`);
            // Mark message as failed
            const failedMessage = state.messages[state.activeJid].find(m => m.id === tempId);
            if (failedMessage) {
                failedMessage.status = 'failed';
                 const statusEl = document.querySelector(`.message-container[data-id="${tempId}"] .status-icon`);
                if(statusEl) statusEl.innerHTML = getStatusIcon('failed');
            }
        }
    }

    async function syncHistory() {
        if (!state.activeJid) return;
        dom.syncHistoryBtn.disabled = true;
        dom.syncHistoryBtn.textContent = 'Syncing...';
        try {
            const { message } = await api.syncHistory(state.activeJid);
            alert(message);
            // Reload history to see changes
            await selectChat(state.activeJid);
        } catch (error) {
            alert(`Failed to sync older messages: ${error.message}`);
        } finally {
            dom.syncHistoryBtn.disabled = false;
            dom.syncHistoryBtn.textContent = 'Sync History';
        }
    }
    
    function initSocket() {
        if (state.socket) state.socket.disconnect();
        
        state.socket = io(API_BASE_URL, { auth: { token: state.sessionId } });
        
        state.socket.on('connect', () => console.log('Socket connected'));
        state.socket.on('disconnect', () => console.log('Socket disconnected'));
        
        state.socket.on('whatsapp-message', (newMessages) => {
            // It's an array, but usually contains one message from live events
            newMessages.forEach(msg => {
                const { jid } = msg;
                if (!state.messages[jid]) state.messages[jid] = [];
                state.messages[jid].push(msg);
                
                // Update chat list
                const chat = state.chats.find(c => c.jid === jid);
                if (chat) {
                    chat.last_message = msg.text || msg.type;
                    chat.last_message_timestamp = msg.timestamp;
                    if (jid !== state.activeJid) {
                        chat.unreadCount = (chat.unreadCount || 0) + 1;
                    }
                    render.chatList();
                }

                if (jid === state.activeJid) {
                    render.message(msg);
                    scrollToBottom();
                }
            });
        });
        
        state.socket.on('whatsapp-message-status-update', ({ id, status }) => {
            for (const jid in state.messages) {
                const msg = state.messages[jid].find(m => m.id === id);
                if (msg) {
                    msg.status = status;
                    const statusEl = document.querySelector(`.message-container[data-id="${id}"] .status-icon`);
                    if(statusEl) statusEl.innerHTML = getStatusIcon(status);
                    break;
                }
            }
        });
        
        // Note: Reaction UI is not implemented in this version, but listener is here
        state.socket.on('whatsapp-reaction-update', ({ id, jid, reactions }) => {
            console.log(`Reaction for message ${id} in chat ${jid}:`, reactions);
        });
    }

    function setSession(id) {
        state.sessionId = id;
        if (id) {
            localStorage.setItem('sessionId', id);
        } else {
            localStorage.removeItem('sessionId');
        }
    }

    function handleLogout() {
        if (state.socket) state.socket.disconnect();
        if (state.pollingInterval) clearInterval(state.pollingInterval);
        setSession(null);
        state.chats = [];
        state.messages = {};
        state.activeJid = null;
        dom.chatWelcome.style.display = 'flex';
        dom.chatArea.style.display = 'none';
        startLoginFlow();
    }

    // --- Helpers ---
    function formatTimestamp(ts, isPreview = false) {
        if (!ts) return '';
        const date = new Date(ts);
        const today = new Date();
        const isSameDay = date.toDateString() === today.toDateString();

        if (isPreview) {
            return isSameDay
                ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : date.toLocaleDateString();
        }
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function getStatusIcon(status) {
        switch (status) {
            case 'sending': return '🕒';
            case 'sent': return '✔️';
            case 'delivered': return '✔️✔️';
            case 'read': return '<span style="color: #53bdeb;">✔️✔️</span>';
            case 'failed': return '❌';
            default: return '';
        }
    }

    function scrollToBottom() {
        dom.messageList.scrollTop = dom.messageList.scrollHeight;
    }

    init();
});
