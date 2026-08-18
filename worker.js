const { app } = require('./app');

function parseCookies(cookieHeader = '') {
  const cookies = {};
  cookieHeader.split(';').forEach(c => {
    const [key, val] = c.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(val || '');
  });
  return cookies;
}

// Durable Object for global real-time synchronization between multiple users
export class BoardRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.boardState = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = url.pathname.slice(4).split('/')[0] || 'default-room';
    const db = this.env.eduba_db || this.env.DB;

    // Load initial board state from D1 if not yet cached in this Durable Object instance
    if (!this.boardState && db) {
      try {
        const docRow = await db
          .prepare('SELECT doc_data FROM board_docs WHERE project_id = ?')
          .bind(room)
          .first();

        if (docRow?.doc_data) {
          const raw = typeof docRow.doc_data === 'string'
            ? docRow.doc_data
            : new TextDecoder().decode(docRow.doc_data);
          try {
            JSON.parse(raw);
            this.boardState = raw;
          } catch {}
        }
      } catch (e) {
        console.error('[DO] DB load error:', e);
      }
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();

    this.sessions.add(server);

    const saveToDb = async () => {
      if (!this.boardState || !db) return;
      try {
        await db
          .prepare('INSERT INTO board_docs (project_id, doc_data, updated) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT (project_id) DO UPDATE SET doc_data = EXCLUDED.doc_data, updated = CURRENT_TIMESTAMP')
          .bind(room, this.boardState)
          .run();
      } catch (e) {
        console.error('[DO] DB save error:', e);
      }
    };

    const broadcast = (msgStr, excludeWs = null) => {
      this.sessions.forEach(ws => {
        if (ws !== excludeWs) {
          try {
            ws.send(msgStr);
          } catch (e) {
            this.sessions.delete(ws);
          }
        }
      });
    };

    // Send latest board state immediately upon connection
    server.send(JSON.stringify({ type: 'init', state: this.boardState }));

    server.addEventListener('message', event => {
      try {
        const str = typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data);

        if (!str.startsWith('{')) return;
        const data = JSON.parse(str);

        if (data.senderId) server._senderId = data.senderId;

        if (data.type === 'full_state') {
          if (this.boardState !== data.state) {
            this.boardState = data.state;
            this.state.waitUntil(saveToDb());
          }
          return;
        }

        if (data.type === 'op' || data.type === 'awareness') {
          broadcast(str, server);
        }
      } catch (e) {
        // Ignore malformed messages quietly
      }
    });

    server.addEventListener('close', () => {
      if (server._senderId) {
        broadcast(JSON.stringify({ type: 'peer_leave', senderId: server._senderId }), server);
      }
      this.sessions.delete(server);
      if (this.sessions.size === 0) {
        this.state.waitUntil(saveToDb());
      }
    });

    server.addEventListener('error', () => {
      this.sessions.delete(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Upgrade WebSocket connections on /ws/:room
    if (url.pathname.startsWith('/ws/') && request.headers.get('Upgrade') === 'websocket') {
      const room = url.pathname.slice(4).split('/')[0] || 'default-room';
      const cookieHeader = request.headers.get('Cookie') || '';
      const cookies = parseCookies(cookieHeader);
      const token = cookies.session_token;

      if (!token) {
        return new Response('Unauthorized: No session token', { status: 401 });
      }

      const db = env.eduba_db || env.DB;
      if (db) {
        const nowIso = new Date().toISOString();
        const userRes = await db
          .prepare('SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires > ?')
          .bind(token, nowIso)
          .first();

        if (!userRes) {
          return new Response('Unauthorized: Invalid or expired session', { status: 401 });
        }

        if (room !== 'default-room') {
          const accessRes = await db
            .prepare(`SELECT p.id FROM projects p
                      LEFT JOIN group_members gm ON p.group_id = gm.group_id
                      WHERE p.id = ? AND (p.owner_id = ? OR gm.user_id = ?)`)
            .bind(room, userRes.id, userRes.id)
            .first();

          if (!accessRes) {
            return new Response('Forbidden: No access to this board', { status: 403 });
          }
        }
      }

      // Route through Durable Object singleton instance per room for 100% real-time collaboration
      if (env.BOARD_ROOM) {
        const id = env.BOARD_ROOM.idFromName(room);
        const roomObj = env.BOARD_ROOM.get(id);
        return roomObj.fetch(request);
      }
    }

    return app.fetch(request, env, ctx);
  }
};
