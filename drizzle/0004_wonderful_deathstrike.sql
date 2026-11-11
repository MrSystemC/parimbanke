CREATE TABLE `prize_images` (
	`id` text PRIMARY KEY NOT NULL,
	`storage_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prize_images_storage_key_unique` ON `prize_images` (`storage_key`);--> statement-breakpoint
CREATE INDEX `prize_images_creator` ON `prize_images` (`created_by`,`created_at`);--> statement-breakpoint
ALTER TABLE `events` ADD `prize_type` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `prize_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `image_id` text REFERENCES prize_images(id);
--> statement-breakpoint
CREATE TRIGGER legacy_seed_purchase_guard BEFORE INSERT ON purchases WHEN EXISTS (SELECT 1 FROM events WHERE id=NEW.event_id AND (is_demo=1 OR id IN ('demo-headphones','demo-speaker','demo-camera','demo-console','demo-completed'))) BEGIN
  SELECT RAISE(ABORT,'EVENT_ARCHIVED');
END;
--> statement-breakpoint
CREATE TRIGGER legacy_seed_resume_guard BEFORE UPDATE OF status ON events WHEN NEW.status='active' AND (OLD.is_demo=1 OR OLD.id IN ('demo-headphones','demo-speaker','demo-camera','demo-console','demo-completed')) BEGIN
  SELECT RAISE(ABORT,'EVENT_ARCHIVED');
END;
--> statement-breakpoint
DROP TRIGGER purchase_apply;
--> statement-breakpoint
CREATE TRIGGER purchase_apply AFTER INSERT ON purchases BEGIN
  INSERT INTO tickets (id,event_id,user_id,number,purchase_id,created_at)
    SELECT NEW.id || ':' || n, NEW.event_id, NEW.user_id,
      (SELECT sold_tickets FROM events WHERE id=NEW.event_id)+n, NEW.id, NEW.created_at
    FROM (WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < NEW.quantity) SELECT n FROM seq);
  UPDATE users SET balance=balance-NEW.quantity*(SELECT ticket_price FROM events WHERE id=NEW.event_id) WHERE id=NEW.user_id;
  INSERT INTO ledger (id,user_id,label,amount,reference_id,created_at)
    SELECT 'purchase:'||NEW.id,NEW.user_id,'Билеты: '||title,-NEW.quantity*ticket_price,NEW.id,NEW.created_at FROM events WHERE id=NEW.event_id;
  UPDATE events SET sold_tickets=sold_tickets+NEW.quantity WHERE id=NEW.event_id;
  UPDATE events SET status='completed',winner_ticket=NEW.draw_number,
      winner_user_id=(SELECT user_id FROM tickets WHERE event_id=NEW.event_id AND number=NEW.draw_number),drawn_at=NEW.created_at
    WHERE id=NEW.event_id AND sold_tickets=total_tickets AND status='active';
  INSERT INTO notifications (id,user_id,title,message,read,created_at)
    VALUES ('purchase:'||NEW.id,NEW.user_id,'Ваши билеты готовы','Билеты закреплены за вашим ID. Результат появится после выдачи последнего билета.',0,NEW.created_at);
  INSERT INTO notifications (id,user_id,title,message,read,created_at)
    SELECT 'draw:'||NEW.id||':'||t.user_id,t.user_id,
      CASE WHEN t.user_id=e.winner_user_id THEN 'Вы победили в розыгрыше!' ELSE 'Розыгрыш завершён' END,
      e.title||'. Победил билет №'||e.winner_ticket||'. '||
      CASE WHEN t.user_id=e.winner_user_id THEN 'Напишите администрации через карточку результата, чтобы согласовать получение приза.'
        ELSE 'Спасибо за участие! Посмотрите результат в разделе «Результаты».' END,0,NEW.created_at
    FROM (SELECT DISTINCT user_id FROM tickets WHERE event_id=NEW.event_id) t
    JOIN events e ON e.id=NEW.event_id WHERE e.status='completed' AND e.drawn_at=NEW.created_at;
END;
