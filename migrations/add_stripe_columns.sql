-- Add Stripe subscription columns back to profiles table
-- Run this in Supabase Dashboard → SQL Editor

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS name text DEFAULT '',
  ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS subscription_end timestamptz;

-- Index for webhook lookups (find user by stripe_customer_id)
CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer
  ON profiles (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Verify columns exist
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'profiles'
  AND column_name IN ('name', 'subscription_status', 'stripe_customer_id', 'subscription_end');
