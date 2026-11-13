CREATE TABLE `review_thread_operations` (
	`request_id` text NOT NULL,
	`round` integer NOT NULL,
	`thread_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text,
	`marker` text,
	`state` text NOT NULL,
	`detail` text,
	PRIMARY KEY(`request_id`, `round`, `thread_id`, `kind`),
	FOREIGN KEY (`request_id`,`round`) REFERENCES `review_rounds`(`request_id`,`number`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `one_active_review`;--> statement-breakpoint
ALTER TABLE `review_requests` ADD `trigger` text;--> statement-breakpoint
ALTER TABLE `review_requests` ADD `head_moves` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `review_requests` ADD `activity_at` text;--> statement-breakpoint
ALTER TABLE `review_requests` ADD `stale_at` text;--> statement-breakpoint
ALTER TABLE `review_requests` ADD `resolved_threads` text;--> statement-breakpoint
ALTER TABLE `review_requests` ADD `sync` text;--> statement-breakpoint
ALTER TABLE `review_requests` ADD `cleanup_state` text;--> statement-breakpoint
ALTER TABLE `review_requests` ADD `cleanup_detail` text;--> statement-breakpoint
UPDATE `review_requests` SET `state` = 'closed' WHERE `state` = 'approved' AND EXISTS (SELECT 1 FROM `review_requests` AS `newer` WHERE `newer`.`repository` = `review_requests`.`repository` AND `newer`.`number` = `review_requests`.`number` AND `newer`.`state` NOT IN ('closed', 'skipped') AND (`newer`.`requested_at` > `review_requests`.`requested_at` OR (`newer`.`requested_at` = `review_requests`.`requested_at` AND `newer`.`id` > `review_requests`.`id`)));--> statement-breakpoint
UPDATE `review_requests` SET `ended_at` = NULL WHERE `state` = 'approved';--> statement-breakpoint
UPDATE `review_requests` SET `activity_at` = (SELECT max(`posted_at`) FROM `review_rounds` WHERE `review_rounds`.`request_id` = `review_requests`.`id`) WHERE `state` IN ('watching', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX `one_open_review` ON `review_requests` (`repository`,`number`) WHERE "review_requests"."state" NOT IN ('closed', 'skipped');--> statement-breakpoint
ALTER TABLE `review_rounds` ADD `warning` text;