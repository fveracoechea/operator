CREATE TABLE `commit_deliveries` (
  `source_id` text NOT NULL,
  `assignment` text NOT NULL,
  `revision` integer NOT NULL,
  `data` text NOT NULL,
  PRIMARY KEY (`source_id`, `assignment`),
  FOREIGN KEY (`source_id`, `assignment`) REFERENCES `assignments`(`source_id`, `key`) ON UPDATE no action ON DELETE no action
);
