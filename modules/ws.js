const db = require('./db');
const Y = require('yjs');
const syncProtocol = require('y-protocols/sync');
const awarenessProtocol = require('y-protocols/awareness');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');

module.exports = fastify => {
  // In-memory rooms: roomId -> { clients: Set<ws>, ydoc: Y.Doc, awareness: Awareness, state: string|null, saveTimer, dirty }
  const rooms = new Map();

  const getOrCreateRoom = async (room) => {
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
          // Check if JSON state
          JSON.parse(rawStr);
          roomData.state = rawStr;
        } catch {
          // Try Yjs binary update
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
  };

  const saveRoom = async room => {
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

    await db.query(
      'INSERT INTO board_docs (project_id, doc_data, updated) VALUES ($1, $2, now()) ON CONFLICT (project_id) DO UPDATE SET doc_data = EXCLUDED.doc_data, updated = now()',
      [room, data]
    );
    roomData.dirty = false;
  };

  const scheduleSave = room => {
    const roomData = rooms.get(room);
    if (!roomData) return;
    roomData.dirty = true;
    clearTimeout(roomData.saveTimer);
    roomData.saveTimer = setTimeout(
      () => saveRoom(room).catch(e => console.error(`[board:${room}] save failed`, e)),
      2000
    );
  };

  const broadcastJSON = (room, msgStr, excludeWs = null) => {
    const roomData = rooms.get(room);
    if (!roomData) return;
    roomData.clients.forEach(client => {
      if (client !== excludeWs && client.readyState === 1) {
        client.send(msgStr);
      }
    });
  };

  fastify.register(async app => {
    app.get('/ws/:room', { websocket: true }, async (socket, request) => {
      const ws = socket.socket || socket;
      const room = request.params.room;

      const token = request.cookies?.session_token;
      if (!token) {
        ws.close(4001, 'Unauthorized: No session token');
        return;
      }

      const userRes = await db.query(
        'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = $1 AND s.expires > now()',
        [token]
      );
      if (!userRes.rows[0]) {
        ws.close(4001, 'Unauthorized: Invalid or expired session');
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
          ws.close(4003, 'Forbidden: You do not have access to this board');
          return;
        }
      }

      const roomData = await getOrCreateRoom(room);
      roomData.clients.add(ws);

      // Send initial board state to newly connected client
      ws.send(JSON.stringify({ type: 'init', state: roomData.state }));

      ws.on('message', rawMsg => {
        try {
          if (Buffer.isBuffer(rawMsg) || rawMsg instanceof Uint8Array || rawMsg instanceof ArrayBuffer) {
            // Binary Yjs frame support
            const uint8 = new Uint8Array(rawMsg);
            if (uint8.length > 0 && uint8[0] === 0) {
              const decoder = decoding.createDecoder(uint8);
              decoding.readVarUint(decoder); // messageSync = 0
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
          // Ignore malformed frames quietly
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
  });
};
