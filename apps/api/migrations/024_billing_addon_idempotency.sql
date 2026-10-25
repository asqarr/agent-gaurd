CREATE UNIQUE INDEX IF NOT EXISTS billing_addon_purchases_checkout_uidx
  ON billing_addon_purchases (checkout_session_id);
