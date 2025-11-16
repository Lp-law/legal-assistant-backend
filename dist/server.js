import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pool from "./db.js"; // חשוב: לוודא שהחיבור ל-DB מיובא כאן
import authRouter from "./routes/auth.js";
import casesRouter from "./routes/cases.js";
const app = express();
const PORT = process.env.PORT || 3001;
// Middleware
app.use(cors({
    origin: true, // מאפשר גם localhost וגם Render
    credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
// Health check
app.get("/api/health", (_req, res) => {
    res.json({ ok: true, message: "Backend is running" });
});
// =========================
// ⚠️ ROUTE זמני ליצירת טבלה ⚠️
// =========================
// אחרי שהטבלה case_documents נוצרת — חובה למחוק!
app.post("/api/dev/run-sql", async (req, res) => {
    try {
        await pool.query(`
      CREATE TABLE IF NOT EXISTS case_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        original_filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        extracted_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
        res.json({
            success: true,
            message: "Table case_documents created successfully",
        });
    }
    catch (err) {
        console.error("Error creating table:", err);
        res.status(500).json({ error: err.message });
    }
});
// Routes
app.use("/api/auth", authRouter);
app.use("/api/cases", casesRouter);
// Start server
app.listen(PORT, () => {
    console.log(`Backend server is running on http://localhost:${PORT}`);
});
