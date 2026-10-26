CREATE TABLE `projects` (
	`repository` text PRIMARY KEY NOT NULL,
	`checkout` text NOT NULL,
	`registered_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_checkout_unique` ON `projects` (`checkout`);