-- What each outreach email was personalised from.
--
-- The email itself is not enough to answer "why did it say that?" months later,
-- because the lead row it was built from may have changed since. Storing the
-- evidence alongside the email makes any claim in a sent message traceable to
-- the facts that justified it at the time.
--
-- Additive only: one nullable column with a default. Nothing is rewritten, no
-- existing row changes, and re-running is a no-op.
alter table outreach_emails
  add column if not exists personalisation_evidence text not null default '';
