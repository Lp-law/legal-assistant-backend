# Legal Assistant Backend

This is the backend server for the Legal Assistant for Medical Malpractice Cases application. It's built with Express.js, TypeScript, and connects to a PostgreSQL database (like Supabase).

## Setup

1.  **Install dependencies:**
    ```bash
    npm install
    ```

2.  **Create a `.env` file:**
    Create a file named `.env` in the `backend` directory.

3.  **Add Environment Variables:**
    Copy the entire block below and paste it into your `backend/.env` file. Then, fill in your actual credentials.

    ```env
    #
    # Environment variables for the Legal Assistant Backend
    #
    
    # ----------------------------------------------------------------
    # DATABASE
    # ----------------------------------------------------------------
    # Your full PostgreSQL connection string.
    # For Supabase, find this in your project under Settings > Database > Connection string.
    # postgresql://postgres:F6nTDHRehad7V7wo@db.bntzxuruqeqbmxjierpk.supabase.co:5432/postgres
    DATABASE_URL="YOUR_POSTGRESQL_CONNECTION_STRING"
    
    # ----------------------------------------------------------------
    # AUTHENTICATION
    # ----------------------------------------------------------------
    # A long, random, and secret string for signing JSON Web Tokens (JWT).
    # You can generate a strong secret using an online tool like https://www.uuidgenerator.net/
    JWT_SECRET="YOUR_SUPER_STRONG_AND_SECRET_JWT_KEY"
    
    # ----------------------------------------------------------------
    # FRONTEND
    # ----------------------------------------------------------------
    # The full URL of your running frontend application.
    # This is crucial for CORS to work correctly.
    # For local development, this is typically http://localhost:5173
    FRONTEND_URL="http://localhost:5173"
    
    # ----------------------------------------------------------------
    # GOOGLE GEMINI API
    # ----------------------------------------------------------------
    # Your API key for Google's Gemini models.
    # The frontend also requires this key to be set in its environment.
    API_KEY="YOUR_GEMINI_API_KEY"
    
    # ----------------------------------------------------------------
    # EXTERNAL SERVICES (Optional)
    # ----------------------------------------------------------------
    # API key for SerpApi.com, used for real-time Google Scholar searches.
    # If you leave this blank, Google Scholar searches will be skipped.
    SERPAPI_KEY="YOUR_SERPAPI_KEY"
    
    ```

4.  **Set up the database (Recommended Method):**
    Run the automated setup script. This will connect to your database, create the necessary tables, and seed the initial users securely.
    ```bash
    npm run db:setup
    ```

5.  **Alternative: Manual SQL Setup:**
    If you prefer, you can connect to your PostgreSQL database (e.g., using the SQL Editor in Supabase) and run the entire `backend/setup.sql` script.

## Running the server

```bash
npm start
```

The server will start, by default, on `http://localhost:3001`.

## Configuration Notes

| Variable | Description |
| --- | --- |
| `MEDICAL_REPORT_MODEL` | Override the default OpenAI model used for deep medical reports. |
| `MEDICAL_REPORT_TEMPERATURE` | Temperature for medical reports (default `0.25`). |
| `INITIAL_REPORT_MAX_TOKENS` | Maximum completion tokens for the initial medical report. |
| `COMPARISON_REPORT_MAX_TOKENS` | Maximum completion tokens for the comparison report. |
| `MEDICAL_REPORT_DEPTH` | Hint for AI verbosity (`deep` / `concise`). |
| `CLAIM_EXTRACTION_MODEL` | *(Optional)* Dedicated model for automatic claim extraction (defaults to `MEDICAL_REPORT_MODEL`). |
| `CLAIM_EXTRACTION_MAX_TOKENS` | *(Optional)* Max tokens for claim extraction responses (default `1200`). |
| `MAX_REFERENCES_PER_DOCUMENT` | Number of reference snippets detected per document (default `4`). |
| `MAX_REFERENCES_PER_REPORT` | Total reference snippets per AI call (default `10`). |
| `SEMANTIC_SCHOLAR_API_KEY` | API key for Semantic Scholar to enrich literature lookups. |

## Automatic Claim Extraction

The backend now supports structured extraction of plaintiff claims from each uploaded expert opinion:

- `GET /api/cases/:caseId/documents/:docId/claims` – fetch stored claims for a document.
- `POST /api/cases/:caseId/documents/:docId/claims/extract` – regenerate the claims with AI (results are persisted in the `case_document_claims` table).

These endpoints power the new UI panel that lists medical allegations before building the full reports, helping reviewers validate the AI's understanding of each expert opinion.