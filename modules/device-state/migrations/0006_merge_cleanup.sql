CREATE TABLE `cleanups` (
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`launch_id` text NOT NULL,
	`step` text,
	`state` text NOT NULL,
	`reason` text,
	`detail` text,
	`updated_at` text NOT NULL,
	`owner_pid` integer,
	`lease_at` text,
	PRIMARY KEY(`source_id`, `assignment`),
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merged_head` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merge_commit` text;--> statement-breakpoint
ALTER TABLE `pull_requests` ADD `merged_at` text;