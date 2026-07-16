CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`char_name` text DEFAULT 'Sara' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
