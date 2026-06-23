ALTER TABLE `proactive_state` ADD `ignored_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `proactive_state` ADD `followup_due_at` integer;