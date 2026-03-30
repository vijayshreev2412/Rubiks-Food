"use strict";

const { Pool } = require("pg");

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/tasks_db";

const pool = new Pool({ connectionString });

async function init() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      worker_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;

  await pool.query(createTableQuery);
  await pool.query(
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worker_attempts INTEGER NOT NULL DEFAULT 0"
  );
  await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_error TEXT");
  await pool.query(
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"
  );
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  init,
};
