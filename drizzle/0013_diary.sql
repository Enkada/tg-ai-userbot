CREATE TABLE `diary_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content` text NOT NULL,
	`tg_message_id` integer,
	`cue` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `diary_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`plan_day` text,
	`due_times` text,
	`next_idx` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
