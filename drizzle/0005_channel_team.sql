ALTER TABLE `slack_channels` ADD `team` text;--> statement-breakpoint
ALTER TABLE `tracked_prs` DROP COLUMN `approvals`;--> statement-breakpoint
ALTER TABLE `tracked_prs` DROP COLUMN `required_approvals`;