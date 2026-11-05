CREATE TABLE `worker_questions` (
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`key` text NOT NULL,
	`launch_id` text NOT NULL,
	`question` text NOT NULL,
	`asked_at` text NOT NULL,
	`state` text NOT NULL,
	`answer` text,
	`answered_by` text,
	`answered_at` text,
	`ended_at` text,
	PRIMARY KEY(`source_id`, `assignment`, `key`),
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action
);
