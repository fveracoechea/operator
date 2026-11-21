CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`launch_id` text NOT NULL,
	`head` text NOT NULL,
	`readiness` text,
	`selected` integer NOT NULL,
	`session` text,
	`request_uuid` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`owner_pid` integer,
	`lease_at` text,
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_unfinished_delivery` ON `deliveries` (`source_id`,`assignment`) WHERE "deliveries"."ended_at" IS NULL;--> statement-breakpoint
CREATE TABLE `delivery_validations` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`launch_id` text NOT NULL,
	`head` text NOT NULL,
	`readiness` text NOT NULL,
	`summary` text NOT NULL,
	`validated_at` text NOT NULL,
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action
);
