ALTER TABLE `pull_requests` ADD `parking` text;
--> statement-breakpoint
CREATE TABLE `parked_pr_reads` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_read_at` text,
	`owner_pid` integer,
	`lease_at` text
);
