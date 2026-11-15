import { Database } from "bun:sqlite";

/** Valid PR states without a live worker, starting with the hook tests' report assignment. */
export function* quietPrStates(file: string, sourceId: string) {
  using db = new Database(file);
  db.query(`UPDATE sources SET plan = json_set(plan,
    '$.assignments[0].completion', 'pr', '$.assignments[0].resources', 'worktree',
    '$.assignments[0].branch', 'task/investigate') WHERE id = ?`).run(sourceId);
  db.query("UPDATE assignments SET completion = 'pr', state = 'pr-open' WHERE source_id = ?").run(
    sourceId,
  );
  db.query("UPDATE launches SET state = 'finished' WHERE source_id = ?").run(sourceId);
  db.query(`INSERT INTO pull_requests
    (source_id, assignment, repository, number, url, branch, associated_at, progress, wait_state)
    VALUES (?, 'investigate', 'example/one', 1, 'https://github.com/example/one/pull/1',
      'task/investigate', '2026-11-13T00:00:00Z', '{}', 'idle')`).run(sourceId);
  yield "a PR with no live worker";

  db.query(`UPDATE worker_questions SET state = 'abandoned', ended_at = '2026-11-13T00:00:00Z'
    WHERE source_id = ?`).run(sourceId);
  db.query(`UPDATE assignments SET state = 'merged' WHERE source_id = ?`).run(sourceId);
  db.query(`UPDATE sources SET state = 'finished', ended_at = '2026-11-13T00:00:00Z'
    WHERE id = ?`).run(sourceId);
  db.query(`UPDATE pull_requests SET merged_head = 'head', merge_commit = 'merge',
    merged_at = '2026-11-13T00:00:00Z' WHERE source_id = ?`).run(sourceId);
  db.query(`INSERT INTO cleanups
    (source_id, assignment, launch_id, step, state, reason, detail, updated_at)
    VALUES (?, 'investigate', 'launch-1', 'worktree', 'failed', 'cleanup_step_failed',
      'Removal failed.', '2026-11-13T00:00:00Z')`).run(sourceId);
  yield "failed cleanup";

  db.query(`UPDATE cleanups SET state = 'blocked', reason = 'cleanup_unlanded_work'
    WHERE source_id = ?`).run(sourceId);
  yield "retained unlanded work";

  db.query(`UPDATE cleanups SET state = 'done', step = NULL, reason = NULL, detail = NULL
    WHERE source_id = ?`).run(sourceId);
  yield "source retention";
}
