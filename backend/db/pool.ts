import pg from "pg";

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set in environment variables.");
}

const pool = new Pool({
  connectionString,
  // Add SSL configuration for production deployments to services like Render/Heroku
  // Supabase requires SSL.
  ssl: {
    rejectUnauthorized: false,
  },
});

pool.on("connect", () => {
  console.log("Connected to the database!");
});

pool.on("error", (err: Error) => {
  console.error("Unexpected error on idle client", err);
});

export default pool;