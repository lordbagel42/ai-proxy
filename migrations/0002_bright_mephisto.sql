CREATE TABLE `proxy_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`target_identity` text,
	`daily_limit` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`redeemed_identity` text,
	`redeemed_at` integer,
	`revoked_at` integer,
	`redemption_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_invite_token_hash` ON `proxy_invite` (`token_hash`);--> statement-breakpoint
CREATE INDEX `proxy_invite_expiry` ON `proxy_invite` (`expires_at`);--> statement-breakpoint
CREATE TABLE `proxy_member` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`daily_limit` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
