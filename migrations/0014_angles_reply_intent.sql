-- Phase I — what each email led with, and what each reply meant.
--
-- Additive only. Safe to apply while the previous release is serving (it
-- neither reads nor writes these columns); re-running is a no-op.
--
-- `angle` is the one reason an email was written (src/lib/outreach/angles.ts):
-- no_website, social_only, website_performance, … or general. Stored so
-- replies can be counted by angle and the approach that works can be found.
--
-- `reply_intent` is what a reply meant (src/lib/outreach/replies.ts):
-- positive, neutral, negative, objection, ooo, unsubscribe, referral,
-- wrong_person, later. A suggestion for a person to confirm — it never sends
-- anything by itself.
alter table outreach_emails add column if not exists angle        text not null default '';
alter table outreach_emails add column if not exists reply_intent text not null default '';
