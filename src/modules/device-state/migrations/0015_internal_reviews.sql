CREATE TABLE `internal_review_rounds` (
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`number` integer NOT NULL,
	`launch_id` text NOT NULL,
	`head` text NOT NULL,
	`findings` text NOT NULL,
	`recorded_at` text NOT NULL,
	PRIMARY KEY(`source_id`, `assignment`, `number`),
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `internal_reviews`(`source_id`,`assignment`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `internal_reviews` (
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`state` text NOT NULL,
	`implementer_launch_id` text NOT NULL,
	`handoff_state` text NOT NULL,
	`handoff_detail` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`owner_pid` integer,
	`lease_at` text,
	PRIMARY KEY(`source_id`, `assignment`),
	FOREIGN KEY (`implementer_launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `launches` ADD `internal_review` integer;