// Fix: Use explicit 'express.Request' and 'express.Response' types to avoid conflicts with global DOM types.
// FIX: Changed import to directly use Request and Response types from express.
import express, { Request, Response } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import pool from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import type { JwtUserPayload } from "../types.js";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = "8h";

if (!JWT_SECRET) {
  throw new Error("FATAL ERROR: JWT_SECRET is not defined.");
}

router.post("/login", async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required." });
  }

  try {
    const normalizedUsername = String(username).toLowerCase();
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [normalizedUsername]);

    if (result.rows.length === 0) {
      return res.status(401).json({ message: "שם משתמש או סיסמה שגויים." });
    }

    const user = result.rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);

    if (!isPasswordValid) {
      return res.status(401).json({ message: "שם משתמש או סיסמה שגויים." });
    }

    const userPayload: JwtUserPayload = { username: user.username, role: user.role };
    const token = jwt.sign(userPayload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    res.json({ user: userPayload, token });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/me", authMiddleware, async (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required." });
  }

  try {
    const result = await pool.query("SELECT username, role FROM users WHERE username = $1", [req.user.username]);

    if (result.rows.length > 0) {
      const userProfile: JwtUserPayload = result.rows[0];
      res.json(userProfile);
    } else {
      res.status(404).json({ message: "User not found" });
    }
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;