# Legal Assistant for Medical Malpractice Cases

This is a full-stack web application designed to assist lawyers representing doctors in medical malpractice cases. The application leverages Google's Gemini models to analyze case files, search for relevant medical literature, and generate comprehensive strategic reports.

## Features

- **Secure User Authentication**: Role-based access for lawyers (users) and administrators.
- **Case Management Dashboard**: Create, view, update, and delete cases. Admins can view cases for all users.
- **Multi-File Upload**: Upload multiple medical and legal documents (PDF, PNG, JPG) for a case.
- **AI-Powered Analysis**:
    - **Initial Report Generation**: Gemini analyzes uploaded documents to create a detailed report including a chronological timeline, key entities, analysis of weaknesses in the plaintiff's claims, and relevant medical literature.
    - **Comparative Analysis**: Upload a defense expert's opinion to receive an AI-generated comparative report that identifies gaps and strengthens the defense strategy.
    - **Executive Summaries**: Generate concise, one-page summaries of full reports for quick review.
- **External Literature Search**: The backend searches PubMed and Google Scholar in real-time to find supporting medical articles.
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
4.  Set up the database tables and seed initial users: `npm run db:setup`
5.  Start the backend development server: `npm run dev`
    - The server will run on `http://localhost:3001` by default.

### Frontend Setup

The frontend is designed to run without a complex build step.

1.  You need a simple static file server. If you use VS Code, the "Live Server" extension is a great choice.
2.  From the project's **root directory**, start your live server.
3.  The application will be accessible (e.g., at `http://localhost:5173`) and will automatically connect to your backend running on port 3001.

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