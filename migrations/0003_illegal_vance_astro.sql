CREATE TABLE `usage_event` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`protocol` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `usage_event_started` ON `usage_event` (`started_at`);--> statement-breakpoint
CREATE INDEX `usage_event_user_started` ON `usage_event` (`user_id`,`started_at`);