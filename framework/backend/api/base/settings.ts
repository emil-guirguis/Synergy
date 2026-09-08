/**
 * Base "basic settings" module — the org-info + system-config fields every
 * consuming app shows on its Settings page. Each app owns its own singleton
 * settings row (MeterItPro's `tenant` table, TBWC's `company_settings` table)
 * and its own Hono route (auth/permission middleware differs per app), but
 * both use the same column names for these fields, so the mapping logic
 * lives here once instead of being hand-copied per app.
 *
 * App-specific extras (features/integrations, sync servers, etc.) are layered
 * on top by the app's own route — see MeterItPro/api/worker/routes/settings.ts.
 */

export interface BasicSettingsRow {
  name?: string | null;
  street?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  url?: string | null;
  contact_email?: string | null;
  timezone?: string | null;
  date_format?: string | null;
  time_format?: string | null;
  currency?: string | null;
  language?: string | null;
  default_page_size?: number | null;
  updated_at?: string | null;
}

export interface BasicSettings {
  name: string;
  address: {
    street: string;
    street2: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  contactInfo: {
    url: string;
    email: string;
  };
  systemConfig: {
    timezone: string;
    dateFormat: string;
    timeFormat: string;
    currency: string;
    language: string;
    defaultPageSize: number;
  };
  updatedAt: string | null;
}

/** Map a row with the base settings columns to the shape the frontend forms expect. */
export function rowToBasicSettings(row: BasicSettingsRow): BasicSettings {
  return {
    name: row.name ?? '',
    address: {
      street: row.street ?? '',
      street2: row.street2 ?? '',
      city: row.city ?? '',
      state: row.state ?? '',
      zip: row.zip ?? '',
      country: row.country ?? '',
    },
    contactInfo: {
      url: row.url ?? '',
      email: row.contact_email ?? '',
    },
    systemConfig: {
      timezone: row.timezone ?? '',
      dateFormat: row.date_format ?? '',
      timeFormat: row.time_format ?? '12h',
      currency: row.currency ?? '',
      language: row.language ?? '',
      defaultPageSize: row.default_page_size ?? 20,
    },
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Flatten a PUT body (BasicSettings-shaped, all fields optional) into
 * {dbColumn: value} for the base fields only — mirrors a PUT-body allowlist so
 * callers can't write arbitrary columns through this path. Fields not present
 * in the body are omitted (not overwritten).
 */
export function basicSettingsToRow(body: any): Record<string, any> {
  const row: Record<string, any> = {};
  if (body.name !== undefined) row.name = body.name;
  if (body.address?.street !== undefined) row.street = body.address.street;
  if (body.address?.street2 !== undefined) row.street2 = body.address.street2;
  if (body.address?.city !== undefined) row.city = body.address.city;
  if (body.address?.state !== undefined) row.state = body.address.state;
  if (body.address?.zip !== undefined) row.zip = body.address.zip;
  if (body.address?.country !== undefined) row.country = body.address.country;
  if (body.contactInfo?.url !== undefined) row.url = body.contactInfo.url;
  if (body.contactInfo?.email !== undefined) row.contact_email = body.contactInfo.email;
  if (body.systemConfig?.timezone !== undefined) row.timezone = body.systemConfig.timezone;
  if (body.systemConfig?.dateFormat !== undefined) row.date_format = body.systemConfig.dateFormat;
  if (body.systemConfig?.timeFormat !== undefined) row.time_format = body.systemConfig.timeFormat;
  if (body.systemConfig?.currency !== undefined) row.currency = body.systemConfig.currency;
  if (body.systemConfig?.language !== undefined) row.language = body.systemConfig.language;
  if (body.systemConfig?.defaultPageSize !== undefined) row.default_page_size = body.systemConfig.defaultPageSize;
  return row;
}
