-- Per-account colour theme. Chosen in My Profile, applied on every device after sign-in.
-- Values are validated against src/shared/themes.ts; an unknown id falls back to 'charcoal'.
ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'charcoal';
