CREATE TABLE `codex_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_identity` text NOT NULL,
	`credentials` text,
	`pending` text,
	`expires_at` integer,
	`needs_reconnect` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lock_id` text,
	`lock_expires_at` integer DEFAULT 0 NOT NULL,
	`next_poll_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `codex_request` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `codex_request_expiry` ON `codex_request` (`expires_at`);