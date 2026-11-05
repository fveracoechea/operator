CREATE TABLE `promotions` (
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`report` text NOT NULL,
	`report_number` integer NOT NULL,
	`tracker_key` text NOT NULL,
	`instructions` text NOT NULL,
	`branch` text NOT NULL,
	`internal_review` integer,
	`worktree_path` text NOT NULL,
	`handover_launch_id` text,
	`promoted_at` text NOT NULL,
	PRIMARY KEY(`source_id`, `assignment`),
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`,`report`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_promotion_per_report` ON `promotions` (`source_id`,`report`);