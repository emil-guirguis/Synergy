/**
 * List Component Framework - Export Helpers
 * Provides utilities for CSV/Excel/PDF generation and download with proper
 * escaping and special character handling.
 */

import type { ColumnDefinition } from '../types/ui';

// xlsx and jspdf are dynamically imported inside downloadExcel/downloadPDF —
// they're only pulled into the bundle when a user actually exports, instead
// of bloating every route that merely imports this module (list barrel export).

/**
 * Escape a CSV value to handle special characters properly.
 * Handles quotes, commas, newlines, and other special characters
 * according to RFC 4180 CSV specification.
 * 
 * @param value - Value to escape
 * @returns Escaped CSV value
 * 
 * @example
 * escapeCSVValue('Hello, World') // Returns: '"Hello, World"'
 * escapeCSVValue('Say "Hi"') // Returns: '"Say ""Hi"""'
 * escapeCSVValue('Line 1\nLine 2') // Returns: '"Line 1\nLine 2"'
 */
export const escapeCSVValue = (value: any): string => {
  // Handle null, undefined, or empty values
  if (value === null || value === undefined) {
    return '';
  }
  
  // Convert to string
  let stringValue = String(value);
  
  // Check if value needs escaping (contains comma, quote, newline, or carriage return)
  const needsEscaping = /[",\n\r]/.test(stringValue);
  
  if (needsEscaping) {
    // Escape double quotes by doubling them
    stringValue = stringValue.replace(/"/g, '""');
    // Wrap in double quotes
    return `"${stringValue}"`;
  }
  
  return stringValue;
};

/**
 * Generate a CSV string from headers and data rows.
 * Properly escapes all values and formats according to CSV standards.
 * 
 * @param headers - Array of column headers
 * @param rows - Array of data rows (each row is an array of values)
 * @param includeInfo - Optional info text to include at the top of the CSV
 * @returns CSV string ready for download
 * 
 * @example
 * const headers = ['Name', 'Email', 'Status'];
 * const rows = [
 *   ['John Doe', 'john@example.com', 'Active'],
 *   ['Jane Smith', 'jane@example.com', 'Inactive']
 * ];
 * const csv = generateCSV(headers, rows);
 */
export const generateCSV = (
  headers: string[],
  rows: any[][],
  includeInfo?: string
): string => {
  const lines: string[] = [];
  
  // Add info text if provided (as comments)
  if (includeInfo) {
    const infoLines = includeInfo.split('\n');
    infoLines.forEach(line => {
      lines.push(`# ${line}`);
    });
    lines.push(''); // Empty line after info
  }
  
  // Add headers
  const headerLine = headers.map(escapeCSVValue).join(',');
  lines.push(headerLine);
  
  // Add data rows
  rows.forEach(row => {
    const rowLine = row.map(escapeCSVValue).join(',');
    lines.push(rowLine);
  });
  
  // Join with newlines
  return lines.join('\n');
};

/**
 * Download a CSV string as a file.
 * Creates a blob and triggers a download in the browser.
 * 
 * @param csvContent - CSV string content
 * @param filename - Name for the downloaded file
 * 
 * @example
 * const csv = generateCSV(['Name', 'Email'], [['John', 'john@example.com']]);
 * downloadCSV(csv, 'contacts-2024-01-15.csv');
 */
export const downloadCSV = (csvContent: string, filename: string): void => {
  // Create a Blob with UTF-8 BOM for proper Excel compatibility
  const BOM = '\uFEFF';
  const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename);
};

/**
 * Trigger a browser download for an already-built Blob.
 */
const downloadBlob = (blob: Blob, filename: string): void => {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
};

/**
 * Auto-derive export headers/rows straight from a list's column definitions
 * and current data \u2014 no per-module export config required.
 *
 * @example
 * const { headers, rows } = buildExportRows(columns, data);
 */
export const buildExportRows = <T extends Record<string, any>>(
  columns: ColumnDefinition<T>[],
  data: T[]
): { headers: string[]; rows: any[][] } => {
  const headers = columns.map((col) => col.label);
  const rows = data.map((item) =>
    columns.map((col) => {
      const value = (item as any)[col.key as string];
      if (value === null || value === undefined) return '';
      if (typeof value === 'boolean') return value ? 'Yes' : 'No';
      return value;
    })
  );
  return { headers, rows };
};

/**
 * Generate an Excel (.xlsx) file from headers/rows and trigger a download.
 *
 * @example
 * downloadExcel(['Name', 'Email'], [['John', 'john@example.com']], 'contacts-2024-01-15.xlsx');
 */
export const downloadExcel = async (
  headers: string[],
  rows: any[][],
  filename: string,
  sheetName: string = 'Sheet1'
): Promise<void> => {
  const XLSX = await import('xlsx');

  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const workbook = XLSX.utils.book_new();
  // Sheet names can't exceed 31 chars or contain []:*?/\\
  const safeSheetName = sheetName.replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1';
  XLSX.utils.book_append_sheet(workbook, worksheet, safeSheetName);

  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadBlob(blob, filename);
};

/**
 * Generate a PDF table from headers/rows and trigger a download.
 * Switches to landscape when there are enough columns that portrait would
 * cramp the table.
 *
 * @example
 * downloadPDF(['Name', 'Email'], [['John', 'john@example.com']], 'contacts-2024-01-15.pdf', 'Contacts');
 */
export const downloadPDF = async (
  headers: string[],
  rows: any[][],
  filename: string,
  title?: string
): Promise<void> => {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);

  const doc = new jsPDF({ orientation: headers.length > 6 ? 'landscape' : 'portrait' });

  if (title) {
    doc.setFontSize(14);
    doc.text(title, 14, 15);
  }

  autoTable(doc, {
    head: [headers],
    body: rows.map((row) => row.map((v) => (v === null || v === undefined ? '' : String(v)))),
    startY: title ? 20 : 10,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [51, 65, 85] },
    margin: { top: 10 },
  });

  doc.save(filename);
};

/**
 * Format a date string for use in filenames.
 * Converts date to YYYY-MM-DD format.
 * 
 * @param date - Date object or undefined (defaults to current date)
 * @returns Formatted date string
 * 
 * @example
 * formatDateForFilename() // Returns: '2024-01-15'
 * formatDateForFilename(new Date('2024-03-20')) // Returns: '2024-03-20'
 */
export const formatDateForFilename = (date?: Date): string => {
  const d = date || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Generate export info text with timestamp and record count.
 * 
 * @param entityNamePlural - Plural name of the entity (e.g., 'contacts')
 * @param count - Number of records being exported
 * @returns Formatted info text
 * 
 * @example
 * generateExportInfo('contacts', 150)
 * // Returns: 'Exported 150 contacts on 2024-01-15 at 10:30 AM'
 */
export const generateExportInfo = (entityNamePlural: string, count: number): string => {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit'
  });
  
  return `Exported ${count} ${entityNamePlural} on ${dateStr} at ${timeStr}`;
};
