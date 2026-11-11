CREATE TABLE `admin_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_id` text NOT NULL,
	`details` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `admin_audit_time` ON `admin_audit` (`created_at`);--> statement-breakpoint
CREATE TABLE `balance_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`user_id` text NOT NULL,
	`amount` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_adjustments_request_id_unique` ON `balance_adjustments` (`request_id`);--> statement-breakpoint
CREATE TABLE `support_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`is_admin` integer DEFAULT 0 NOT NULL,
	`internal` integer DEFAULT 0 NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `support_threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `support_messages_thread_time` ON `support_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `support_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`subject` text NOT NULL,
	`event_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`user_read_at` integer DEFAULT 0 NOT NULL,
	`staff_read_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `support_threads_user_updated` ON `support_threads` (`user_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
CREATE TRIGGER purchase_operational_guard BEFORE INSERT ON purchases BEGIN
  SELECT CASE WHEN (SELECT status FROM users WHERE id=NEW.user_id)='blocked' THEN RAISE(ABORT,'USER_BLOCKED') END;
  SELECT CASE WHEN COALESCE((SELECT json_extract(value,'$.participationEnabled') FROM app_meta WHERE key='project_settings'),1)=0 THEN RAISE(ABORT,'PARTICIPATION_PAUSED') END;
END;
--> statement-breakpoint
DROP TRIGGER coin_review_validate;
--> statement-breakpoint
CREATE TRIGGER coin_review_validate BEFORE UPDATE OF status ON coin_requests WHEN NEW.status<>OLD.status BEGIN
  SELECT CASE WHEN OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected') THEN RAISE(ABORT,'INVALID_REQUEST_REVIEW') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.reviewed_by AND status='active' AND (role='admin' OR id=(SELECT value FROM app_meta WHERE key='admin_user_id'))) THEN RAISE(ABORT,'NOT_ADMIN') END;
  SELECT CASE WHEN NEW.status='approved' AND (SELECT status FROM users WHERE id=NEW.user_id)='blocked' THEN RAISE(ABORT,'USER_BLOCKED') END;
END;
--> statement-breakpoint
CREATE TRIGGER event_protect_result BEFORE UPDATE ON events WHEN OLD.status IN ('completed','cancelled') BEGIN
  SELECT RAISE(ABORT,'EVENT_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER event_protect_terms BEFORE UPDATE OF total_tickets,ticket_price,starts_at,region,city ON events WHEN OLD.sold_tickets>0 BEGIN
  SELECT CASE WHEN NEW.total_tickets<>OLD.total_tickets OR NEW.ticket_price<>OLD.ticket_price OR NEW.starts_at<>OLD.starts_at OR NEW.region<>OLD.region OR NEW.city<>OLD.city THEN RAISE(ABORT,'EVENT_TERMS_LOCKED') END;
END;
--> statement-breakpoint
CREATE TRIGGER event_cancel_refund AFTER UPDATE OF status ON events WHEN NEW.status='cancelled' AND OLD.status<>'cancelled' BEGIN
  INSERT INTO ledger (id,user_id,label,amount,reference_id,created_at)
    SELECT 'refund:'||p.id,p.user_id,'Возврат: '||NEW.title,-l.amount,'refund:'||p.id,CAST(strftime('%s','now') AS INTEGER)*1000
    FROM purchases p JOIN ledger l ON l.reference_id=p.id WHERE p.event_id=NEW.id;
  UPDATE users SET balance=balance+COALESCE((SELECT SUM(-l.amount) FROM purchases p JOIN ledger l ON l.reference_id=p.id WHERE p.event_id=NEW.id AND p.user_id=users.id),0)
    WHERE id IN (SELECT user_id FROM purchases WHERE event_id=NEW.id);
  INSERT INTO notifications (id,user_id,title,message,read,created_at)
    SELECT 'cancel:'||NEW.id||':'||t.user_id,t.user_id,'Розыгрыш отменён',NEW.title||'. Игровые монеты за полученные билеты возвращены на баланс.',0,CAST(strftime('%s','now') AS INTEGER)*1000
    FROM (SELECT DISTINCT user_id FROM purchases WHERE event_id=NEW.id) t;
END;
--> statement-breakpoint
CREATE TRIGGER adjustment_validate BEFORE INSERT ON balance_adjustments BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_id AND status='active' AND (role='admin' OR id=(SELECT value FROM app_meta WHERE key='admin_user_id'))) THEN RAISE(ABORT,'NOT_ADMIN') END;
  SELECT CASE WHEN NEW.amount=0 OR ABS(NEW.amount)>100000 OR (SELECT balance FROM users WHERE id=NEW.user_id)+NEW.amount<0 THEN RAISE(ABORT,'INVALID_ADJUSTMENT') END;
END;
--> statement-breakpoint
CREATE TRIGGER adjustment_apply AFTER INSERT ON balance_adjustments BEGIN
  UPDATE users SET balance=balance+NEW.amount WHERE id=NEW.user_id;
  INSERT INTO ledger (id,user_id,label,amount,reference_id,created_at) VALUES ('adjust:'||NEW.id,NEW.user_id,'Корректировка: '||NEW.reason,NEW.amount,'adjust:'||NEW.id,NEW.created_at);
  INSERT INTO notifications (id,user_id,title,message,read,created_at) VALUES ('adjust:'||NEW.id,NEW.user_id,'Баланс обновлён',NEW.reason||'. Изменение: '||NEW.amount||' монет.',0,NEW.created_at);
  INSERT INTO admin_audit (id,actor_id,action,target_id,details,created_at) VALUES ('adjust:'||NEW.id,NEW.actor_id,'balance.adjust',NEW.user_id,NEW.reason||' ('||NEW.amount||')',NEW.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER owner_protection BEFORE UPDATE OF role,status ON users WHEN OLD.id=(SELECT value FROM app_meta WHERE key='admin_user_id') BEGIN
  SELECT CASE WHEN NEW.status<>'active' OR NEW.role<>OLD.role THEN RAISE(ABORT,'OWNER_PROTECTED') END;
END;
