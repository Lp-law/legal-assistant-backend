# Legal Assistant for Medical Malpractice Cases

This is a full-stack web application designed to assist lawyers representing doctors in medical malpractice cases. The application leverages Google's Gemini models to analyze case files, search for relevant medical literature, and generate comprehensive strategic reports.

## Features

- **Secure User Authentication**: Role-based access for lawyers (users) and administrators.
- **Case Management Dashboard**: Create, view, update, and delete cases. Admins can view cases for all users.
- **Multi-File Upload**: Upload multiple medical and legal documents (PDF, PNG, JPG) for a case.
- **Document Text Extraction**: Uploaded PDFs/DOCX files are processed in-memory, text is extracted, and only text + metadata is stored in PostgreSQL.
- **AI-Powered Analysis**:
    - **Initial Report Generation**: OpenAI (configurable) analyzes uploaded documents plus case focus instructions and returns a structured defense-oriented report.
    - **Comparative Analysis**: Pick two expert opinions from the case and get an AI-generated comparison highlighting agreements, disagreements, and strategy guidance.
    - **Executive Summaries / Copy to Clipboard**: Reports are rendered with pre-wrap formatting for quick review and export.
- **Medical Literature Enrichment**: The backend scans expert opinions for citations, hits Semantic Scholar / CrossRef, and feeds curated abstracts + metadata back into the AI prompt so it can verify whether plaintiffs' experts rely on the literature accurately.
- **Literature Search Panel**: Ask a focused clinical / medico-legal question and receive curated article leads with summaries and implications for the defense.
- **Audit-Friendly Logging**: All AI calls are logged with case/user metadata (no PHI), so activity can be traced when needed.
- **Focused Analysis**: Users can guide the AI's focus towards specific legal points like negligence, causation, or life expectancy.

## Tech Stack

- **Frontend**:
  - React with TypeScript
  - Tailwind CSS for styling
  - No-build setup using ES Modules and Import Maps
- **Backend**:
  - Node.js with Express.js and TypeScript
  - PostgreSQL (e.g., Supabase, Render) for the database
  - JWT for authentication
- **AI**:
  - Google Gemini API (`gemini-2.5-pro`) for text analysis and generation.
  - OpenAI Chat Completions (default `gpt-4o-mini`, override via env) for reports and literature reviews.

---

## Environment Variables

Create a `.env` file inside `backend/` with:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (Render / Supabase / local). |
| `JWT_SECRET` | Secret used for JWT signing. |
| `FRONTEND_URL` | Allowed origin for CORS (e.g., `https://medical-assistant-qgwi.onrender.com`). |
| `OPENAI_API_KEY` | OpenAI API key with access to GPT-4o/GPT-4.1 (required for AI features). |
| `OPENAI_MODEL` | *(Optional)* Override default OpenAI model for general AI calls. |
| `MEDICAL_REPORT_MODEL` | *(Optional)* Dedicated model for the deep medical reports (default `gpt-4.1-mini`). |
| `MEDICAL_REPORT_TEMPERATURE` | *(Optional)* Temperature for medical reports (default `0.25`). |
| `INITIAL_REPORT_MAX_TOKENS` | *(Optional)* Max tokens for initial report output (default `2400`). |
| `COMPARISON_REPORT_MAX_TOKENS` | *(Optional)* Max tokens for comparison report output (default `2000`). |
| `MEDICAL_REPORT_DEPTH` | *(Optional)* `deep` (default) or `concise` – hints to the AI about desired verbosity. |
| `MAX_UPLOAD_SIZE_MB` | *(Optional)* Max size per uploaded document in MB (default `25`). |
| `MAX_UPLOAD_FILES` | *(Optional)* Max number of documents per request (default `5`). |
| `MAX_REFERENCES_PER_DOCUMENT` | *(Optional)* How many references to auto-detect per document (default `4`). |
| `MAX_REFERENCES_PER_REPORT` | *(Optional)* Global cap on references per AI call (default `10`). |
| `SEMANTIC_SCHOLAR_API_KEY` | *(Optional)* API key for Semantic Scholar to improve literature lookups. |

Frontend (inside `legal-assistant-frontend/.env`):

```
VITE_API_BASE_URL=http://localhost:3001
```

> When deployed, point `VITE_API_BASE_URL` to the Render backend URL.

### Medical Literature Service

`backend/services/medicalLiteratureService.ts` scans expert opinions for references, detects likely citations, and tries to enrich them via Semantic Scholar (preferred) or CrossRef. The resolved abstracts, journal info, and URLs are injected into the AI prompts for both the initial and comparison medical reports so that the AI can check whether a cited article truly supports the expert's claim. You can tune how many references are inspected via `MAX_REFERENCES_PER_DOCUMENT` / `MAX_REFERENCES_PER_REPORT`, and optionally provide `SEMANTIC_SCHOLAR_API_KEY` for higher rate limits.

---

## Database Setup

- Run `npm run db:setup` from `legal-assistant-backend/` to create:
  - `users`, `cases`, and the new `case_documents` table (with indexes).
  - Enum types `user_role_enum` and `app_state_enum` (now including `processing`).
- Uploaded documents are *never* stored on disk. Multer uses `memoryStorage`, text is extracted immediately (PDF via `pdf-parse`, DOCX via `mammoth`) and persisted in `case_documents.extracted_text`.

Existing databases can be updated by re-running `npm run db:setup` or executing the SQL inside `backend/setup.ts`.

---

## Key API Endpoints

All `/api/cases/*` routes require a valid `Authorization: Bearer <token>` header and enforce owner/admin access.

| Method & Path | Description |
| --- | --- |
| `POST /api/auth/login` | Returns `{ user, token }`. |
| `GET /api/cases` | List cases (admin sees all, user sees own). |
| `POST /api/cases` | Create a new case with default focus options. |
| `PUT /api/cases/:id` | Update name, focus text/options, reports, app state. |
| `DELETE /api/cases/:id` | Delete case (owner/admin). |
| `POST /api/cases/:id/documents` | Upload multiple PDF/DOCX files (≤`MAX_UPLOAD_SIZE_MB` MB each, default 25MB). Returns metadata + preview snippets. |
| `GET /api/cases/:id/documents` | List document metadata for the case. |
| `GET /api/cases/:id/documents/:docId` | Fetch full extracted text. |
| `POST /api/cases/:id/initial-report` | Build a structured defense report (uses documents + focus text). |
| `POST /api/cases/:id/comparison-report` | Compare two expert opinions by document ID. |
| `POST /api/cases/:id/literature-review` | Answer a clinical question with curated articles. |

---

## Quality & Logging

- Centralized CORS configuration covers local dev (`http://localhost:5173`) and Render deployments (configure `FRONTEND_URL`).
- AI calls log `{ caseId, user, action, duration, status }` without PHI.
- Request typing extends `express.Request` so `req.user` is strongly typed end-to-end (no `@ts-ignore`).
- All error responses follow `{ message, details? }` for consistent frontend handling.

---

## Getting Started: Local Development vs. Deployment

You have two main paths to run this application:

1.  **Local Development (Recommended for developers)**: Run both the frontend and backend on your own computer. This is faster for making code changes but can sometimes be tricky to set up.
2.  **Deployment to the Cloud (Recommended if you're stuck on local setup)**: Deploy the application to a free cloud service. This is a fantastic way to bypass local setup issues and get a live, working application with a public URL.

**If you are having trouble running the backend locally (`npm run dev`), follow the Deployment guide below.**

---

## Option 1: Local Development Setup

### Backend Setup

1.  Navigate to the `backend` directory: `cd backend`
2.  Install dependencies: `npm install`
3.  Create a `.env` file in the `backend` directory. See `backend/README.md` for the required variables.
4.  Set up the database tables (users, cases, case_documents) and seed initial users: `npm run db:setup`
5.  Start the backend development server: `npm run dev`
    - The server will run on `http://localhost:3001` by default.

### Frontend Setup

The frontend is a Vite + React app with inline RTL UI.

1.  `cd legal-assistant-frontend`
2.  `npm install`
3.  Create `.env` with `VITE_API_BASE_URL=http://localhost:3001` if you want to point to a custom backend.
4.  `npm run dev` (default `http://localhost:5173`)
5.  Use the UI to:
    - Log in (seed users: `admin` / `admin123`, etc.).
    - Create a case, toggle focus areas, add notes.
    - Upload medical/legal documents.
    - Generate initial reports, comparison reports, and literature searches directly from the case panel.

---

## Option 2: Deployment to Render (Free)

This guide will walk you through deploying the entire application to Render.com, which offers generous free tiers for everything we need.

### Prerequisites

1.  **Create a GitHub Account**: If you don't have one, sign up at [github.com](https://github.com/).
2.  **Create a Render Account**: Sign up at [render.com](https://render.com/) using your GitHub account.
3.  **Push Project to GitHub**: Create a new repository on GitHub and push this project's code to it.

### Part A: Deploy the Database

1.  On your Render Dashboard, click **New +** > **PostgreSQL**.
2.  Give it a unique name (e.g., `legal-assistant-db`).
3.  Select a Region close to you.
4.  Click **Create Database**. Wait for it to become "Available".
5.  Once available, copy the **Internal Connection String**. You will need this for the backend.

### Part B: Deploy the Backend

1.  On your Render Dashboard, click **New +** > **Web Service**.
2.  Connect the GitHub repository you created.
3.  Give the service a unique name (e.g., `legal-assistant-backend`).
4.  Under **Settings**, configure the following:
    - **Root Directory**: `backend` (This tells Render to look inside the `backend` folder)
    - **Build Command**: `npm install`
    - **Start Command**: `npm start`
5.  Click **Advanced** and then **Add Environment Variable**. Add all the keys from your local `.env` file (`JWT_SECRET`, `API_KEY`, etc.).
    - For `DATABASE_URL`, paste the **Internal Connection String** you copied from your Render PostgreSQL database.
    - For `FRONTEND_URL`, you can leave it blank for now. We'll fill this in later.
6.  Click **Create Web Service**. Render will now build and deploy your backend. This might take a few minutes.
7.  Once it's live, copy your backend's URL (it will look like `https://legal-assistant-backend.onrender.com`).

### Part C: Deploy the Frontend

1.  On your Render Dashboard, click **New +** > **Static Site**.
2.  Connect the **same** GitHub repository.
3.  Give it a unique name (e.g., `legal-assistant-frontend`).
4.  Render should auto-detect the settings. The `Build Command` and `Publish directory` can be left as default (`public`).
5.  Click **Create Static Site**. This will deploy very quickly.
6.  Once it's live, copy your frontend's URL.

### Part D: Connect Everything

You now have a live frontend and a live backend, but they don't know about each other.

1.  **Point Frontend to Backend**:
    - Open the file `services/apiHelper.ts` in your code editor.
    - Find the line `const PROD_API_URL = '...';`.
    - Replace the placeholder URL with your **live backend URL** from Part B. Make sure to add `/api` at the end.
    - **Example**: `const PROD_API_URL = 'https://legal-assistant-backend.onrender.com/api';`
    - Save the file and push this change to GitHub. Render will automatically see the change and redeploy your frontend site.

2.  **Allow Backend to Accept Frontend Requests (CORS)**:
    - Go back to your **backend** service's settings on Render.
    - Go to the **Environment** tab.
    - Find the `FRONTEND_URL` variable.
    - Set its value to your **live frontend URL** from Part C.
    - **Example**: `https://legal-assistant-frontend.onrender.com`
    - Save the changes. Render will restart your backend with the new setting.

**Congratulations! Your application is now fully live on the internet.**

---
_This application was built with the help of a world-class senior frontend engineer AI assistant._