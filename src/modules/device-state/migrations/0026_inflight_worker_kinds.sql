CREATE TEMP TABLE issue391_null_kinds AS SELECT source_id, key FROM assignments WHERE kind IS NULL;
--> statement-breakpoint
UPDATE assignments AS a
SET kind = CASE
  WHEN a.state = 'pr-open' AND EXISTS (
    SELECT 1 FROM internal_reviews r WHERE r.source_id = a.source_id AND r.assignment = a.key
    AND (r.state = 'reviewing' OR (r.handoff_state IN ('pending', 'failed') AND NOT EXISTS (
      SELECT 1 FROM kind_handoffs h WHERE h.source_id = a.source_id AND h.assignment = a.key
    )))
  ) THEN 'review'
  WHEN a.state = 'pr-open' AND EXISTS (
    SELECT 1 FROM kind_handoffs h WHERE h.source_id = a.source_id AND h.assignment = a.key
    AND h.next_kind = 'review' AND h.handoff_state IN ('pending', 'failed')
  ) THEN 'review'
  WHEN a.state = 'pr-open' AND EXISTS (
    SELECT 1 FROM pull_requests p WHERE p.source_id = a.source_id AND p.assignment = a.key
  ) THEN 'pr-feedback'
  WHEN a.state IN ('ready', 'running') AND NOT EXISTS (
    SELECT 1 FROM pull_requests p WHERE p.source_id = a.source_id AND p.assignment = a.key
  ) AND NOT EXISTS (
    SELECT 1 FROM sources s, json_each(s.plan, '$.assignments') planned
    WHERE s.id = a.source_id AND json_extract(planned.value, '$.key') = a.key
    AND json_extract(planned.value, '$.adopt') IS NOT NULL
  ) THEN 'implementation'
  ELSE NULL END
WHERE a.kind IS NULL AND a.completion = 'pr' AND a.state IN ('ready', 'running', 'pr-open')
AND EXISTS (SELECT 1 FROM sources s WHERE s.id = a.source_id AND s.state = 'open')
AND NOT EXISTS (SELECT 1 FROM cleanups c WHERE c.source_id = a.source_id AND c.assignment = a.key);
--> statement-breakpoint
UPDATE pull_requests AS p
SET readiness = COALESCE(p.readiness, json_object(
  'origin', 'migration-0026',
  'head', (SELECT r.ready_head FROM internal_reviews r WHERE r.source_id = p.source_id AND r.assignment = p.assignment),
  'at', p.associated_at, 'note', NULL, 'dispositions', json('[]')
)),
parking = COALESCE(p.parking, json_object(
  'origin', 'migration-0026',
  'launchId', (SELECT l.id FROM launches l WHERE l.source_id = p.source_id AND l.assignment = p.assignment ORDER BY l.attempt DESC LIMIT 1),
  'head', COALESCE(json_extract(p.readiness, '$.head'), (SELECT r.ready_head FROM internal_reviews r WHERE r.source_id = p.source_id AND r.assignment = p.assignment)),
  'at', p.associated_at, 'note', NULL, 'state', 'parked', 'events', json('[]'), 'parentSeen', json('false')
))
WHERE EXISTS (
 SELECT 1 FROM assignments a JOIN sources s ON s.id = a.source_id
 WHERE a.source_id = p.source_id AND a.key = p.assignment AND a.kind = 'pr-feedback'
 AND a.state = 'pr-open' AND s.state = 'open'
 AND NOT EXISTS (SELECT 1 FROM cleanups c WHERE c.source_id = a.source_id AND c.assignment = a.key)
 AND EXISTS (SELECT 1 FROM issue391_null_kinds n WHERE n.source_id = a.source_id AND n.key = a.key)
);
--> statement-breakpoint
DROP TABLE issue391_null_kinds;
