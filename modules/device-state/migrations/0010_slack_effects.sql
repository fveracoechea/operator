CREATE TABLE `slack_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`thread_ts` text NOT NULL,
	`content` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`done_at` text,
	`slack_ts` text,
	`failure` text,
	FOREIGN KEY (`request_id`) REFERENCES `review_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_effect_per_key` ON `slack_effects` (`request_id`,`key`);--> statement-breakpoint
CREATE TABLE `slack_watches` (
	`channel` text PRIMARY KEY NOT NULL,
	`cursor` text NOT NULL,
	`read_at` text,
	`latest` text,
	`pending` text
);
--> statement-breakpoint
ALTER TABLE `review_requests` ADD `slack_channel` text;--> statement-breakpoint
ALTER TABLE `review_requests` ADD `slack_ts` text;--> statement-breakpoint
ALTER TABLE `review_rounds` ADD `blockers` text;