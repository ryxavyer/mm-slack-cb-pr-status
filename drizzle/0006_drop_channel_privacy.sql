ALTER TABLE `slack_channels` DROP COLUMN `is_private`;--> statement-breakpoint
DELETE FROM `slack_channels` WHERE `team` IS NULL;
