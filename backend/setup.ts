import 'dotenv/config'; // Must be at the top
import pool from './db.js';
import bcrypt from 'bcryptjs';

const setupDatabase = async () => {
  console.log('Starting database setup...');
  const client = await pool.connect();

  try {
    await client.query('BEGIN'); // Start transaction

    console.log('1. Creating custom types...');
    await client.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_state_enum') THEN
                CREATE TYPE app_state_enum AS ENUM ('idle', 'loading', 'success', 'error', 'processing');
            ELSIF NOT EXISTS (
                SELECT 1 FROM pg_enum WHERE enumtypid = 'app_state_enum'::regtype AND enumlabel = 'processing'
            ) THEN
                ALTER TYPE app_state_enum ADD VALUE 'processing';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role_enum') THEN
                CREATE TYPE user_role_enum AS ENUM ('admin', 'user');
            END IF;
        END$$;
    `);

    console.log('2. Creating users table...');
    await client.query(`
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            username VARCHAR(50) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role user_role_enum NOT NULL DEFAULT 'user',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `);

    console.log('3. Creating cases table...');
    await client.query(`
        CREATE TABLE IF NOT EXISTS cases (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(255) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            owner VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            focus_options JSONB NOT NULL DEFAULT '{"negligence": false, "causation": false, "lifeExpectancy": false}',
            focus_text TEXT NOT NULL DEFAULT '',
            initial_report TEXT,
            comparison_report TEXT,
            app_state app_state_enum NOT NULL DEFAULT 'idle'
        );
    `);

    console.log('4. Creating case_documents table...');
    await client.query(`
        CREATE TABLE IF NOT EXISTS case_documents (
            id UUID PRIMARY KEY,
            case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
            original_filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            extracted_text TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `);
    
    console.log('5. Creating ai_usage_logs table...');
    await client.query(`
        CREATE TABLE IF NOT EXISTS ai_usage_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
            username VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            model TEXT,
            duration_ms INTEGER,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            total_tokens INTEGER,
            cost_usd NUMERIC(12,6),
            error_message TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `);

    console.log('6. Creating indexes...');
    await client.query('CREATE INDEX IF NOT EXISTS idx_cases_owner ON cases(owner);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_case_documents_case_id ON case_documents(case_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ai_usage_case_id ON ai_usage_logs(case_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage_logs(created_at);');


    console.log('7. Seeding initial users...');
    const usersToSeed = [
      { username: 'admin', password: 'admin123', role: 'admin' },
      { username: 'lior', password: 'lior123', role: 'user' },
      { username: 'hava', password: 'hava123', role: 'user' },
      { username: 'may', password: 'may123', role: 'user' },
      { username: 'orly', password: 'orly123', role: 'user' },
      { username: 'vlada', password: 'vlada123', role: 'user' },
    ];
    
    const insertUserQuery = `
        INSERT INTO users (username, password_hash, role) 
        VALUES ($1, $2, $3)
        ON CONFLICT (username) DO NOTHING;
    `;

    for (const user of usersToSeed) {
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(user.password, saltRounds);
        await client.query(insertUserQuery, [user.username, passwordHash, user.role]);
        console.log(`   - User '${user.username}' prepared.`);
    }
    console.log('   All users seeded successfully.');

    await client.query('COMMIT'); // Commit transaction
    console.log('Database setup completed successfully!');

  } catch (error) {
    await client.query('ROLLBACK'); // Rollback on error
    console.error('Error during database setup:', error);
    // Re-throw the error to ensure the script exits with a non-zero exit code
    // This is safer than calling process.exit() directly.
    throw error;
  } finally {
    client.release();
    await pool.end(); // Close all connections in the pool
  }
};

setupDatabase().catch(err => {
    // This final catch ensures that if setupDatabase throws an error,
    // the Node.js process will exit with a failure code.
    console.error("Database setup failed fatally.");
    process.exit(1);
});