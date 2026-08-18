const { Hono } = require('hono');
const db = require('./db');
const { requireUser } = require('./auth');

const boards = new Hono();

// Apply requireUser middleware to all board endpoints
boards.use('*', requireUser);

boards.get('/dashboard', async (c) => {
  const user = c.get('user');
  const userId = user.id;

  const myProjectsRes = await db.query(
    'SELECT id, name, icon, updated FROM projects WHERE owner_id = $1 AND group_id IS NULL ORDER BY updated DESC',
    [userId]
  );

  const groupsRes = await db.query(
    'SELECT g.id, g.name, g.icon, gm.role as my_role FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = $1',
    [userId]
  );

  for (let group of groupsRes.rows) {
    group.myRole = group.my_role;
    const projRes = await db.query(
      'SELECT id, name, icon, updated FROM projects WHERE group_id = $1 ORDER BY updated DESC',
      [group.id]
    );
    group.projects = projRes.rows;
  }

  return c.json({
    user: { id: userId, email: user.email, name: user.name },
    myProjects: myProjectsRes.rows,
    groups: groupsRes.rows
  });
});

boards.post('/groups', async (c) => {
  const user = c.get('user');
  const { name } = await c.req.json().catch(() => ({}));
  if (!name || name.trim().length === 0) {
    return c.json({ error: 'Organizasyon adı boş olamaz.' }, 400);
  }

  const groupRes = await db.query(
    'INSERT INTO groups (name, owner_id) VALUES ($1, $2) RETURNING id, name, icon',
    [name.trim(), user.id]
  );
  const group = groupRes.rows[0];

  await db.query(
    'INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)',
    [group.id, user.id, 'owner']
  );

  return c.json(group);
});

boards.post('/projects', async (c) => {
  const user = c.get('user');
  const { name, groupId } = await c.req.json().catch(() => ({}));

  if (groupId) {
    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, user.id]
    );
    if (!memberCheck.rows[0]) {
      return c.json({ error: 'Bu organizasyonda proje oluşturma yetkiniz yok.' }, 403);
    }
  }

  const res = await db.query(
    'INSERT INTO projects (name, group_id, owner_id) VALUES ($1, $2, $3) RETURNING id, name, icon',
    [name || 'Untitled', groupId || null, user.id]
  );
  return c.json(res.rows[0]);
});

boards.delete('/projects/:id', async (c) => {
  const projectId = c.req.param('id');
  const user = c.get('user');

  const projRes = await db.query('SELECT owner_id, group_id FROM projects WHERE id = $1', [projectId]);
  if (!projRes.rows[0]) return c.json({ error: 'Proje bulunamadı.' }, 404);

  const proj = projRes.rows[0];

  if (proj.group_id) {
    const roleRes = await db.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [proj.group_id, user.id]
    );
    if (!roleRes.rows[0] || roleRes.rows[0].role !== 'owner') {
      return c.json({ error: 'Organizasyon projelerini sadece organizasyon yöneticisi silebilir.' }, 403);
    }
  } else {
    if (proj.owner_id !== user.id) {
      return c.json({ error: 'Bu projeyi silme yetkiniz yok.' }, 403);
    }
  }

  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  return c.json({ success: true });
});

boards.post('/projects/move', async (c) => {
  const { projectId, targetGroupId } = await c.req.json().catch(() => ({}));
  const user = c.get('user');

  const projRes = await db.query('SELECT owner_id, group_id FROM projects WHERE id = $1', [projectId]);
  if (!projRes.rows[0]) return c.json({ error: 'Proje bulunamadı.' }, 404);

  const proj = projRes.rows[0];

  if (proj.group_id) {
    const srcRole = await db.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [proj.group_id, user.id]
    );
    if (!srcRole.rows[0] || srcRole.rows[0].role !== 'owner') {
      return c.json({ error: 'Organizasyon projelerini sadece organizasyon yöneticisi taşıyabilir.' }, 403);
    }
  }

  if (targetGroupId) {
    const tgtRole = await db.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [targetGroupId, user.id]
    );
    if (!tgtRole.rows[0] || tgtRole.rows[0].role !== 'owner') {
      return c.json({ error: 'Hedef organizasyona proje taşımak için yönetici olmalısınız.' }, 403);
    }
  }

  if (!proj.group_id && proj.owner_id !== user.id) {
    return c.json({ error: 'Sadece kendi projenizi taşıyabilirsiniz.' }, 403);
  }

  await db.query('UPDATE projects SET group_id = $1, updated = CURRENT_TIMESTAMP WHERE id = $2', [targetGroupId || null, projectId]);
  return c.json({ success: true });
});

boards.post('/invite', async (c) => {
  const { groupId, email } = await c.req.json().catch(() => ({}));
  const user = c.get('user');

  try {
    const roleRes = await db.query(
      'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, user.id]
    );
    if (!roleRes.rows[0] || roleRes.rows[0].role !== 'owner') {
      return c.json({ error: 'Yetkiniz yok.' }, 403);
    }

    const userRes = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (!userRes.rows[0]) return c.json({ error: 'Kullanıcı bulunamadı.' }, 404);

    const memberRes = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userRes.rows[0].id]
    );
    if (memberRes.rows.length > 0) {
      return c.json({ error: 'Kullanıcı zaten grupta.' }, 400);
    }

    // Limit to max 100 pending invitations
    const invListRes = await db.query('SELECT id FROM invitations WHERE group_id = $1 ORDER BY created ASC', [groupId]);
    if (invListRes.rows.length >= 100) {
      const excess = invListRes.rows.length - 99;
      for (let i = 0; i < excess; i++) {
        await db.query('DELETE FROM invitations WHERE id = $1', [invListRes.rows[i].id]);
      }
    }

    await db.query(
      'INSERT INTO invitations (group_id, email, status) VALUES ($1, $2, $3) ON CONFLICT (group_id, email) DO UPDATE SET status = $3',
      [groupId, email.toLowerCase().trim(), 'pending']
    );
    return c.json({ success: true });
  } catch (e) {
    console.error('[boards] Invite error:', e);
    return c.json({ error: 'Failed to invite' }, 500);
  }
});

boards.get('/invitations', async (c) => {
  const user = c.get('user');
  const res = await db.query(
    'SELECT i.id, i.group_id, g.name as group_name FROM invitations i JOIN groups g ON i.group_id = g.id WHERE i.email = $1 AND i.status = $2 ORDER BY i.created DESC',
    [user.email, 'pending']
  );
  return c.json({ invitations: res.rows });
});

boards.post('/invitations/:id/respond', async (c) => {
  const { accept } = await c.req.json().catch(() => ({}));
  const invId = c.req.param('id');
  const user = c.get('user');

  const invRes = await db.query(
    'SELECT group_id, email FROM invitations WHERE id = $1 AND status = $2',
    [invId, 'pending']
  );
  if (!invRes.rows[0] || invRes.rows[0].email !== user.email) {
    return c.json({ error: 'Yetkiniz yok.' }, 403);
  }

  const groupId = invRes.rows[0].group_id;

  if (accept) {
    await db.query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)',
      [groupId, user.id, 'member']
    );
    await db.query('UPDATE invitations SET status = $1 WHERE id = $2', ['accepted', invId]);
  } else {
    await db.query('UPDATE invitations SET status = $1 WHERE id = $2', ['rejected', invId]);
  }

  return c.json({ success: true, groupId: accept ? groupId : null });
});

boards.get('/groups/:id/users', async (c) => {
  try {
    const groupId = c.req.param('id');
    const user = c.get('user');

    const groupRes = await db.query('SELECT owner_id FROM groups WHERE id = $1', [groupId]);
    if (!groupRes.rows[0]) return c.json({ error: 'Organizasyon bulunamadı.' }, 404);
    const groupOwnerId = groupRes.rows[0].owner_id;

    const res = await db.query(
      'SELECT u.id, u.email, u.name, gm.role FROM users u JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = $1',
      [groupId]
    );
    const myRole = res.rows.find(r => r.id === user.id)?.role;
    const isCreator = user.id === groupOwnerId;

    let pending = [];
    if (isCreator || myRole === 'owner') {
      try {
        const invRes = await db.query(
          'SELECT id, email FROM invitations WHERE group_id = $1 AND status = $2',
          [groupId, 'pending']
        );
        pending = invRes.rows || [];
      } catch (invErr) {
        console.warn('[boards] invitations fetch warning:', invErr.message);
      }
    }

    return c.json({
      users: res.rows || [],
      isOwner: myRole === 'owner',
      isCreator,
      groupOwnerId,
      myUserId: user.id,
      pending
    });
  } catch (err) {
    console.error('[boards] /groups/:id/users error:', err);
    return c.json({ error: 'Kullanıcılar listesi alınamadı: ' + err.message, users: [], pending: [] }, 500);
  }
});

boards.put('/groups/:groupId/users/:userId/role', async (c) => {
  const { groupId, userId } = c.req.param();
  const { role } = await c.req.json().catch(() => ({}));
  const user = c.get('user');

  const groupRes = await db.query('SELECT owner_id FROM groups WHERE id = $1', [groupId]);
  if (!groupRes.rows[0]) return c.json({ error: 'Organizasyon bulunamadı.' }, 404);

  const isCreator = user.id === groupRes.rows[0].owner_id;
  if (!isCreator) return c.json({ error: 'Rol değiştirme yetkisi sadece organizasyon kurucusuna aittir.' }, 403);

  if (userId === user.id) {
    return c.json({ error: 'Kendi rolünüzü değiştiremezsiniz.' }, 400);
  }

  if (userId === groupRes.rows[0].owner_id) {
    return c.json({ error: 'Organizasyon kurucusunun rolü değiştirilemez.' }, 400);
  }

  await db.query('UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3', [role, groupId, userId]);
  return c.json({ success: true });
});

boards.post('/groups/:groupId/leave', async (c) => {
  const groupId = c.req.param('groupId');
  const user = c.get('user');
  const userId = user.id;

  const myRoleRes = await db.query(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  if (!myRoleRes.rows[0]) return c.json({ error: 'Grupta değilsiniz.' }, 404);

  const groupRes = await db.query('SELECT owner_id FROM groups WHERE id = $1', [groupId]);
  const isCreator = groupRes.rows[0] && groupRes.rows[0].owner_id === userId;

  if (isCreator) {
    const otherAdmins = await db.query(
      "SELECT user_id FROM group_members WHERE group_id = $1 AND user_id != $2 AND role = 'owner' ORDER BY created ASC LIMIT 1",
      [groupId, userId]
    );
    let nextOwnerId = otherAdmins.rows[0] ? otherAdmins.rows[0].user_id : null;

    if (!nextOwnerId) {
      const anyOtherMember = await db.query(
        "SELECT user_id FROM group_members WHERE group_id = $1 AND user_id != $2 ORDER BY created ASC LIMIT 1",
        [groupId, userId]
      );
      if (anyOtherMember.rows[0]) nextOwnerId = anyOtherMember.rows[0].user_id;
    }

    if (nextOwnerId) {
      await db.query('UPDATE groups SET owner_id = $1 WHERE id = $2', [nextOwnerId, groupId]);
      await db.query('UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3', ['owner', groupId, nextOwnerId]);
      await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
    } else {
      const groupProjects = await db.query('SELECT id FROM projects WHERE group_id = $1', [groupId]);
      for (let p of groupProjects.rows) {
        await db.query('DELETE FROM board_docs WHERE project_id = $1', [p.id]);
      }
      await db.query('DELETE FROM projects WHERE group_id = $1', [groupId]);
      await db.query('DELETE FROM invitations WHERE group_id = $1', [groupId]);
      await db.query('DELETE FROM groups WHERE id = $1', [groupId]);
    }
  } else {
    await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  }

  return c.json({ success: true });
});

boards.delete('/groups/:groupId/users/:userId', async (c) => {
  const { groupId, userId } = c.req.param();
  const user = c.get('user');

  const groupRes = await db.query('SELECT owner_id FROM groups WHERE id = $1', [groupId]);
  if (!groupRes.rows[0]) return c.json({ error: 'Organizasyon bulunamadı.' }, 404);

  const isCreator = user.id === groupRes.rows[0].owner_id;
  if (!isCreator) return c.json({ error: 'Üye çıkarma yetkisi sadece organizasyon kurucusuna aittir.' }, 403);

  if (userId === user.id) {
    return c.json({ error: 'Kendinizi gruptan çıkaramazsınız. Gruptan ayrıl butonunu kullanın.' }, 400);
  }

  if (userId === groupRes.rows[0].owner_id) {
    return c.json({ error: 'Organizasyon kurucusu çıkarılamaz.' }, 400);
  }

  await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  return c.json({ success: true });
});

boards.delete('/groups/:groupId/invitations/:invId', async (c) => {
  const { groupId, invId } = c.req.param();
  const user = c.get('user');

  const roleRes = await db.query(
    'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, user.id]
  );
  if (!roleRes.rows[0] || roleRes.rows[0].role !== 'owner') {
    return c.json({ error: 'Yetkiniz yok.' }, 403);
  }

  await db.query('DELETE FROM invitations WHERE id = $1 AND group_id = $2', [invId, groupId]);
  return c.json({ success: true });
});

module.exports = {
  boards
};
