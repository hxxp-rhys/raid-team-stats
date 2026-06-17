-- Email encryption at rest. The `email` column is now AES-256-GCM ciphertext
-- (random IV per row), so its old uniqueness is meaningless and exact-match
-- lookups move to a deterministic keyed blind index. Drop the email unique,
-- add + uniquely index the blind-index column (populated by the one-time
-- PII-encryption backfill; multiple NULLs are allowed for email-less users).
ALTER TABLE "User" ADD COLUMN "emailIndex" TEXT;

DROP INDEX "User_email_key";

CREATE UNIQUE INDEX "User_emailIndex_key" ON "User"("emailIndex");
