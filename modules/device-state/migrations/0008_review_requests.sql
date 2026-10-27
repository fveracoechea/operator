CREATE TABLE `review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`origin` text NOT NULL,
	`source_id` text,
	`assignment` text,
	`state` text NOT NULL,
	`requested_at` text NOT NULL,
	`ended_at` text,
	`launch_state` text,
	`launch` text,
	`name` text,
	`branch` text,
	`head` text,
	`herdr_socket` text,
	`workspace_id` text,
	`tab_id` text,
	`pane_id` text,
	`worktree_path` text,
	`worktree_workspace_id` text,
	`failure_reason` text,
	`failure_detail` text,
	`owner_pid` integer,
	`lease_at` text,
	FOREIGN KEY (`repository`) REFERENCES `projects`(`repository`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_requests_name_unique` ON `review_requests` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_active_review` ON `review_requests` (`repository`,`number`) WHERE "review_requests"."state" NOT IN ('approved', 'closed', 'skipped');--> statement-breakpoint
CREATE TABLE `review_rounds` (
	`request_id` text NOT NULL,
	`number` integer NOT NULL,
	`trigger` text NOT NULL,
	`reviewed_commit` text NOT NULL,
	`draft` text NOT NULL,
	`event` text NOT NULL,
	`body` text NOT NULL,
	`marker` text NOT NULL,
	`outcome` text NOT NULL,
	`review_id` text,
	`review_url` text,
	`posted_at` text,
	PRIMARY KEY(`request_id`, `number`),
	FOREIGN KEY (`request_id`) REFERENCES `review_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
