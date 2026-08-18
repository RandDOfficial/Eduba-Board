const db = require('./db');

module.exports = function(fastify) {
  fastify.get('/api/boards/dashboard', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const userId = request.user.id;
    const myProjectsRes = await db.query('SELECT id, name, icon, updated FROM projects WHERE owner_id = $1 AND group_id IS NULL ORDER BY updated DESC', [userId]);

    const groupsRes = await db.query('SELECT g.id, g.name, g.icon, gm.role as my_role FROM groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = $1', [userId]);

    for (let group of groupsRes.rows) {
      group.myRole = group.my_role;
      const projRes = await db.query('SELECT id, name, icon, updated FROM projects WHERE group_id = $1 ORDER BY updated DESC', [group.id]);
      group.projects = projRes.rows;
    }

    return { user: { id: userId, email: request.user.email, name: request.user.name }, myProjects: myProjectsRes.rows, groups: groupsRes.rows };
  });

  fastify.post('/api/boards/groups', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const { name } = request.body;
    if (!name || name.trim().length === 0) return reply.code(400).send({ error: 'Organizasyon adı boş olamaz.' });

    const groupRes = await db.query(
      'INSERT INTO groups (name, owner_id) VALUES ($1, $2) RETURNING id, name, icon',
      [name.trim(), request.user.id]
    );
    const group = groupRes.rows[0];

    await db.query(
      'INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)',
      [group.id, request.user.id, 'owner']
    );

    return group;
  });

  fastify.post('/api/boards/projects', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const { name, groupId } = request.body;
    if (groupId) {
      const memberCheck = await db.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, request.user.id]);
      if (!memberCheck.rows[0]) return reply.code(403).send({ error: 'Bu organizasyonda proje oluşturma yetkiniz yok.' });
    }
    const res = await db.query(
      'INSERT INTO projects (name, group_id, owner_id) VALUES ($1, $2, $3) RETURNING id, name, icon',
      [name || 'Untitled', groupId || null, request.user.id]
    );
    return res.rows[0];
  });

  fastify.delete('/api/boards/projects/:id', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const projectId = request.params.id;
    const userId = request.user.id;

    const projRes = await db.query('SELECT owner_id, group_id FROM projects WHERE id = $1', [projectId]);
    if (!projRes.rows[0]) return reply.code(404).send({ error: 'Proje bulunamadı.' });

    const proj = projRes.rows[0];

    if (proj.group_id) {
      // Group project: ONLY group owner can delete
      const roleRes = await db.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [proj.group_id, userId]);
      if (!roleRes.rows[0] || roleRes.rows[0].role !== 'owner') {
        return reply.code(403).send({ error: 'Organizasyon projelerini sadece organizasyon yöneticisi silebilir.' });
      }
    } else {
      // Personal project: ONLY project owner can delete
      if (proj.owner_id !== userId) {
        return reply.code(403).send({ error: 'Bu projeyi silme yetkiniz yok.' });
      }
    }

    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    return { success: true };
  });

  fastify.post('/api/boards/projects/move', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const { projectId, targetGroupId } = request.body;
    const userId = request.user.id;

    const projRes = await db.query('SELECT owner_id, group_id FROM projects WHERE id = $1', [projectId]);
    if (!projRes.rows[0]) return reply.code(404).send({ error: 'Proje bulunamadı.' });

    const proj = projRes.rows[0];

    // If project is currently in a group, user MUST be owner of that group to move it
    if (proj.group_id) {
      const srcRole = await db.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [proj.group_id, userId]);
      if (!srcRole.rows[0] || srcRole.rows[0].role !== 'owner') {
        return reply.code(403).send({ error: 'Organizasyon projelerini sadece organizasyon yöneticisi taşıyabilir.' });
      }
    }

    // If moving into a target group, user MUST be owner of target group
    if (targetGroupId) {
      const tgtRole = await db.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [targetGroupId, userId]);
      if (!tgtRole.rows[0] || tgtRole.rows[0].role !== 'owner') {
        return reply.code(403).send({ error: 'Hedef organizasyona proje taşımak için yönetici olmalısınız.' });
      }
    }

    // If moving personal project, user MUST be project owner
    if (!proj.group_id && proj.owner_id !== userId) {
      return reply.code(403).send({ error: 'Sadece kendi projenizi taşıyabilirsiniz.' });
    }

    await db.query('UPDATE projects SET group_id = $1, updated = now() WHERE id = $2', [targetGroupId || null, projectId]);
    return { success: true };
  });

  fastify.post('/api/boards/invite', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const { groupId, email } = request.body;
    try {
      const roleRes = await db.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, request.user.id]);
      if (!roleRes.rows[0] || roleRes.rows[0].role !== 'owner') return reply.code(403).send({ error: 'Yetkiniz yok.' });

      const userRes = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (!userRes.rows[0]) return reply.code(404).send({ error: 'Kullanıcı bulunamadı.' });

      const memberRes = await db.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userRes.rows[0].id]);
      if (memberRes.rows.length > 0) return reply.code(400).send({ error: 'Kullanıcı zaten grupta.' });

      // Check max 100 limit: delete oldest excess invitations
      const invListRes = await db.query('SELECT id FROM invitations WHERE group_id = $1 ORDER BY created ASC', [groupId]);
      if (invListRes.rows.length >= 100) {
        const excess = invListRes.rows.length - 99;
        for (let i = 0; i < excess; i++) {
          await db.query('DELETE FROM invitations WHERE id = $1', [invListRes.rows[i].id]);
        }
      }

      await db.query('INSERT INTO invitations (group_id, email, status) VALUES ($1, $2, $3) ON CONFLICT (group_id, email) DO UPDATE SET status = $3', [groupId, email, 'pending']);
      return { success: true };
    } catch (e) {
      return reply.code(500).send({ error: 'Failed to invite' });
    }
  });

  fastify.get('/api/boards/invitations', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const res = await db.query('SELECT i.id, i.group_id, g.name as group_name FROM invitations i JOIN groups g ON i.group_id = g.id WHERE i.email = $1 AND i.status = $2 ORDER BY i.created DESC', [request.user.email, 'pending']);
    return { invitations: res.rows };
  });

  fastify.post('/api/boards/invitations/:id/respond', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const { accept } = request.body;
    const invId = request.params.id;

    const invRes = await db.query('SELECT group_id, email FROM invitations WHERE id = $1 AND status = $2', [invId, 'pending']);
    if (!invRes.rows[0] || invRes.rows[0].email !== request.user.email) return reply.code(403).send({ error: 'Yetkiniz yok.' });

    const groupId = invRes.rows[0].group_id;

    if (accept) {
      await db.query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [groupId, request.user.id, 'member']);
      await db.query('UPDATE invitations SET status = $1 WHERE id = $2', ['accepted', invId]);
    } else {
      await db.query('UPDATE invitations SET status = $1 WHERE id = $2', ['rejected', invId]);
    }

    return { success: true, groupId: accept ? groupId : null };
  });

  fastify.get('/api/boards/groups/:id/users', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const groupId = request.params.id;
    const groupRes = await db.query('SELECT owner_id FROM groups WHERE id = $1', [groupId]);
    if (!groupRes.rows[0]) return reply.code(404).send({ error: 'Organizasyon bulunamadı.' });
    const groupOwnerId = groupRes.rows[0].owner_id;

    const res = await db.query(
      'SELECT u.id, u.email, u.name, gm.role FROM users u JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = $1',
      [groupId]
    );
    const myRole = res.rows.find(r => r.id === request.user.id)?.role;
    const isCreator = request.user.id === groupOwnerId;

    let pending = [];
    if (isCreator || myRole === 'owner') {
       const invRes = await db.query('SELECT id, email FROM invitations WHERE group_id = $1 AND status = $2 ORDER BY created DESC', [groupId, 'pending']);
       pending = invRes.rows;
    }

    return { users: res.rows, isOwner: myRole === 'owner', isCreator, groupOwnerId, myUserId: request.user.id, pending };
  });

  fastify.put('/api/boards/groups/:groupId/users/:userId/role', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const { groupId, userId } = request.params;
    const { role } = request.body;

    const groupRes = await db.query('SELECT owner_id FROM groups WHERE id = $1', [groupId]);
    if (!groupRes.rows[0]) return reply.code(404).send({ error: 'Organizasyon bulunamadı.' });

    const isCreator = request.user.id === groupRes.rows[0].owner_id;
    if (!isCreator) return reply.code(403).send({ error: 'Rol değiştirme yetkisi sadece organizasyon kurucusuna aittir.' });

    if (userId === request.user.id) {
      return reply.code(400).send({ error: 'Kendi rolünüzü değiştiremezsiniz.' });
    }

    if (userId === groupRes.rows[0].owner_id) {
      return reply.code(400).send({ error: 'Organizasyon kurucusunun rolü değiştirilemez.' });
    }

    await db.query('UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3', [role, groupId, userId]);
    return { success: true };
  });

  fastify.post('/api/boards/groups/:groupId/leave', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const { groupId } = request.params;
    const userId = request.user.id;

    const myRoleRes = await db.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
    if (!myRoleRes.rows[0]) return reply.code(404).send({ error: 'Grupta değilsiniz.' });

    const groupRes = await db.query('SELECT owner_id FROM groups WHERE id = $1', [groupId]);
    const isCreator = groupRes.rows[0] && groupRes.rows[0].owner_id === userId;

    if (isCreator) {
      // 1. Prefer another member with role='owner' (Yönetici)
      const otherAdmins = await db.query(
        "SELECT user_id FROM group_members WHERE group_id = $1 AND user_id != $2 AND role = 'owner' ORDER BY created ASC LIMIT 1",
        [groupId, userId]
      );
      let nextOwnerId = otherAdmins.rows[0] ? otherAdmins.rows[0].user_id : null;

      // 2. Otherwise fallback to any other member (Üye)
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
        // 3. No remaining members left -> Delete group, its projects, board docs, and invitations
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
    return { success: true };
  });

  fastify.delete('/api/boards/groups/:groupId/users/:userId', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const { groupId, userId } = request.params;

    const groupRes = await db.query('SELECT owner_id FROM groups WHERE id = $1', [groupId]);
    if (!groupRes.rows[0]) return reply.code(404).send({ error: 'Organizasyon bulunamadı.' });

    const isCreator = request.user.id === groupRes.rows[0].owner_id;
    if (!isCreator) return reply.code(403).send({ error: 'Üye çıkarma yetkisi sadece organizasyon kurucusuna aittir.' });

    if (userId === request.user.id) {
      return reply.code(400).send({ error: 'Kendinizi gruptan çıkaramazsınız. Gruptan ayrıl butonunu kullanın.' });
    }

    if (userId === groupRes.rows[0].owner_id) {
      return reply.code(400).send({ error: 'Organizasyon kurucusu çıkarılamaz.' });
    }

    await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
    return { success: true };
  });

  fastify.delete('/api/boards/groups/:groupId/invitations/:invId', { preHandler: [fastify.requireUser] }, async (request, reply) => {
    const { groupId, invId } = request.params;
    const roleRes = await db.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, request.user.id]);
    if (!roleRes.rows[0] || roleRes.rows[0].role !== 'owner') return reply.code(403).send({ error: 'Yetkiniz yok.' });

    await db.query('DELETE FROM invitations WHERE id = $1 AND group_id = $2', [invId, groupId]);
    return { success: true };
  });
};
