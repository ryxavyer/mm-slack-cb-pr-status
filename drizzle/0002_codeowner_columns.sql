ALTER TABLE `tracked_prs` ADD `codeowner_status` text;
--> statement-breakpoint
ALTER TABLE `pr_messages` ADD `required_team` text;