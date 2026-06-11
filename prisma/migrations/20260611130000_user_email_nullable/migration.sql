-- Battle.net becomes a primary sign-in identity. Battle.net OAuth exposes no
-- email (only sub + battle_tag), so a Battle.net-first signup creates a user
-- with NO email. Relax the NOT NULL constraint on User.email.
--
-- The existing UNIQUE index on email is preserved: Postgres treats NULLs as
-- distinct, so any number of email-less Battle.net users coexist without
-- collision. Credential (email/password) users still always have an email.
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;
