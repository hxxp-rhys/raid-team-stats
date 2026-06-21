-- Dedicated audit event for recruitment form deletion. Previously destructive
-- actions reused another event with metadata.action as a stopgap; this is the
-- first dedicated *_DELETED event. Postgres ALTER TYPE ADD VALUE appends to the
-- enum; existing AuditLog rows are unaffected and the new value is NOT used in
-- this migration, so it is safe within Prisma's migration transaction.
ALTER TYPE "AuditEvent" ADD VALUE 'RECRUITMENT_FORM_DELETED';
