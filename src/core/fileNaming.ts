import type {WorkbookState} from '../types';

export type ExportFormat = 'xlsx' | 'csv' | 'tsv';

export const MAX_WORKBOOK_NAME_LENGTH = 120;
export const MAX_EXPORT_BASENAME_LENGTH = 120;

const KNOWN_IMPORT_EXTENSIONS = new Set([
  'xlsx',
  'xls',
  'xlsm',
  'xlsb',
  'ods',
  'csv',
  'tsv',
  'txt',
  'json',
]);

const KNOWN_EXPORT_EXTENSIONS = new Set([
  'xlsx',
  'xls',
  'xlsm',
  'xlsb',
  'ods',
  'csv',
  'tsv',
]);

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const PATH_SEPARATORS_RE = /[/\\]/;
const UNSAFE_FILENAME_CHARS_RE = /[<>:"|?*]/;
const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function truncateCodePoints(value: string, maxLen: number): string {
  const cps = Array.from(value);
  return cps.length <= maxLen ? value : cps.slice(0, maxLen).join('');
}

function stripTrailingExtensionSet(
  value: string,
  extSet: ReadonlySet<string>
): string {
  let current = value;
  while (true) {
    const dot = current.lastIndexOf('.');
    if (dot <= 0) break;
    const stem = current.slice(0, dot);
    const ext = current.slice(dot + 1).toLowerCase();
    if (!stem || stem === '.' || stem === '..' || !extSet.has(ext)) {
      break;
    }
    current = stem;
  }
  return current;
}

/**
 * Derives a clean logical workbook name from an imported filename.
 * - Preserves dot-prefixed names (`.hidden.csv` -> `.hidden`, `.env` -> `.env`)
 * - Preserves arbitrary non-tabular extensions (`Q1.report` -> `Q1.report`)
 * - Falls back to `'Untitled'` if nothing remains after stripping (e.g. `.csv`)
 */
export function deriveWorkbookNameFromFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) return 'Untitled';
  if (
    trimmed.startsWith('.') &&
    KNOWN_IMPORT_EXTENSIONS.has(trimmed.slice(1).toLowerCase())
  ) {
    return 'Untitled';
  }
  const stripped = stripTrailingExtensionSet(trimmed, KNOWN_IMPORT_EXTENSIONS).trim();
  if (!stripped || stripped === '.' || stripped === '..') {
    return 'Untitled';
  }
  return stripped;
}

/**
 * Resolves the user-facing logical workbook name without synthetic export extensions.
 */
export function getWorkbookDisplayName(
  workbook: Pick<WorkbookState, 'name' | 'fileName'>
): string {
  const explicit = workbook.name?.trim();
  if (explicit) return explicit;
  return deriveWorkbookNameFromFileName(workbook.fileName);
}

export type WorkbookNameValidation =
  | {ok: true; name: string}
  | {ok: false; error: string};

/**
 * Validates and normalizes a logical workbook name for inline/programmatic rename.
 * Does NOT append `.xlsx` to the logical workbook name and preserves valid Unicode.
 */
export function validateWorkbookName(raw: string): WorkbookNameValidation {
  if (CONTROL_CHARS_RE.test(raw)) {
    return {
      ok: false,
      error: 'Workbook name cannot contain control characters.',
    };
  }
  if (PATH_SEPARATORS_RE.test(raw)) {
    return {
      ok: false,
      error: 'Workbook name cannot contain / or \\ path separators.',
    };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: 'Workbook name cannot be empty.',
    };
  }
  if (trimmed === '.' || trimmed === '..') {
    return {
      ok: false,
      error: 'Enter a valid workbook name.',
    };
  }
  const len = codePointLength(trimmed);
  if (len > MAX_WORKBOOK_NAME_LENGTH) {
    return {
      ok: false,
      error: `Workbook name must be ${MAX_WORKBOOK_NAME_LENGTH} characters or fewer (${len} entered).`,
    };
  }
  return {ok: true, name: trimmed};
}

/**
 * Strips redundant or convertible tabular export extensions case-insensitively
 * while keeping arbitrary user extensions (`Q1.report`) and dot-prefixed stems (`.hidden`).
 */
export function stripKnownExportExtension(raw: string): string {
  return stripTrailingExtensionSet(raw.trim(), KNOWN_EXPORT_EXTENSIONS);
}

function sanitizeSheetSuffixSegment(sheetName: string): string {
  return sheetName
    .replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function applySheetSuffix(
  baseName: string,
  format: ExportFormat,
  options?: {includeSheetSuffix?: boolean; sheetName?: string}
): string {
  if (
    !options?.includeSheetSuffix ||
    !options.sheetName ||
    (format !== 'csv' && format !== 'tsv')
  ) {
    return baseName;
  }
  const suffix = sanitizeSheetSuffixSegment(options.sheetName);
  if (!suffix) return baseName;
  if (baseName.toLowerCase().endsWith(`-${suffix.toLowerCase()}`)) {
    return baseName;
  }
  return `${baseName}-${suffix}`;
}

export type ExportFilenameValidation =
  | {
      ok: true;
      baseName: string;
      fileName: string;
      extension: ExportFormat;
    }
  | {ok: false; error: string};

/**
 * Validates and normalizes a user-entered export filename for Save As.
 * - Rejects empty, whitespace-only, control chars, path separators, OS-forbidden characters,
 *   reserved device names, extension-only names (e.g. `.xlsx`), and over-length names.
 * - Normalizes case on known extensions (`Results.CSV` -> `Results.csv`) and switches
 *   extensions cleanly when format changes (`Benchmark.csv` + xlsx -> `Benchmark.xlsx`).
 * - Prevents duplicate extensions (`sales.xlsx.xlsx` -> `sales.xlsx`).
 */
export function validateExportFilename(
  rawInput: string,
  format: ExportFormat,
  options?: {includeSheetSuffix?: boolean; sheetName?: string}
): ExportFilenameValidation {
  if (CONTROL_CHARS_RE.test(rawInput)) {
    return {
      ok: false,
      error: 'Filename cannot contain control characters.',
    };
  }
  if (PATH_SEPARATORS_RE.test(rawInput)) {
    return {
      ok: false,
      error: 'Filename cannot contain / or \\ path separators.',
    };
  }
  if (UNSAFE_FILENAME_CHARS_RE.test(rawInput)) {
    return {
      ok: false,
      error: 'Filename cannot contain < > : " | ? * characters.',
    };
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {ok: false, error: 'Filename cannot be empty.'};
  }
  if (trimmed === '.' || trimmed === '..') {
    return {ok: false, error: 'Enter a valid filename.'};
  }

  const withoutDotExt = trimmed.startsWith('.')
    ? trimmed.slice(1).toLowerCase()
    : '';
  if (withoutDotExt && KNOWN_EXPORT_EXTENSIONS.has(withoutDotExt)) {
    return {
      ok: false,
      error: `Enter a filename before .${withoutDotExt}.`,
    };
  }

  const strippedBase = stripKnownExportExtension(trimmed);
  if (!strippedBase || strippedBase === '.' || strippedBase === '..') {
    return {ok: false, error: 'Enter a valid filename.'};
  }

  if (RESERVED_DEVICE_NAMES.has(strippedBase.toUpperCase())) {
    return {
      ok: false,
      error: `"${strippedBase}" is a reserved operating system filename.`,
    };
  }

  const combinedBase = applySheetSuffix(strippedBase, format, options);
  const len = codePointLength(combinedBase);
  if (len > MAX_EXPORT_BASENAME_LENGTH) {
    return {
      ok: false,
      error: `Filename must be ${MAX_EXPORT_BASENAME_LENGTH} characters or fewer (${len} entered).`,
    };
  }

  return {
    ok: true,
    baseName: combinedBase,
    fileName: `${combinedBase}.${format}`,
    extension: format,
  };
}

/**
 * Non-throwing export filename builder for defaults and direct quick-exports.
 * Sanitizes disallowed chars cleanly, avoids duplicate extensions, and truncates safely.
 */
export function buildExportFilename(
  rawBaseName: string,
  format: ExportFormat,
  options?: {includeSheetSuffix?: boolean; sheetName?: string}
): string {
  const sanitized = rawBaseName
    .replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let stripped = stripKnownExportExtension(sanitized);
  if (
    !stripped ||
    stripped === '.' ||
    stripped === '..' ||
    (stripped.startsWith('.') &&
      KNOWN_EXPORT_EXTENSIONS.has(stripped.slice(1).toLowerCase()))
  ) {
    stripped = 'Untitled';
  }
  if (RESERVED_DEVICE_NAMES.has(stripped.toUpperCase())) {
    stripped = `${stripped}_export`;
  }

  const withSuffix = applySheetSuffix(stripped, format, options);
  const boundedBase =
    truncateCodePoints(withSuffix, MAX_EXPORT_BASENAME_LENGTH).trim() ||
    'Untitled';
  return `${boundedBase}.${format}`;
}

export function getDefaultExportFormat(
  workbook: Pick<WorkbookState, 'fileFormat' | 'sheets'>
): ExportFormat {
  if (workbook.sheets.length > 1) return 'xlsx';
  if (workbook.fileFormat === 'csv') return 'csv';
  if (workbook.fileFormat === 'tsv') return 'tsv';
  return 'xlsx';
}
