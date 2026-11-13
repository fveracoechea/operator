CREATE TABLE `coordination_waits` (
	`repository` text NOT NULL,
	`scope` text NOT NULL,
	`actions` text,
	`returned_at` text,
	`owner_pid` integer,
	`lease_at` text,
	`pane_id` text,
	`started_at` text,
	PRIMARY KEY(`repository`, `scope`),
	FOREIGN KEY (`repository`) REFERENCES `projects`(`repository`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `sources` ADD `supervising_pane` text;