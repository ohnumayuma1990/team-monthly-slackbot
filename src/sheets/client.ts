import { google, sheets_v4 } from 'googleapis';

let sheetsClientInstance: sheets_v4.Sheets | null = null;

/**
 * Initializes and returns a Google Sheets API client using service account credentials.
 */
export function getSheetsClient(): sheets_v4.Sheets {
  if (sheetsClientInstance) {
    return sheetsClientInstance;
  }

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Missing Google Service Account credentials. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.'
    );
  }

  // Handle escaped newlines in environment variable
  if (privateKey.includes('\\n')) {
    privateKey = privateKey.replace(/\\n/g, '\n');
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClientInstance = google.sheets({ version: 'v4', auth });
  return sheetsClientInstance;
}

/**
 * Resets the client instance (useful in tests).
 */
export function setMockSheetsClient(client: sheets_v4.Sheets | null) {
  sheetsClientInstance = client;
}

export function hasMockSheetsClient(): boolean {
  return sheetsClientInstance !== null;
}
