CREATE TABLE `assignments` (
	`source_id` text NOT NULL,
	`key` text NOT NULL,
	`completion` text NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`source_id`, `key`),
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`tracker_key` text NOT NULL,
	`state` text NOT NULL,
	`registered_at` text NOT NULL,
	`ended_at` text,
	`plan` text NOT NULL,
	FOREIGN KEY (`repository`) REFERENCES `projects`(`repository`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_open_parent` ON `sources` (`repository`,`tracker_key`) WHERE "sources"."state" = 'open';