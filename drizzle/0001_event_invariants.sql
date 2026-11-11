-- Atomic economic state. The API never updates balances directly.
CREATE TRIGGER purchase_validate BEFORE INSERT ON purchases BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM events WHERE id=NEW.event_id AND status='active' AND starts_at <= CAST(strftime('%s','now') AS INTEGER)*1000
  ) THEN RAISE(ABORT,'EVENT_UNAVAILABLE') END;
  SELECT CASE WHEN (SELECT sold_tickets+NEW.quantity>total_tickets FROM events WHERE id=NEW.event_id)
    THEN RAISE(ABORT,'NOT_ENOUGH_TICKETS') END;
  SELECT CASE WHEN (SELECT balance FROM users WHERE id=NEW.user_id) < NEW.quantity*(SELECT ticket_price FROM events WHERE id=NEW.event_id)
    THEN RAISE(ABORT,'INSUFFICIENT_BALANCE') END;
  SELECT CASE WHEN NEW.draw_number < 1 OR NEW.draw_number > (SELECT total_tickets FROM events WHERE id=NEW.event_id)
    THEN RAISE(ABORT,'INVALID_DRAW') END;
END;
--> statement-breakpoint
CREATE TRIGGER ticket_range BEFORE INSERT ON tickets BEGIN
  SELECT CASE WHEN NEW.number < 1 OR NEW.number > (SELECT total_tickets FROM events WHERE id=NEW.event_id)
    THEN RAISE(ABORT,'INVALID_TICKET_NUMBER') END;
END;
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
      CASE WHEN t.user_id=e.winner_user_id THEN 'Вы победили в тестовом розыгрыше!' ELSE 'Розыгрыш завершён' END,
      e.title||'. Победил билет №'||e.winner_ticket||'. '||
      CASE WHEN t.user_id=e.winner_user_id THEN 'Напишите администрации через карточку результата. Это демонстрационный приз, фактической выдачи нет.'
        ELSE 'Спасибо за участие! Посмотрите результат в разделе «Результаты».' END,0,NEW.created_at
    FROM (SELECT DISTINCT user_id FROM tickets WHERE event_id=NEW.event_id) t
    JOIN events e ON e.id=NEW.event_id WHERE e.status='completed' AND e.drawn_at=NEW.created_at;
END;
--> statement-breakpoint
CREATE UNIQUE INDEX request_one_pending ON coin_requests(user_id) WHERE status='pending';
--> statement-breakpoint
CREATE TRIGGER coin_review_validate BEFORE UPDATE OF status ON coin_requests WHEN NEW.status<>OLD.status BEGIN
  SELECT CASE WHEN OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected') THEN RAISE(ABORT,'INVALID_REQUEST_REVIEW') END;
  SELECT CASE WHEN NEW.reviewed_by IS NULL OR NEW.reviewed_by<>(SELECT value FROM app_meta WHERE key='admin_user_id')
    THEN RAISE(ABORT,'NOT_ADMIN') END;
END;
--> statement-breakpoint
CREATE TRIGGER coin_review_apply AFTER UPDATE OF status ON coin_requests WHEN OLD.status='pending' AND NEW.status IN ('approved','rejected') BEGIN
  UPDATE users SET balance=balance+NEW.amount WHERE id=NEW.user_id AND NEW.status='approved';
  INSERT INTO ledger (id,user_id,label,amount,reference_id,created_at)
    SELECT 'credit:'||NEW.id,NEW.user_id,'Начисление по запросу',NEW.amount,NEW.id,NEW.reviewed_at WHERE NEW.status='approved';
  INSERT INTO notifications (id,user_id,title,message,read,created_at)
    VALUES ('request:'||NEW.id,NEW.user_id,
      CASE WHEN NEW.status='approved' THEN 'Монеты уже на балансе' ELSE 'Запрос рассмотрен' END,
      CASE WHEN NEW.status='approved' THEN 'Администратор бесплатно начислил '||NEW.amount||' игровых монет.'
        ELSE 'Администратор отклонил запрос. Вы можете написать в поддержку или отправить новый запрос.' END,0,NEW.reviewed_at);
END;
