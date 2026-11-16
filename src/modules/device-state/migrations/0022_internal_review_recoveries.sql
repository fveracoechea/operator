CREATE TABLE `internal_review_recoveries` (
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`repository` text NOT NULL,
	`implementer_launch_id` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`branch` text NOT NULL,
	`worktree_path` text NOT NULL,
	`head` text NOT NULL,
	`person_instructed` integer NOT NULL,
	`authorized_at` text NOT NULL,
	PRIMARY KEY(`source_id`, `assignment`),
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE cascade
);
