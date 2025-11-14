import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
    throw new Error('DATABASE_URL is not set in environment variables.');
}

const pool = new Pool({
    connectionString,
    // Add SSL configuration for production deployments to services like Render/Heroku
    // Supabase requires SSL.
    ssl: {
        rejectUnauthorized: false
    }
});

pool.on('connect', () => {
    console.log('Connected to the database!');
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
    // Removed process.exit(-1) to prevent crashing the entire application on an idle error.
    // Let the application owner decide on a restart strategy.
});

export default pool;