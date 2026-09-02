CREATE TABLE `slack_channels` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`is_private` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
