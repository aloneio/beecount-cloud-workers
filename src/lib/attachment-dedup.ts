import { serverLogger } from './logger';
import { deleteFromStorage } from './storage-adapter';

/**
 * 附件竞态清扫：同一 (sha256, ledger_id, attachment_kind) 只保留最早一行。
 *
 * 上传去重的「查重 → INSERT」之间若并发同图上传（R2/远端存储往返把竞态
 * 窗口拉大），会插入重复行，导致账本附件数虚高。这里把除最早行外、且
 * 未被任何交易引用（attachments_json 里没有该 cloudFileId）的行连同存储
 * 对象一起删除；已引用的行保留 —— 竞态期间引用可能落在非最早行上，不能删。
 * 对齐原版 gc_orphan_attachments 语义：确认无引用后才删。
 *
 * 清扫是 best-effort：任何异常都不允许影响上传主流程（只记日志返回 0）。
 *
 * @returns 删除的重复行数
 */
export async function sweepDuplicateAttachments(
  db: D1Database,
  env: Record<string, unknown>,
  sha256: string,
  ledgerId: string,
  kind: string,
): Promise<number> {
  try {
    const rows = await db
      .prepare(
        `SELECT id, storage_path FROM attachment_files
         WHERE sha256 = ? AND ledger_id = ? AND attachment_kind = ?
         ORDER BY created_at ASC, id ASC`
      )
      .bind(sha256, ledgerId, kind)
      .all<{ id: string; storage_path: string | null }>();

    const dups = rows.results.slice(1);
    if (dups.length === 0) return 0;

    let removed = 0;
    for (const dup of dups) {
      // 引用检查跨所有账本（共享附件可被其它账本引用，如 shared_ 前缀的行）。
      // 用 INSTR 而非 LIKE：D1 对带 % 通配的模式抛 "LIKE or GLOB pattern too
      // complex"。INSTR 是 sync.ts 删除交易附件时已在生产验证的写法。
      const ref = await db
        .prepare(
          `SELECT COUNT(*) as cnt FROM read_tx_projection
           WHERE INSTR(attachments_json, ?) > 0 OR INSTR(attachments_json, ?) > 0`
        )
        .bind(`"cloudFileId":"${dup.id}"`, `"cloudFileId": "${dup.id}"`)
        .first<{ cnt: number }>();
      if (ref && ref.cnt > 0) continue;

      if (dup.storage_path) {
        await deleteFromStorage(db, env as { R2?: R2Bucket }, dup.storage_path.replace(/^beecount\//, ''));
      }
      await db.prepare('DELETE FROM attachment_files WHERE id = ?').bind(dup.id).run();
      removed++;
    }
    return removed;
  } catch (err) {
    serverLogger.error('src.lib.attachment-dedup', '[SWEEP] 清扫失败（不影响上传）:', err);
    return 0;
  }
}
