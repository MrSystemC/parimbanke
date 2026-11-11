-- The advertised prize identity becomes immutable as soon as a ticket is issued.
-- A separate guard preserves all earlier migrations and protects concurrent edits.
CREATE TRIGGER event_protect_prize_identity
BEFORE UPDATE OF prize_type,prize_name,image_id ON events
WHEN OLD.sold_tickets > 0
BEGIN
  SELECT CASE WHEN NEW.prize_type IS NOT OLD.prize_type
    OR NEW.prize_name IS NOT OLD.prize_name
    OR NEW.image_id IS NOT OLD.image_id
    THEN RAISE(ABORT,'PRIZE_IDENTITY_LOCKED') END;
END;
