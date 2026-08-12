CREATE TABLE `pr_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pr_id` integer NOT NULL,
	`channel_id` text NOT NULL,
	`message_ts` text NOT NULL,
	`current_reaction` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`pr_id`) REFERENCES `tracked_prs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_messages_pr_channel_ts_idx` ON `pr_messages` (`pr_id`,`channel_id`,`message_ts`);--> statement-breakpoint
CREATE INDEX `pr_messages_pr_id_idx` ON `pr_messages` (`pr_id`);--> statement-breakpoint
CREATE TABLE `tracked_prs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`number` integer NOT NULL,
	`state` text DEFAULT 'no_reviews' NOT NULL,
	`approvals` integer DEFAULT 0 NOT NULL,
	`required_approvals` integer NOT NULL,
	`last_polled_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracked_prs_owner_repo_number_idx` ON `tracked_prs` (`owner`,`repo`,`number`);--> statement-breakpoint
CREATE INDEX `tracked_prs_state_idx` ON `tracked_prs` (`state`);