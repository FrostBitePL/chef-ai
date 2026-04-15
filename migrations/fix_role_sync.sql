-- Fix role synchronization with subscription_status
-- Users with active subscription should have role = 'pro'
-- Users with canceled/free subscription should have role = 'free'

UPDATE profiles 
SET role = 'pro' 
WHERE subscription_status = 'active' AND role != 'admin';

UPDATE profiles 
SET role = 'free' 
WHERE subscription_status IN ('free', 'canceled') AND role != 'admin';

-- Verify the changes
SELECT id, subscription_status, role 
FROM profiles 
ORDER BY subscription_status, role;
