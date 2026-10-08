import { Hono } from 'hono';
import { serverLogger } from '../lib/logger';
import { hashPassword } from '../auth';
import { DEFAULT_AI_CONFIG } from '../lib/defaults';

type Bindings = {
  DB: D1Database;
};

const setupRouter = new Hono<{ Bindings: Bindings }>();

setupRouter.post('/', async (c) => {
  const db = c.env.DB;

  try {
    const existing = await db
      .prepare('SELECT setup_completed FROM system_settings WHERE id = ?')
      .bind('default')
      .first<{ setup_completed: number }>();

    if (existing?.setup_completed === 1) {
      return c.json({ error: 'Setup already completed' }, 403);
    }

    const body = await c.req.json<Record<string, unknown>>();
    const adminMode = body.admin_mode === 'manual' ? 'manual' : null;
    const adminEmail = typeof body.admin_email === 'string' ? body.admin_email.trim().toLowerCase() : '';
    const adminPassword = typeof body.admin_password === 'string' ? body.admin_password : '';
    const timezoneOffset = Number(body.timezone_offset ?? 0);
    const cloudConfigJson = body.cloud_config ? JSON.stringify(body.cloud_config) : null;

    if (!Number.isFinite(timezoneOffset) || timezoneOffset < -720 || timezoneOffset > 840) {
      return c.json({ error: 'Invalid timezone offset' }, 400);
    }

    const existingAdmin = await db
      .prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at LIMIT 1')
      .first<{ id: string }>();

    const serverNow = new Date().toISOString();

    // 已有管理员的恢复/升级场景只需要原子完成 settings，不再创建账户。
    if (existingAdmin) {
      await db.prepare(`
        INSERT INTO system_settings
          (id, timezone_offset, cloud_config_json, setup_completed, created_at, updated_at)
        VALUES ('default', ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          timezone_offset = excluded.timezone_offset,
          cloud_config_json = excluded.cloud_config_json,
          setup_completed = 1,
          updated_at = excluded.updated_at
        WHERE system_settings.setup_completed = 0
      `).bind(timezoneOffset, cloudConfigJson, serverNow, serverNow).run();
      return c.json({
        success: true,
        message: '系统设置已保存，管理员账户已存在',
        timezone_offset: timezoneOffset,
      });
    }

    if (adminMode !== 'manual' || !adminEmail || adminPassword.length < 8) {
      return c.json({ error: 'A valid admin email and password of at least 8 characters are required' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      return c.json({ error: 'Invalid admin email' }, 400);
    }

    const emailOwner = await db.prepare('SELECT id FROM users WHERE email = ?').bind(adminEmail).first<{ id: string }>();
    if (emailOwner) return c.json({ error: 'Email already exists' }, 409);

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(adminPassword);

    // user/profile/settings 同一事务提交。第一条 INSERT 带 setup_completed guard：
    // 并发 setup 中只有第一笔能创建管理员；后来的 batch 会得到 changes=0。
    const results = await db.batch([
      db.prepare(`
        INSERT INTO users (id, email, password_hash, is_admin, is_enabled)
        SELECT ?, ?, ?, 1, 1
        WHERE NOT EXISTS (
          SELECT 1 FROM system_settings WHERE id = 'default' AND setup_completed = 1
        )
      `).bind(userId, adminEmail, passwordHash),
      db.prepare(`
        INSERT INTO user_profiles (user_id, display_name, ai_config_json)
        SELECT ?, ?, ? FROM users WHERE id = ?
      `).bind(userId, adminEmail.split('@')[0], DEFAULT_AI_CONFIG, userId),
      db.prepare(`
        INSERT INTO system_settings
          (id, timezone_offset, cloud_config_json, setup_completed, created_at, updated_at)
        SELECT 'default', ?, ?, 1, ?, ?
        WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
        ON CONFLICT(id) DO UPDATE SET
          timezone_offset = excluded.timezone_offset,
          cloud_config_json = excluded.cloud_config_json,
          setup_completed = 1,
          updated_at = excluded.updated_at
        WHERE system_settings.setup_completed = 0
      `).bind(timezoneOffset, cloudConfigJson, serverNow, serverNow, userId),
    ]);

    const created = Number((results[0] as any)?.meta?.changes ?? 0) > 0;
    if (!created) return c.json({ error: 'Setup already completed' }, 403);

    return c.json({
      success: true,
      message: '系统设置已保存，管理员账户已创建',
      timezone_offset: timezoneOffset,
      user_email: adminEmail,
    });
  } catch (error) {
    serverLogger.error('app', '[Setup] Error saving settings:', error);
    return c.json({
      success: false,
      error: '保存设置失败'
    }, 500);
  }
});

setupRouter.get('/', async (c) => {
  const db = c.env.DB;

  try {
    const settings = await db
      .prepare('SELECT setup_completed, timezone_offset FROM system_settings WHERE id = ?')
      .bind('default')
      .first<{ setup_completed: number; timezone_offset: number }>();

    return c.json({
      setup_completed: Boolean(settings?.setup_completed),
      timezone_offset: settings?.timezone_offset ?? 0,
    });
  } catch {
    return c.json({
      setup_completed: false,
      timezone_offset: 0,
    });
  }
});

export default setupRouter;
