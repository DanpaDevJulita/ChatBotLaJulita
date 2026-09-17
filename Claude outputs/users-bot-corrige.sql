-- Migration: Add bot correction support to users table
-- Purpose: Allow marking specific users as authorized to report faults and teach the bot
-- Run this in: Supabase SQL Editor for LaJulitaWeb

-- Add columns to users table if they don't exist
DO $$
BEGIN
  -- Add celular column (phone number) if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'celular'
  ) THEN
    ALTER TABLE users ADD COLUMN celular text;
  END IF;

  -- Add bot_puede_corregir column (authorization flag) if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'bot_puede_corregir'
  ) THEN
    ALTER TABLE users ADD COLUMN bot_puede_corregir boolean DEFAULT false;
  END IF;
END $$;

-- Create generated column celular_clave (last 10 digits) if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'celular_clave'
  ) THEN
    ALTER TABLE users
    ADD COLUMN celular_clave text
    GENERATED ALWAYS AS (
      SUBSTRING(
        REGEXP_REPLACE(celular, '\D', '', 'g'),
        LENGTH(REGEXP_REPLACE(celular, '\D', '', 'g')) - 9
      )
    ) STORED;
  END IF;
END $$;

-- Create unique index on celular_clave (for fast lookups)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_celular_clave
ON users (celular_clave)
WHERE celular_clave IS NOT NULL;

-- Create index on bot_puede_corregir for WHERE clauses
CREATE INDEX IF NOT EXISTS idx_users_bot_puede_corregir
ON users (bot_puede_corregir)
WHERE bot_puede_corregir = true;

-- Column-level grant: Allow bot_lajulita role to read only the columns it needs
-- This is safer than table-level access and prevents password/sensitive data leaks
GRANT SELECT (id, name, activo, celular_clave, bot_puede_corregir) ON users TO bot_lajulita;
