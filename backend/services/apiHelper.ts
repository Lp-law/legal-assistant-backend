// In a real deployment, this would be your backend URL (e.g., https://your-api.com)
// Using an environment variable allows us to switch between local and production.
// Fix: Cast `import.meta` to `any` to resolve the TypeScript error "Property 'env' does not exist on type 'ImportMeta'".
const API_BASE_URL = (import.meta as any).env.VITE_API_BASE_URL || 'http://localhost:3001/api';

const getAuthToken = (): string | null => {
    try {
        return localStorage.getItem('authToken');
    } catch (e) {
        console.error("Could not access localStorage. Auth token will not be available.");
        return null;
    }
}

export const getHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    const token = getAuthToken();
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

/**
 * A wrapper around fetch for making API calls to the application's backend.
 * @param endpoint The API endpoint to call (e.g., '/cases').
 * @param options The standard fetch options object.
 * @returns The JSON response from the API.
 * @throws An error if the network response is not ok.
 */
export const fetchApi = async (endpoint: string, options: RequestInit = {}) => {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        ...options,
        headers: getHeaders(), // Automatically adds auth headers
    });

    if (!response.ok) {
        let errorData;
        try {
            // Try to parse the error response from the backend
            errorData = await response.json();
        } catch (e) {
            // If the backend sends a non-JSON error (e.g., HTML error page), create a generic error
            errorData = { message: `Request failed with status ${response.status}: ${response.statusText}` };
        }
        // Throw an error with the message from the backend, or the generic one
        throw new Error(errorData.message || 'An unknown API error occurred');
    }

    if (response.status === 204) { // No Content success status (e.g., for DELETE)
        return null;
    }
    
    // If the response is OK, parse and return the JSON body
    return response.json();
}