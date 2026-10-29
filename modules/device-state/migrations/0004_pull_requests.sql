CREATE TABLE `pull_requests` (
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`branch` text NOT NULL,
	`associated_at` text NOT NULL,
	`progress` text NOT NULL,
	`wait_state` text NOT NULL,
	`wait_at` text,
	`wait_owner_pid` integer,
	`wait_lease_at` text,
	PRIMARY KEY(`source_id`, `assignment`),
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action
);
