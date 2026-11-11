CREATE TABLE `obligations` (
	`source_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`reference` text,
	`opened_at` text NOT NULL,
	`state` text NOT NULL,
	`closed_at` text,
	PRIMARY KEY(`source_id`, `key`),
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
