export interface User {
  id?: number;
  email?: string;
  name?: string;
  role?: string;
  [key: string]: any;
}

export interface CaseData {
  id?: string | number;
  title?: string;
  description?: string;
  [key: string]: any;
}

export interface FocusOptions {
  [key: string]: any;
}

export interface AppState {
  user?: User;
  cases?: CaseData[];
  [key: string]: any;
}
