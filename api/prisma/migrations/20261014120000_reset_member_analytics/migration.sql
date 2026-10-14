-- One-off data reset. Until 2026-10-14 the API and the worker hashed WhatsApp
-- members with different salts, so every worker snapshot re-identified the
-- whole group as "everyone left, everyone joined". All membership data
-- collected so far is unreliable; start over with a fresh baseline (the next
-- participant snapshot recreates it under the shared salt).
DELETE FROM "WaMemberEvent";
DELETE FROM "WaMember";
DELETE FROM "WaGroupSnapshot";
