CREATE TABLE `proactive_state` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`due_at` integer,
	`is_morning` integer DEFAULT false NOT NULL,
	`user_name` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `proactive` integer DEFAULT false NOT NULL;