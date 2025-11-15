// backend/server.ts

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.js';
import casesRoutes from './routes/cases.js';

const app = express();

/**
 * CORS – מרשים רק ל־Origins הידועים (localhost + ה־Frontend ב־Render)
 */
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'https://medical-assistant-qgwi.onrender.com',
];

app.use(
  cors({
    origin(origin, callback) {
      // בקשות בלי origin (Postman, curl וכו') – נאשר
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Not allowed by CORS'));
    },
  })
);

// כדי ש־req.body יעבוד עם JSON
app.use(express.json());

// ראוט קטן לבדיקה / שמירת חיים
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ראוטים עיקריים
app.use('/api/auth', authRoutes);
app.use('/api/cases', casesRoutes);

// פורט מה־ENV או 3001 כברירת מחדל
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
