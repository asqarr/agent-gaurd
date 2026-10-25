UPDATE subscription_plans
SET price_usd_cents=4900
WHERE id='builder';

UPDATE subscription_plans
SET price_usd_cents=14900
WHERE id='team';

UPDATE subscription_plans
SET price_usd_cents=39900
WHERE id='agency';
