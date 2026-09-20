ALTER TABLE `proxy_invite` ADD `max_uses` integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE `proxy_invite` ADD `use_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `proxy_invite` SET `use_count` = 1 WHERE `redeemed_at` IS NOT NULL;
