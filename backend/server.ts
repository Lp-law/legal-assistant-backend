import "dotenv/config";
import express from "express";
import cors, { CorsOptions } from "cors";
import cookieParser from "cookie-parser";

import authRouter from "./routes/auth.js";
import casesRouter from "./routes/cases.js";

const app = express();
const PORT = process.env.PORT || 3001;

const defaultFrontendUrl = "https://medical-assistant-qgwi.onrender.com";
const allowedOrigins = new Set(
  [
    "http://localhost:5173",
    process.env.FRONTEND_URL,
    defaultFrontendUrl,
  ].filter(Boolean) as string[]
);

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    if (allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    if (process.env.NODE_ENV !== "production") {
      return callback(null, true);
    }
    return callback(new Error(`CORS: Origin ${origin} is not allowed.`));
  },
  credentials: true,
};

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin) && process.env.NODE_ENV !== "production") {
    console.warn(`CORS warning: received request from unlisted origin ${origin}`);
  }
  next();
});

app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "Backend is running" });
});

// Routes
app.use("/api/auth", authRouter);
app.use("/api/cases", casesRouter);

// Start server
app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
