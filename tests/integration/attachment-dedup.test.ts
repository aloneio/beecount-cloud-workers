import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken, createTestLedger, getTable } from '../helpers/test-env';
import { sweepDuplicateAttachments } from '../../src/lib/attachment-dedup';

let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;
let ledgerId: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'dedup@example.com');
  token = await getAuthToken(env.app, 'dedup@example.com');
  ledgerId = await createTestLedger(env.app, token, 'Dedup Ledger');
});

function internalLedgerId(): string {
  const row = getTable(env.db, 'ledgers').find((l: any) => l.external_id === ledgerId);
  expect(row?.id).toBeDefined();
  return row!.id as string;
}

function seedAttachment(row: Record<string, unknown>) {
  getTable(env.db, 'attachment_files').push({
    user_id: 'u-1',
    size_bytes: 100,
    mime_type: 'image/jpeg',
    file_name: 'a.jpg',
    attachment_kind: 'transaction',
    ...row,
  });
}

describe('sweepDuplicateAttachments', () => {
  it('keeps the earliest row, deletes unreferenced duplicates, keeps referenced ones', async () => {
    const lid = internalLedgerId();
    const sha = 'a'.repeat(64);
    seedAttachment({ id: 'dup-A', ledger_id: lid, sha256: sha, storage_path: 'attachments/x/dup-A.jpg', created_at: '2026-01-01T00:00:00.000Z' });
    seedAttachment({ id: 'dup-B', ledger_id: lid, sha256: sha, storage_path: 'attachments/x/dup-B.jpg', created_at: '2026-01-02T00:00:00.000Z' });
    seedAttachment({ id: 'dup-C', ledger_id: lid, sha256: sha, storage_path: 'attachments/x/dup-C.jpg', created_at: '2026-01-03T00:00:00.000Z' });
    // 不同 sha 的控制行不受影响
    seedAttachment({ id: 'other-D', ledger_id: lid, sha256: 'b'.repeat(64), storage_path: 'attachments/x/other-D.jpg', created_at: '2026-01-01T00:00:00.000Z' });
    // dup-C 被一笔交易引用（跨账本共享场景）→ 必须保留
    getTable(env.db, 'read_tx_projection').push({
      ledger_id: lid,
      sync_id: 'tx-1',
      attachments_json: JSON.stringify([{ cloudFileId: 'dup-C' }]),
    });

    const removed = await sweepDuplicateAttachments(env.db, env, sha, lid, 'transaction');

    expect(removed).toBe(1); // 只删 dup-B（未引用）；dup-A 最早保留，dup-C 被引用保留
    const ids = getTable(env.db, 'attachment_files').map((r: any) => r.id).sort();
    expect(ids).toEqual(['dup-A', 'dup-C', 'other-D']);
  });

  it('is a no-op when there are no duplicates', async () => {
    const lid = internalLedgerId();
    const sha = 'c'.repeat(64);
    seedAttachment({ id: 'only-1', ledger_id: lid, sha256: sha, storage_path: 'attachments/x/only-1.jpg', created_at: '2026-01-01T00:00:00.000Z' });

    const removed = await sweepDuplicateAttachments(env.db, env, sha, lid, 'transaction');

    expect(removed).toBe(0);
    expect(getTable(env.db, 'attachment_files')).toHaveLength(1);
  });
});
