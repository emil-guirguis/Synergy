import { describe, it, expect, vi, beforeEach } from 'vitest';

// The webhook is unauthenticated — Graph has no TBWC credential — so these
// tests exist mainly to pin down that clientState is what gates it. A
// notification naming a real subscription with the wrong (or no) clientState
// must not cause a pull-back.
const { mockSessionForNotification, mockPullBack } = vi.hoisted(() => ({
  mockSessionForNotification: vi.fn(),
  mockPullBack: vi.fn(),
}));
vi.mock('../officeEditSync', () => ({
  sessionForNotification: (...a: any[]) => mockSessionForNotification(...a),
  pullBack: (...a: any[]) => mockPullBack(...a),
}));

import webhookApp from './officeEditWebhook';

const ENV = {} as any;
const EXECUTION_CTX = {
  waitUntil: (p: Promise<any>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
  props: {},
};
const req = (path: string, init?: RequestInit) => webhookApp.request(path, init, ENV, EXECUTION_CTX);
const notify = (value: any[]) => ({
  method: 'POST',
  body: JSON.stringify({ value }),
  headers: { 'Content-Type': 'application/json' },
});

const SESSION = {
  office_edit_session_id: 7,
  document_id: 42,
  drive_id: 'drive-1',
  item_id: 'item-1',
  subscription_id: 'sub-1',
  client_state: 'secret-1',
  last_etag: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPullBack.mockResolvedValue(true);
});

describe('office-edit webhook', () => {
  it('echoes the validation token as plain text so Graph will accept the subscription', async () => {
    const res = await req('/?validationToken=abc%20123', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc 123');
    expect(mockSessionForNotification).not.toHaveBeenCalled();
  });

  it('pulls the edit back for a notification whose clientState matches', async () => {
    mockSessionForNotification.mockResolvedValue(SESSION);
    const res = await req('/', notify([{ subscriptionId: 'sub-1', clientState: 'secret-1' }]));
    expect(res.status).toBe(202);
    expect(mockSessionForNotification).toHaveBeenCalledWith(ENV, 'sub-1', 'secret-1');
    expect(mockPullBack).toHaveBeenCalledWith(ENV, SESSION);
  });

  it('drops a notification whose clientState does not match the subscription', async () => {
    // sessionForNotification answers null on a mismatch — the route must treat
    // that as "not for us" rather than falling back to the subscription id.
    mockSessionForNotification.mockResolvedValue(null);
    const res = await req('/', notify([{ subscriptionId: 'sub-1', clientState: 'wrong' }]));
    expect(res.status).toBe(202);
    expect(mockPullBack).not.toHaveBeenCalled();
  });

  it('ignores a notification with no clientState at all', async () => {
    const res = await req('/', notify([{ subscriptionId: 'sub-1' }]));
    expect(res.status).toBe(202);
    expect(mockSessionForNotification).not.toHaveBeenCalled();
    expect(mockPullBack).not.toHaveBeenCalled();
  });

  it('answers 202 on a malformed body instead of making Graph retry forever', async () => {
    const res = await req('/', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(202);
    expect(mockPullBack).not.toHaveBeenCalled();
  });

  it('handles every notification in a batch independently', async () => {
    mockSessionForNotification.mockImplementation(async (_env: any, id: string, state: string) =>
      id === 'sub-1' && state === 'secret-1' ? SESSION : null
    );
    const res = await req(
      '/',
      notify([
        { subscriptionId: 'sub-1', clientState: 'secret-1' },
        { subscriptionId: 'sub-2', clientState: 'wrong' },
      ])
    );
    expect(res.status).toBe(202);
    expect(mockPullBack).toHaveBeenCalledTimes(1);
    expect(mockPullBack).toHaveBeenCalledWith(ENV, SESSION);
  });
});
