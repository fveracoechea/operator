CREATE TABLE `launches` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`assignment` text NOT NULL,
	`attempt` integer NOT NULL,
	`state` text NOT NULL,
	`name` text NOT NULL,
	`resources` text NOT NULL,
	`branch` text,
	`host` text NOT NULL,
	`model` text NOT NULL,
	`requested_model` text NOT NULL,
	`reasoning_effort` text NOT NULL,
	`profile` text,
	`release` text NOT NULL,
	`skills` text NOT NULL,
	`herdr_socket` text,
	`workspace_id` text,
	`tab_id` text,
	`pane_id` text,
	`worktree_path` text,
	`worktree_workspace_id` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`failure_reason` text,
	`failure_detail` text,
	`activity` text,
	`activity_at` text,
	`owner_pid` integer,
	`lease_at` text,
	FOREIGN KEY (`source_id`,`assignment`) REFERENCES `assignments`(`source_id`,`key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `launches_name_unique` ON `launches` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_attempt_number` ON `launches` (`source_id`,`assignment`,`attempt`);--> statement-breakpoint
CREATE TABLE `worktree_preparations` (
	`path` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`state` text NOT NULL,
	`detail` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`owner_pid` integer,
	`lease_at` text,
	FOREIGN KEY (`repository`) REFERENCES `projects`(`repository`) ON UPDATE no action ON DELETE cascade
);
