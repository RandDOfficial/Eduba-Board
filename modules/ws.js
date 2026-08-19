const { WebSocketServer } = require('ws');
const db = require('./db');
const { cleanupRemovedUploads } = require('./upload');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

// In-memory rooms: roomId -> { clients: Set<ws>, ydoc: Y.Doc, awareness: Awareness, state: string|null, saveTimer, dirty }
const rooms = new Map();

async function getOrCreateRoom(room) {
  if (rooms.has(room)) return rooms.get(room);

  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  const roomData = {
    clients: new Set(),
    ydoc,
    awareness,
    state: null,
    saveTimer: null,
    dirty: false
  };

  // Load initial state from database
  try {
    const { rows } = await db.query('SELECT doc_data FROM board_docs WHERE project_id = $1', [room]);
    if (rows[0]?.doc_data) {
      const buffer = Buffer.isBuffer(rows[0].doc_data) ? rows[0].doc_data : Buffer.from(rows[0].doc_data);
      const rawStr = buffer.toString('utf8');
      try {
        JSON.parse(rawStr);
        roomData.state = rawStr;
      } catch {
        try {
          Y.applyUpdate(ydoc, new Uint8Array(buffer));
        } catch (e) {
          console.warn(`[board:${room}] initial doc load error`, e);
        }
      }
    }
  } catch (e) {
    console.error(`[board:${room}] DB load failed`, e);
  }

  rooms.set(room, roomData);
  return roomData;
}

async function saveRoom(room) {
  const roomData = rooms.get(room);
  if (!roomData) return;

  let data = null;
  if (roomData.state) {
    data = Buffer.from(roomData.state, 'utf8');
  } else if (roomData.ydoc) {
    const update = Y.encodeStateAsUpdate(roomData.ydoc);
    data = Buffer.from(update);
  }

  if (!data) return;

  try {
    const { rows } = await db.query('SELECT doc_data FROM board_docs WHERE project_id = $1', [room]);
    const oldData = rows[0]?.doc_data;
    if (oldData) {
      await cleanupRemovedUploads(oldData, data, room);
    }
  } catch (e) {
    console.warn(`[board:${room}] upload cleanup check failed`, e);
  }

  await db.query(
    'INSERT INTO board_docs (project_id, doc_data, updated) VALUES ($1, $2, CURRENT_TIMESTAMP) ON CONFLICT (project_id) DO UPDATE SET doc_data = EXCLUDED.doc_data, updated = CURRENT_TIMESTAMP',
    [room, data]
  );
  roomData.dirty = false;
}

function scheduleSave(room) {
  const roomData = rooms.get(room);
  if (!roomData) return;
  roomData.dirty = true;
  clearTimeout(roomData.saveTimer);
  roomData.saveTimer = setTimeout(
    () => saveRoom(room).catch(e => console.error(`[board:${room}] save failed`, e)),
    800
  );
}

function broadcastJSON(room, msgStr, excludeWs = null) {
  const roomData = rooms.get(room);
  if (!roomData) return;
  roomData.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(msgStr);
    }
  });
}

function parseCookies(cookieHeader = '') {
  const cookies = {};
  cookieHeader.split(';').forEach(c => {
    const [key, val] = c.trim().split('=');
    if (key) cookies[key] = decodeURIComponent(val || '');
  });
  return cookies;
}

function setupWebSocketHandler(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/ws/')) {
        socket.destroy();
        return;
      }

      const room = url.pathname.slice(4).split('/')[0] || 'default-room';
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.session_token;

      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const userRes = await db.query(
        'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = $1 AND s.expires > $2',
        [token, new Date().toISOString()]
      );
      if (!userRes.rows[0]) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const user = userRes.rows[0];

      if (room !== 'default-room') {
        const accessRes = await db.query(
          `SELECT p.id FROM projects p
           LEFT JOIN group_members gm ON p.group_id = gm.group_id
           WHERE p.id = $1 AND (p.owner_id = $2 OR gm.user_id = $2)`,
          [room, user.id]
        );
        if (!accessRes.rows[0]) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(req, socket, head, async (ws) => {
        const roomData = await getOrCreateRoom(room);
        roomData.clients.add(ws);

        // Send initial board state to newly connected client
        ws.send(JSON.stringify({ type: 'init', state: roomData.state }));

        ws.on('message', rawMsg => {
          try {
            if (Buffer.isBuffer(rawMsg) || rawMsg instanceof Uint8Array || rawMsg instanceof ArrayBuffer) {
              const uint8 = new Uint8Array(rawMsg);
              if (uint8.length > 0 && uint8[0] === 0) {
                const decoder = decoding.createDecoder(uint8);
                decoding.readVarUint(decoder);
                syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), roomData.ydoc, null);
                scheduleSave(room);
                return;
              }
            }

            const str = rawMsg.toString();
            if (!str.startsWith('{')) return;
            const data = JSON.parse(str);

            if (data.senderId) ws._senderId = data.senderId;

            if (data.type === 'full_state') {
              roomData.state = data.state;
              scheduleSave(room);
              return;
            }

            if (data.type === 'op' || data.type === 'awareness') {
              broadcastJSON(room, str, ws);
            }
          } catch (e) {
            // Ignore malformed messages quietly
          }
        });

        ws.on('close', () => {
          if (ws._senderId) {
            broadcastJSON(room, JSON.stringify({ type: 'peer_leave', senderId: ws._senderId }), ws);
          }
          roomData.clients.delete(ws);
          if (roomData.dirty) {
            saveRoom(room).catch(e => console.error(`[board:${room}] close-save failed`, e));
          }
          if (roomData.clients.size === 0) {
            rooms.delete(room);
          }
        });

        ws.on('error', e => {
          console.error(`[board:${room}] ws error`, e);
          roomData.clients.delete(ws);
        });
      });
    } catch (err) {
      console.error('[ws] upgrade error:', err);
      socket.destroy();
    }
  });
}

module.exports = {
  setupWebSocketHandler
};
