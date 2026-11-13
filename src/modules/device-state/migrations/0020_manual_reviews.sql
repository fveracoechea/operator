DROP TABLE `slack_effects`;--> statement-breakpoint
DROP TABLE `slack_watches`;--> statement-breakpoint
ALTER TABLE `review_requests` ADD `slack_thread` text;--> statement-breakpoint
UPDATE `review_requests` SET `origin` = 'manual' WHERE `origin` = 'slack';--> statement-breakpoint
UPDATE `review_requests` SET `slack_thread` = 'https://slack.com/archives/' || `slack_channel` || '/p' || replace(`slack_ts`, '.', '') WHERE `slack_channel` IS NOT NULL AND `slack_ts` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `review_requests` DROP COLUMN `slack_channel`;--> statement-breakpoint
ALTER TABLE `review_requests` DROP COLUMN `slack_ts`;
