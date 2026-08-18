const db = require('./db');

module.exports = fastify => {
  // In-memory rooms: roomId -> { clients: Set<ws>, state: string|null, saveTimer, dirty }
  const rooms = new Map();

  const saveRoom = async room => {
    const roomData = rooms.get(room);
    if (!roomData || !roomData.state) return;
    const data = Buffer.from(roomData.state, 'utf8');
    await db.query(
      'INSERT INTO board_docs (project_id, doc_data, updated) VALUES ($1, $2, now()) ON CONFLICT (project_id) DO UPDATE SET doc_data = EXCLUDED.doc_data, updated = now()',
      [room, data]
    );
    roomData.dirty = false;
    console.info(`[board:${room}] saved (${data.length} bytes)`);
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

  const broadcast = (room, msgStr, excludeWs = null) => {
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

      if (!rooms.has(room)) {
        rooms.set(room, { clients: new Set(), state: null, saveTimer: null, dirty: false });
      }
      const roomData = rooms.get(room);

      // Load from DB if no in-memory state yet
      if (!roomData.state) {
        try {
          const { rows } = await db.query('SELECT doc_data FROM board_docs WHERE project_id = $1', [room]);
          if (rows[0]?.doc_data) {
            const rawStr = rows[0].doc_data.toString('utf8');
            try {
              JSON.parse(rawStr);
              roomData.state = rawStr;
              console.info(`[board:${room}] loaded from database`);
            } catch {
              console.warn(`[board:${room}] legacy or invalid DB data ignored`);
              roomData.state = null;
            }
          } else {
            console.info(`[board:${room}] new document`);
          }
        } catch (e) {
          console.error(`[board:${room}] load failed`, e);
        }
      }

      roomData.clients.add(ws);

      // Send current full state to the newly joined client
      ws.send(JSON.stringify({ type: 'init', state: roomData.state }));

      ws.on('message', rawMsg => {
        try {
          const str = rawMsg.toString();
          if (!str.startsWith('{')) return; // Ignore binary/non-JSON legacy frames quietly
          const data = JSON.parse(str);

          if (data.senderId) ws._senderId = data.senderId;

          if (data.type === 'full_state') {
            // Only used for DB persistence — don't rebroadcast
            roomData.state = data.state;
            scheduleSave(room);
            return;
          }

          // 'op' and 'awareness' messages: relay to everyone else in the room
          if (data.type === 'op' || data.type === 'awareness') {
            broadcast(room, str, ws);
          }
        } catch (e) {
          // Ignore invalid messages quietly
        }
      });

      ws.on('close', () => {
        if (ws._senderId) {
          broadcast(room, JSON.stringify({ type: 'peer_leave', senderId: ws._senderId }), ws);
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
