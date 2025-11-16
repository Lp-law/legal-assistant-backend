import 'dotenv/config';
import pool from './db.js';
import bcrypt from 'bcryptjs';

const run = async () => {
  console.log('DATABASE_URL:', process.env.DATABASE_URL);

  console.log('\nAll users in DB:');
  const res = await pool.query('SELECT username, role FROM users ORDER BY username');
  console.log(res.rows);

  console.log('\nChecking admin user...');
  const adminRes = await pool.query(
    'SELECT username, password_hash, role FROM users WHERE username = $1',
    ['admin']
  );

  if (adminRes.rows.length === 0) {
    console.log('❌ No user with username = admin found in users table');
  } else {
    const row = adminRes.rows[0];
    console.log('Admin row from DB:', {
      username: row.username,
      role: row.role,
      password_hash: row.password_hash,
    });

    const ok = await bcrypt.compare('admin123', row.password_hash);
    console.log('\nResult of bcrypt.compare("admin123", password_hash):', ok);
  }

  await pool.end();
};

run().catch(err => {
  console.error('Debug script failed with error:', err);
  process.exit(1);
});
