--> statement-breakpoint
CREATE TRIGGER coin_request_operational_guard BEFORE INSERT ON coin_requests BEGIN
  SELECT CASE WHEN (SELECT status FROM users WHERE id=NEW.user_id)='blocked' THEN RAISE(ABORT,'USER_BLOCKED') END;
  SELECT CASE WHEN COALESCE((SELECT json_extract(value,'$.coinRequestsEnabled') FROM app_meta WHERE key='project_settings'),1)=0 THEN RAISE(ABORT,'COIN_REQUESTS_PAUSED') END;
END;
--> statement-breakpoint
CREATE TRIGGER support_thread_operational_guard BEFORE INSERT ON support_threads WHEN NEW.id NOT LIKE 'legacy:%' BEGIN
  SELECT CASE WHEN COALESCE((SELECT json_extract(value,'$.supportEnabled') FROM app_meta WHERE key='project_settings'),1)=0
    AND NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND status='active' AND (role IN ('admin','moderator') OR id=(SELECT value FROM app_meta WHERE key='admin_user_id')))
    THEN RAISE(ABORT,'SUPPORT_PAUSED') END;
END;
