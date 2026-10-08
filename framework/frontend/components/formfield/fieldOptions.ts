export const TIMEZONE_OPTIONS: { value: string; label: string }[] = (
  typeof Intl !== 'undefined' && (Intl as any).supportedValuesOf
    ? (Intl as any).supportedValuesOf('timeZone') as string[]
    : []
).map((tz: string) => ({ value: tz, label: tz }));

export const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — British Pound' },
  { value: 'CAD', label: 'CAD — Canadian Dollar' },
  { value: 'AUD', label: 'AUD — Australian Dollar' },
  { value: 'NZD', label: 'NZD — New Zealand Dollar' },
  { value: 'CHF', label: 'CHF — Swiss Franc' },
  { value: 'JPY', label: 'JPY — Japanese Yen' },
  { value: 'CNY', label: 'CNY — Chinese Yuan' },
  { value: 'INR', label: 'INR — Indian Rupee' },
  { value: 'BRL', label: 'BRL — Brazilian Real' },
  { value: 'MXN', label: 'MXN — Mexican Peso' },
  { value: 'SGD', label: 'SGD — Singapore Dollar' },
  { value: 'HKD', label: 'HKD — Hong Kong Dollar' },
  { value: 'SEK', label: 'SEK — Swedish Krona' },
  { value: 'NOK', label: 'NOK — Norwegian Krone' },
  { value: 'DKK', label: 'DKK — Danish Krone' },
  { value: 'PLN', label: 'PLN — Polish Zloty' },
  { value: 'CZK', label: 'CZK — Czech Koruna' },
  { value: 'HUF', label: 'HUF — Hungarian Forint' },
  { value: 'ZAR', label: 'ZAR — South African Rand' },
  { value: 'AED', label: 'AED — UAE Dirham' },
  { value: 'SAR', label: 'SAR — Saudi Riyal' },
  { value: 'KRW', label: 'KRW — South Korean Won' },
  { value: 'THB', label: 'THB — Thai Baht' },
  { value: 'MYR', label: 'MYR — Malaysian Ringgit' },
  { value: 'IDR', label: 'IDR — Indonesian Rupiah' },
  { value: 'PHP', label: 'PHP — Philippine Peso' },
  { value: 'VND', label: 'VND — Vietnamese Dong' },
  { value: 'EGP', label: 'EGP — Egyptian Pound' },
  { value: 'NGN', label: 'NGN — Nigerian Naira' },
  { value: 'KES', label: 'KES — Kenyan Shilling' },
  { value: 'ARS', label: 'ARS — Argentine Peso' },
  { value: 'CLP', label: 'CLP — Chilean Peso' },
  { value: 'COP', label: 'COP — Colombian Peso' },
  { value: 'PEN', label: 'PEN — Peruvian Sol' },
];

// Tokens: YYYY/YY/MMMM(full month)/MMM(abbreviated)/MM/M/DD/D, case-insensitive
// — see dateHelpers.ts's formatDate.
export const DATE_FORMAT_OPTIONS = [
  { value: 'mm/dd/yyyy', label: 'MM/DD/YYYY (e.g. 10/07/2026)' },
  { value: 'dd/mm/yyyy', label: 'DD/MM/YYYY (e.g. 07/10/2026)' },
  { value: 'yyyy-mm-dd', label: 'YYYY-MM-DD (e.g. 2026-10-07)' },
  { value: 'dd-mm-yyyy', label: 'DD-MM-YYYY (e.g. 07-10-2026)' },
  { value: 'mm-dd-yyyy', label: 'MM-DD-YYYY (e.g. 10-07-2026)' },
  { value: 'dd.mm.yyyy', label: 'DD.MM.YYYY — European (e.g. 07.10.2026)' },
  { value: 'mmmm d, yyyy', label: 'Month D, YYYY (e.g. October 7, 2026)' },
];

// Matches useBaseList's pagination.pageSizeOptions ([10, 25, 50, 100]) — no
// point offering a default the list UI's own size-changer can't also pick.
export const PAGE_SIZE_OPTIONS = [
  { value: 10, label: '10' },
  { value: 25, label: '25' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
];

/**
 * Ensures a fixed options list always contains the actual stored value, even
 * one that predates this dropdown (e.g. a page size saved before it was
 * constrained to 10/25/50/100, or a date format typed freely in the old
 * text field) — otherwise a MUI `<Select>` whose `value` matches no
 * `MenuItem` renders blank and can misbehave on the next selection.
 */
export function withCurrentValue<T extends string | number>(
  options: { value: T; label: string }[],
  current: T | null | undefined,
  formatLabel: (value: T) => string = (v) => String(v)
): { value: T; label: string }[] {
  if (current === null || current === undefined || (current as unknown) === '') return options;
  if (options.some((o) => o.value === current)) return options;
  return [...options, { value: current, label: `${formatLabel(current)} (current)` }];
}

export const LANGUAGE_OPTIONS = [
  { value: 'en',    label: 'English' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'es',    label: 'Spanish' },
  { value: 'es-MX', label: 'Spanish (Mexico)' },
  { value: 'fr',    label: 'French' },
  { value: 'fr-CA', label: 'French (Canada)' },
  { value: 'de',    label: 'German' },
  { value: 'it',    label: 'Italian' },
  { value: 'pt',    label: 'Portuguese' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'nl',    label: 'Dutch' },
  { value: 'sv',    label: 'Swedish' },
  { value: 'no',    label: 'Norwegian' },
  { value: 'da',    label: 'Danish' },
  { value: 'fi',    label: 'Finnish' },
  { value: 'pl',    label: 'Polish' },
  { value: 'cs',    label: 'Czech' },
  { value: 'hu',    label: 'Hungarian' },
  { value: 'ro',    label: 'Romanian' },
  { value: 'tr',    label: 'Turkish' },
  { value: 'ru',    label: 'Russian' },
  { value: 'uk',    label: 'Ukrainian' },
  { value: 'ar',    label: 'Arabic' },
  { value: 'he',    label: 'Hebrew' },
  { value: 'zh',    label: 'Chinese (Simplified)' },
  { value: 'zh-TW', label: 'Chinese (Traditional)' },
  { value: 'ja',    label: 'Japanese' },
  { value: 'ko',    label: 'Korean' },
  { value: 'hi',    label: 'Hindi' },
  { value: 'th',    label: 'Thai' },
  { value: 'vi',    label: 'Vietnamese' },
  { value: 'id',    label: 'Indonesian' },
  { value: 'ms',    label: 'Malay' },
  { value: 'tl',    label: 'Filipino' },
  { value: 'sw',    label: 'Swahili' },
  { value: 'af',    label: 'Afrikaans' },
];
