CREATE TABLE `kind_handoffs` (
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`outgoing_launch_id` text NOT NULL,
	`next_kind` text NOT NULL,
	`handoff_state` text NOT NULL,
	`handoff_detail` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`owner_pid` integer,
	`lease_at` text,
	PRIMARY KEY(`source_id`, `assignment`),
	FOREIGN KEY (`outgoing_launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `kind_handoffs`
SELECT `source_id`, `assignment`, `implementer_launch_id`, 'review', `handoff_state`, `handoff_detail`, `started_at`, `updated_at`, `owner_pid`, `lease_at`
FROM `internal_reviews`;
