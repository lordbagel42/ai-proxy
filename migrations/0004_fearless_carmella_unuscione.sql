CREATE TABLE `codex_model_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_identity` text NOT NULL,
	`connection_version` integer NOT NULL,
	`catalog` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
