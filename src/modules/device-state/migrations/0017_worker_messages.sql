CREATE TABLE `worker_messages` (
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`key` text NOT NULL,
	`launch_id` text NOT NULL,
	`message` text NOT NULL,
	`question_key` text,
	`sent_at` text NOT NULL,
	`state` text NOT NULL,
	`rung_at` text,
	`doorbell_failure` text,
	`acknowledged_at` text,
	`reply` text,
	`ended_at` text,
	PRIMARY KEY(`source_id`, `assignment`, `key`),
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action
);
