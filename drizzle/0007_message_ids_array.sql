ALTER TABLE `messages` ADD `tg_message_ids` text;--> statement-breakpoint
UPDATE `messages` SET `tg_message_ids` = '[' || `tg_message_id` || ']' WHERE `tg_message_id` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `tg_message_id`;
