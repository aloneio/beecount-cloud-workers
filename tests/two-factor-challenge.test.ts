import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRealDb } from './helpers/realsql-db';
import twoFactorRouter from '../src/routes/two_factor';
import { createAccessToken } from '../src/auth';

// #16 回归：validateAccessToken 被收紧为 type=access 后，误拒 2FA 登录的
// challenge token（type=totp_challenge）→ "Invalid or expired challenge token."
// 修复：/2fa/verify 改用 validateSignedToken(token, secret, 'totp_challenge')。
const TABLES = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0, is_enabled INTEGER DEFAULT 1,
    totp_enabled INTEGER DEFAULT 0, totp_secret_encrypted TEXT, created_at TEXT
  );
  CREATE TABLE recovery_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, code_hash TEXT, used_at TEXT);
`;

const SECRET = 'test-secret';

function buildApp(db: D1Database) {
  const app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string; BEECOUNT_DO?: DurableObjectNamespace } }>();
  app.route('/2fa', twoFactorRouter);
  return app;
}

async function verifyCall(app: Hono<any>, db: D1Database, challengeToken: string) {
  return app.request(
    '/2fa/verify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_token: challengeToken, code: '000000', method: 'recovery_code' }),
    },
    { DB: db, JWT_SECRET: SECRET } as any,
  );
}

describe('2FA login challenge token（totp_challenge）', () => {
  it('totp_challenge token 可通过挑战校验（错误验证码报 Invalid 2FA code 而非 challenge 错误）', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_admin, is_enabled, totp_enabled, totp_secret_encrypted, created_at)
      VALUES ('u1', 'a@x.com', 'x', 0, 1, 1, 'encrypted-secret', '2026-01-01T00:00:00Z');
    `);
    const app = buildApp(db);
    const challenge = await createAccessToken('u1', SECRET, [], 300, 'totp_challenge');
    const res = await verifyCall(app, db, challenge);
    const body = await res.json() as { error: string };
    expect(res.status).toBe(401);
    expect(body.error).toBe('Invalid 2FA code.'); // 走到了验证码校验：challenge 已通过
  });

  it('access token 不能用做 challenge（防绕过 2FA）→ 仍报 challenge 错误', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_admin, is_enabled, totp_enabled, totp_secret_encrypted, created_at)
      VALUES ('u1', 'a@x.com', 'x', 0, 1, 1, 'encrypted-secret', '2026-01-01T00:00:00Z');
    `);
    const app = buildApp(db);
    const access = await createAccessToken('u1', SECRET, ['app_write']);
    const res = await verifyCall(app, db, access);
    const body = await res.json() as { error: string };
    expect(res.status).toBe(401);
    expect(body.error).toBe('Invalid or expired challenge token.');
  });

  it('refreshtoken 同样不能用作 challenge', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_admin, is_enabled, totp_enabled, totp_secret_encrypted, created_at)
      VALUES ('u1', 'a@x.com', 'x', 0, 1, 1, 'encrypted-secret', '2026-01-01T00:00:00Z');
    `);
    const app = buildApp(db);
    const refresh = await createAccessToken('u1', SECRET, ['app_write'], 30 * 24 * 3600, 'refresh');
    const res = await verifyCall(app, db, refresh);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid or expired challenge token.');
  });

  it('过期 challenge token 被拒', async () => {
    const { sqlite, db } = createRealDb();
    sqlite.exec(TABLES);
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, is_admin, is_enabled, totp_enabled, totp_secret_encrypted, created_at)
      VALUES ('u1', 'a@x.com', 'x', 0, 1, 1, 'encrypted-secret', '2026-01-01T00:00:00Z');
    `);
    const app = buildApp(db);
    const expired = await createAccessToken('u1', SECRET, [], -10, 'totp_challenge');
    const res = await verifyCall(app, db, expired);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Invalid or expired challenge token.');
  });
});