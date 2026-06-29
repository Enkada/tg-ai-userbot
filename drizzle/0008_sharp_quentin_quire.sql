CREATE TABLE `summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`level` integer DEFAULT 0 NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`content` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_summaries_chat` ON `summaries` (`chat_id`,`level`,`deleted`,`period_start`);--> statement-breakpoint
CREATE TABLE `summary_state` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`last_done_start` integer,
	`user_name` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
