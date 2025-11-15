import 'dotenv/config'; // Must be at the top
// Fix: Use explicit 'express.Request' and 'express.Response' types to avoid conflicts with global DOM types.
// FIX: Changed import to directly use Request and Response types from express.
import express, { Request, Response } from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import caseRoutes from './routes/cases.js';
import { authMiddleware } from './middleware/authMiddleware.js';
import pool from './db.js';
import type { User } from './types';

const app = express();
const PORT = process.env.PORT || 3001;

// CORS Configuration for Production
const allowedOrigins = [
    'http://localhost:5173', // Allow local frontend dev server
    process.env.FRONTEND_URL // Add your deployed frontend URL from .env
].filter(Boolean); // Filter out undefined values

const corsOptions: cors.CorsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin || allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/cases', caseRoutes);

// A protected route to get all users for the admin dashboard
// FIX: Use explicit Request and Response types from express to fix method errors like .status and .json.
// FIX: Changed types from express.Request to Request.
app.get('/api/users', authMiddleware, async (req: Request, res: Response) => {
    // @ts-ignore - 'user' is added to req by authMiddleware
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: Admins only' });
    }
    try {
        const result = await pool.query('SELECT username, role FROM users WHERE role = $1', ['user']);
        const users: User[] = result.rows.map(u => ({ username: u.username, role: u.role }));
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});


app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});