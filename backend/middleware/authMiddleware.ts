// Fix: Use explicit 'express.Request', 'express.Response', and 'express.NextFunction' types to avoid conflicts with global DOM types.
// FIX: Changed import to directly use Request, Response, and NextFunction types from express.
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { JwtUserPayload, UserRole } from "../types.js";

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("FATAL ERROR: JWT_SECRET is not defined.");
}

const isJwtUserPayload = (value: unknown): value is JwtUserPayload => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const maybePayload = value as Partial<JwtUserPayload>;
  return (
    typeof maybePayload.username === "string" &&
    (maybePayload.role === "admin" || maybePayload.role === "user")
  );
};

export const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authentication required: No token provided." });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!isJwtUserPayload(decoded)) {
      return res.status(401).json({ message: "Authentication failed: Invalid token payload." });
    }

    const payload: JwtUserPayload = {
      username: decoded.username,
      role: decoded.role as UserRole,
    };

    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Authentication failed: Invalid token." });
  }
};