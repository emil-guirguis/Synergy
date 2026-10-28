import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendMail } from './mail';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockResolvedValue({ ok: true, text: async () => '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ENV = (overrides: any = {}) => ({
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  ENVIRONMENT: 'development',
  ...overrides,
}) as any;

function sentBody() {
  return JSON.parse(mockFetch.mock.calls[0][1].body);
}

describe('sendMail', () => {
  it('throws (and never calls out) when the service role key is not configured', async () => {
    await expect(
      sendMail(ENV({ SUPABASE_SERVICE_ROLE_KEY: undefined }), { type: 'document', email: 'c@x.com' })
    ).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('redirects to the dev test address outside of production, tagging the subject with the real recipient', async () => {
    await sendMail(ENV(), { type: 'document', email: 'customer@acme.com', subject: 'Late Invoice INV-1' });
    expect(sentBody().email).toBe('emilguirguis@yahoo.com');
    expect(sentBody().subject).toBe('[dev → customer@acme.com] Late Invoice INV-1');
  });

  it('sends to the real address, subject untouched, in production', async () => {
    await sendMail(ENV({ ENVIRONMENT: 'production' }), { type: 'document', email: 'customer@acme.com', subject: 'Late Invoice INV-1' });
    expect(sentBody().email).toBe('customer@acme.com');
    expect(sentBody().subject).toBe('Late Invoice INV-1');
  });

  it('redirects every email type outside of production, not just document', async () => {
    await sendMail(ENV(), { type: 'invite', email: 'rep@acme.com', firstName: 'Pat', link: 'https://x/invite' });
    expect(sentBody().email).toBe('emilguirguis@yahoo.com');
  });

  it('leaves a payload with no subject alone rather than tagging "undefined"', async () => {
    await sendMail(ENV(), { type: 'invite', email: 'rep@acme.com' });
    expect(sentBody().subject).toBeUndefined();
  });

  it('throws when the edge fn itself fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    await expect(sendMail(ENV(), { type: 'document', email: 'c@x.com' })).rejects.toThrow(/send-mail failed \(500\)/);
  });
});
