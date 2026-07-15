UPDATE users
SET password_hash = 'pbkdf2_sha256$100000$Z210LXByZXZpZXctc2FsdA$mC750WqADhKCN332w-WCRoVhAuKGw7Hvzv9jLseosSE'
WHERE username IN ('test_admin', 'test_encoder', 'test_viewer', 'test_accounting');
