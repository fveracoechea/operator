CREATE TABLE `stack_operations` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL,
  `assignment` text NOT NULL,
  `launch_id` text NOT NULL REFERENCES `launches`(`id`),
  `revision` integer NOT NULL,
  `state` text NOT NULL,
  `data` text NOT NULL,
  `review_history` text,
  `owner_pid` integer,
  `lease_at` text,
  FOREIGN KEY (`source_id`, `assignment`) REFERENCES `assignments`(`source_id`, `key`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_unfinished_stack` ON `stack_operations` (`source_id`, `assignment`) WHERE `state` NOT IN ('complete', 'cancelled');
--> statement-breakpoint
CREATE TABLE `stack_bases` (
  `source_id` text NOT NULL,
  `assignment` text NOT NULL,
  `launch_id` text NOT NULL REFERENCES `launches`(`id`),
  `branch` text NOT NULL,
  `data` text NOT NULL,
  PRIMARY KEY (`source_id`, `assignment`),
  FOREIGN KEY (`source_id`, `assignment`) REFERENCES `assignments`(`source_id`, `key`)
);
