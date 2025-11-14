// Fix: Use explicit 'express.Request', 'express.Response', and 'express.NextFunction' types to avoid conflicts with global DOM types.
// FIX: Changed import to directly use Request, Response, and NextFunction types from express.
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    throw new Error('FATAL ERROR: JWT_SECRET is not defined.');
}

// FIX: Use explicit Request, Response, and NextFunction types from express to fix property errors like .headers and .status.
// FIX: Changed types from express.Request to Request, etc.
export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Authentication required: No token provided.' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        // Attach the decoded user payload to the request object
        // So that downstream route handlers can access it (e.g., req.user)
        // @ts-ignore - We are intentionally extending the Request object
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ message: 'Authentication failed: Invalid token.' });
    }
};