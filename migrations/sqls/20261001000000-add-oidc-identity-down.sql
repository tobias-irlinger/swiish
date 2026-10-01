-- Rollback: Remove OpenID Connect identity columns from users
DROP INDEX IF EXISTS idx_users_oidc_identity;

ALTER TABLE users DROP COLUMN oidc_subject;
ALTER TABLE users DROP COLUMN oidc_issuer;
