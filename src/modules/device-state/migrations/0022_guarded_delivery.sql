CREATE TABLE `deliveries` (
	`request_uuid` text,
	`id` text PRIMARY KEY NOT NULL,
	`launch_id` text NOT NULL,
	`head` text NOT NULL,
	`ready_head` text,
	`session` text,
	`selected` integer NOT NULL,
	`owner_pid` integer,
	`lease_at` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `delivery_validations` (
	`id` text PRIMARY KEY NOT NULL,
	`launch_id` text NOT NULL,
	`head` text NOT NULL,
	`ready_head` text NOT NULL,
	`summary` text NOT NULL,
	`validated_at` text NOT NULL,
	FOREIGN KEY (`launch_id`) REFERENCES `launches`(`id`) ON UPDATE no action ON DELETE cascade
);
