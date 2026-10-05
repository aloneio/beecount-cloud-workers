/**
 * 账本摘要路由模块 - 实现单账本快速统计接口
 *
 * 参考原版 BeeCount-Cloud (Python/FastAPI) 的 /read/summary 端点：
 * - GET /read/summary - 单账本快速统计
 *
 * 功能说明：
 * - 用于 mobile 的首页/概览页
 * - 快速返回 tx_count / income / expense / balance
 * - 比完整 ledger 查询更轻量
 *
 * @module routes/summary
 */

import { Hono } from 'hono';


function nowUtc(): string {
  return new Date().toISOString();
}

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
};

type Variables = {
  userId: string;
};

const summaryRouter = new Hono<{ Bindings: Bindings; Variables: Variables }>();

/**
 * GET /read/summary - 单账本快速统计
 *
 * 查询参数：
 * - ledger_id: 账本外部 ID（必填）
 *
 * 响应字段：
 * - tx_count: 交易总数
 * - income_total: 收入总额
 * - expense_total: 支出总额
 * - balance: 余额（income - expense）
 * - first_tx_at: 首笔交易时间
 * - last_tx_at: 最后一笔交易时间
 */
summaryRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.query('ledger_id');

  if (!ledgerExternalId) {
    return c.json({ error: 'ledger_id is required' }, 400);
  }

  const ledger = await db
    .prepare('SELECT id, external_id FROM ledgers WHERE user_id = ? AND external_id = ?')
    .bind(userId, ledgerExternalId)
    .first<{ id: string; external_id: string }>();

  if (!ledger) {
    return c.json({ error: 'Ledger not found' }, 404);
  }

  const stats = await db
    .prepare(
      `SELECT
         COUNT(*) as tx_count,
         COALESCE(SUM(CASE WHEN tx_type = 'income' THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as income_total,
         COALESCE(SUM(CASE WHEN tx_type = 'expense' THEN COALESCE(native_amount, amount) ELSE 0 END), 0) as expense_total,
         MIN(happened_at) as first_tx_at,
         MAX(happened_at) as last_tx_at
       FROM read_tx_projection
       WHERE ledger_id = ?
       AND (exclude_from_stats IS NULL OR exclude_from_stats = 0 OR exclude_from_stats = false)`
    )
    .bind(ledger.id)
    .first<{
      tx_count: number;
      income_total: number;
      expense_total: number;
      first_tx_at: string | null;
      last_tx_at: string | null;
    }>();

  const incomeTotal = stats?.income_total ?? 0;
  const expenseTotal = stats?.expense_total ?? 0;

  return c.json({
    ledger_id: ledger.external_id,
    transaction_count: stats?.tx_count ?? 0,
    income_total: incomeTotal,
    expense_total: expenseTotal,
    balance: incomeTotal - expenseTotal,
    latest_happened_at: stats?.last_tx_at ?? null,
  });
});


// GET /read/summary/workspace/ledger-counts - 获取账本统计
summaryRouter.get('/workspace/ledger-counts', async (c) => {
  const userId = c.get('userId');
  const db = c.env.DB;
  const ledgerExternalId = c.req.query('ledger_id') ?? null;

  let ledgerQuery = 'SELECT id FROM ledgers WHERE user_id = ?';
  const ledgerParams: string[] = [userId];
  if (ledgerExternalId) { ledgerQuery += ' AND external_id = ?'; ledgerParams.push(ledgerExternalId); }

  const ledgers = await db.prepare(ledgerQuery).bind(...ledgerParams).all<{ id: string }>();
  if (ledgers.results.length === 0) {
    return c.json({ tx_count: 0, days_since_first_tx: 0, distinct_days: 0, first_tx_at: null });
  }

  const ids = ledgers.results.map((l) => l.id);
  const row = await db.prepare(`SELECT COUNT(*) as cnt, MIN(happened_at) as first_at FROM read_tx_projection WHERE ledger_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).first<{ cnt: number; first_at: string | null }>();

  const txCount = row?.cnt ?? 0;
  const firstAt = row?.first_at ?? null;
  let daysSinceFirstTx = 0;
  if (firstAt) {
    const diff = Date.now() - new Date(firstAt).getTime();
    daysSinceFirstTx = Math.floor(diff / (1000 * 60 * 60 * 24)) + 1;
  }

  return c.json({ tx_count: txCount, days_since_first_tx: daysSinceFirstTx, distinct_days: 0, first_tx_at: firstAt });
});

export default summaryRouter;
