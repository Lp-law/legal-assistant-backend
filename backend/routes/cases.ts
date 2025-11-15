// Fix: Use explicit 'express.Request' and 'express.Response' types to avoid conflicts with global DOM types.
// FIX: Changed import to directly use Request and Response types from express.
import express, { Request, Response } from 'express';
import { authMiddleware } from '../middleware/authMiddleware.js';
import pool from '../db.js';
import type { AppState, CaseData, FocusOptions } from '../types';

const router = express.Router();

// Apply the authentication middleware to all routes in this file
router.use(authMiddleware);

interface CaseDbRow {
    id: string;
    name: string;
    created_at: string;
    owner: string;
    focus_options: FocusOptions;
    focus_text: string;
    initial_report: string | null;
    comparison_report: string | null;
    app_state: AppState;
}

// GET /api/cases - Get cases based on user role
// FIX: Use explicit Request and Response types from express to fix method errors like .json and .status.
// FIX: Changed types from express.Request to Request.
router.get('/', async (req: Request, res: Response) => {
    // @ts-ignore - 'user' is added by authMiddleware
    const { username, role } = req.user;

    try {
        let query;
        const params: string[] = [];
        if (role === 'admin') {
            query = 'SELECT * FROM cases ORDER BY created_at DESC';
        } else {
            query = 'SELECT * FROM cases WHERE owner = $1 ORDER BY created_at DESC';
            params.push(username);
        }
        const result = await pool.query<CaseDbRow>(query, params);
        // Convert snake_case from DB to camelCase for the frontend
        const cases: CaseData[] = result.rows.map(row => ({
            id: row.id,
            name: row.name,
            createdAt: row.created_at,
            owner: row.owner,
            focusOptions: row.focus_options,
            focusText: row.focus_text,
            initialReport: row.initial_report,
            comparisonReport: row.comparison_report,
            appState: row.app_state
        }));

        res.json(cases);
    } catch (error) {
        console.error('Error fetching cases:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// POST /api/cases - Create a new case
// FIX: Use explicit Request and Response types from express to fix property errors like .body and .status.
// FIX: Changed types from express.Request to Request.
router.post('/', async (req: Request, res: Response) => {
    // @ts-ignore - 'user' is added by authMiddleware
    const { username } = req.user;
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
        return res.status(400).json({ message: 'Case name is required and must be a string.' });
    }

    try {
        const query = `
            INSERT INTO cases (name, owner, focus_options, focus_text, app_state)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
        `;
        const focusOptions = { negligence: false, causation: false, lifeExpectancy: false };
        const values = [name.trim(), username, JSON.stringify(focusOptions), '', 'idle'];
        
        const result = await pool.query<CaseDbRow>(query, values);
        const newCaseRow = result.rows[0];
        
        const newCase: CaseData = {
            id: newCaseRow.id,
            name: newCaseRow.name,
            createdAt: newCaseRow.created_at,
            owner: newCaseRow.owner,
            focusOptions: newCaseRow.focus_options,
            focusText: newCaseRow.focus_text,
            initialReport: newCaseRow.initial_report,
            comparisonReport: newCaseRow.comparison_report,
            appState: newCaseRow.app_state,
        };
        
        res.status(201).json(newCase);

    } catch (error) {
        console.error('Error creating case:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// PUT /api/cases/:id - Update an existing case
// FIX: Use explicit Request and Response types from express to fix property errors like .params, .body, and .status.
// FIX: Changed types from express.Request to Request.
router.put('/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const caseUpdates: Partial<CaseData> = req.body;
    // @ts-ignore - 'user' is added by authMiddleware
    const { username, role } = req.user;

    try {
        const findQuery = 'SELECT owner FROM cases WHERE id = $1';
        const findResult = await pool.query<{ owner: string }>(findQuery, [id]);

        if (findResult.rows.length === 0) {
            return res.status(404).json({ message: 'Case not found' });
        }
        
        const originalCase = findResult.rows[0];
        if (originalCase.owner !== username && role !== 'admin') {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to update this case.' });
        }

        const updateQuery = `
            UPDATE cases
            SET 
                name = $1, 
                focus_options = $2, 
                focus_text = $3, 
                initial_report = $4, 
                comparison_report = $5, 
                app_state = $6
            WHERE id = $7
            RETURNING *;
        `;
        
        // Fetch current case to merge with updates
        const currentCaseResult = await pool.query<CaseDbRow>('SELECT * FROM cases WHERE id = $1', [id]);
        const currentCase = currentCaseResult.rows[0];

        const values = [
            caseUpdates.name ?? currentCase.name,
            caseUpdates.focusOptions ?? currentCase.focus_options,
            caseUpdates.focusText ?? currentCase.focus_text,
            caseUpdates.initialReport ?? currentCase.initial_report,
            caseUpdates.comparisonReport ?? currentCase.comparison_report,
            caseUpdates.appState ?? currentCase.app_state,
            id
        ];
        
        const result = await pool.query<CaseDbRow>(updateQuery, values);
        const updatedCaseRow = result.rows[0];

        const updatedCase: CaseData = {
             id: updatedCaseRow.id,
            name: updatedCaseRow.name,
            createdAt: updatedCaseRow.created_at,
            owner: updatedCaseRow.owner,
            focusOptions: updatedCaseRow.focus_options,
            focusText: updatedCaseRow.focus_text,
            initialReport: updatedCaseRow.initial_report,
            comparisonReport: updatedCaseRow.comparison_report,
            appState: updatedCaseRow.app_state,
        };
        
        res.json(updatedCase);

    } catch (error) {
        console.error('Error updating case:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// DELETE /api/cases/:id - Delete a case
// FIX: Use explicit Request and Response types from express to fix property errors like .params and .status.
// FIX: Changed types from express.Request to Request.
router.delete('/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    // @ts-ignore - 'user' is added by authMiddleware
    const { username, role } = req.user;
    
    try {
        const findQuery = 'SELECT owner FROM cases WHERE id = $1';
        const findResult = await pool.query<{ owner: string }>(findQuery, [id]);

        if (findResult.rows.length === 0) {
            // If it doesn't exist, it's already "deleted". No need to error.
            return res.status(204).send();
        }

        const caseToDelete = findResult.rows[0];
        if (caseToDelete.owner !== username && role !== 'admin') {
            return res.status(403).json({ message: 'Forbidden: You do not have permission to delete this case.' });
        }

        await pool.query('DELETE FROM cases WHERE id = $1', [id]);
        res.status(204).send();

    } catch (error) {
        console.error('Error deleting case:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});


export default router;