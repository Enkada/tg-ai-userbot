CREATE TABLE `photo_gens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer,
	`message_id` integer,
	`prose` text NOT NULL,
	`tags` text NOT NULL,
	`seed` integer,
	`upscaled` integer DEFAULT true NOT NULL,
	`job_id` text,
	`delay_ms` integer,
	`exec_ms` integer,
	`status` text NOT NULL,
	`error` text,
	`file_path` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_photo_gens_chat` ON `photo_gens` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_photo_gens_message` ON `photo_gens` (`message_id`);--> statement-breakpoint
ALTER TABLE `settings` ADD `img_upscale` integer DEFAULT true NOT NULL;