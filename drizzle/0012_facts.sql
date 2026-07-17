CREATE TABLE `facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer NOT NULL,
	`category` text NOT NULL,
	`content` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_facts_chat` ON `facts` (`chat_id`,`deleted`,`category`);--> statement-breakpoint
CREATE TABLE `facts_state` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`last_done_start` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
