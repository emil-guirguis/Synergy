import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB-backed session + object layers; keep soap/wsdl real so we exercise
// the actual envelope build + parse path.
const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
const mockDropSession = vi.fn();
const mockAdvanceCursor = vi.fn();
const mockBuildWorkQueue = vi.fn();
const mockDispatchResponse = vi.fn();

vi.mock('../qbwc/session', () => ({
  createSession: (...a: any[]) => mockCreateSession(...a),
  getSession: (...a: any[]) => mockGetSession(...a),
  dropSession: (...a: any[]) => mockDropSession(...a),
  advanceCursor: (...a: any[]) => mockAdvanceCursor(...a),
}));
vi.mock('../qbwc/objects', () => ({
  buildWorkQueue: (...a: any[]) => mockBuildWorkQueue(...a),
  dispatchResponse: (...a: any[]) => mockDispatchResponse(...a),
  // Empty registry, so no response here belongs to an incremental object and
  // the drain bookkeeping stays out of these routing assertions.
  drainedQueryOwner: () => undefined,
  registry: [],
}));

import qbwcApp from './qbwc';

const ENV = {} as any; // unset QBWC_USERNAME/PASSWORD -> dev fallbacks tbwc/changeme

function soap(method: string, inner = ''): string {
  return `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method} xmlns="http://developer.intuit.com/">${inner}</${method}></soap:Body></soap:Envelope>`;
}
const post = (body: string) =>
  qbwcApp.request('/', { method: 'POST', body, headers: { 'Content-Type': 'text/xml' } }, ENV);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /qbwc', () => {
  it('serves the WSDL when ?wsdl is present', async () => {
    const res = await qbwcApp.request('/?wsdl', {}, ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    const xml = await res.text();
    expect(xml).toContain('wsdl:definitions');
  });

  it('accepts case-insensitive ?WSDL', async () => {
    const res = await qbwcApp.request('/?WSDL', {}, ENV);
    expect(await res.text()).toContain('wsdl:definitions');
  });

  it('returns liveness text on a plain GET', async () => {
    const res = await qbwcApp.request('/', {}, ENV);
    expect(await res.text()).toContain('QBWC SOAP endpoint');
  });
});

describe('POST /qbwc version handshake', () => {
  it('serverVersion returns 1.0.0', async () => {
    const xml = await (await post(soap('serverVersion'))).text();
    expect(xml).toContain('<serverVersionResult>1.0.0</serverVersionResult>');
  });

  it('clientVersion returns an empty (accept) result', async () => {
    const xml = await (await post(soap('clientVersion'))).text();
    expect(xml).toContain('<clientVersionResult></clientVersionResult>');
  });
});

describe('POST /qbwc authenticate', () => {
  it('rejects bad credentials with nvu and does not open a session', async () => {
    const body = soap('authenticate', '<strUserName>tbwc</strUserName><strPassword>wrong</strPassword>');
    const xml = await (await post(body)).text();
    expect(xml).toContain('<string>nvu</string>');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('accepts dev credentials, builds a queue, and opens a session', async () => {
    mockBuildWorkQueue.mockResolvedValue(['<QBXML>a</QBXML>']);
    const body = soap('authenticate', '<strUserName>tbwc</strUserName><strPassword>changeme</strPassword>');
    const xml = await (await post(body)).text();
    // second array element is "" (use open company file) when there IS work
    expect(xml).toMatch(/<string>[0-9a-f-]{36}<\/string><string><\/string>/);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  it('signals "none" when the work queue is empty', async () => {
    mockBuildWorkQueue.mockResolvedValue([]);
    const body = soap('authenticate', '<strUserName>tbwc</strUserName><strPassword>changeme</strPassword>');
    const xml = await (await post(body)).text();
    expect(xml).toContain('<string>none</string>');
  });

  it('returns the company file path when QBWC_COMPANY_FILE is set (unattended)', async () => {
    mockBuildWorkQueue.mockResolvedValue(['<QBXML>a</QBXML>']);
    const env = { QBWC_COMPANY_FILE: 'C:\\QB\\TBWC.qbw' } as any;
    const body = soap('authenticate', '<strUserName>tbwc</strUserName><strPassword>changeme</strPassword>');
    const res = await qbwcApp.request('/', { method: 'POST', body }, env);
    expect(await res.text()).toContain('<string>C:\\QB\\TBWC.qbw</string>');
  });

  it('still signals "none" with no work even when QBWC_COMPANY_FILE is set', async () => {
    mockBuildWorkQueue.mockResolvedValue([]);
    const env = { QBWC_COMPANY_FILE: 'C:\\QB\\TBWC.qbw' } as any;
    const body = soap('authenticate', '<strUserName>tbwc</strUserName><strPassword>changeme</strPassword>');
    const res = await qbwcApp.request('/', { method: 'POST', body }, env);
    expect(await res.text()).toContain('<string>none</string>');
  });

  it('honors QBWC_USERNAME/QBWC_PASSWORD overrides from env', async () => {
    mockBuildWorkQueue.mockResolvedValue([]);
    const env = { QBWC_USERNAME: 'prod', QBWC_PASSWORD: 'secret' } as any;
    const body = soap('authenticate', '<strUserName>prod</strUserName><strPassword>secret</strPassword>');
    const res = await qbwcApp.request('/', { method: 'POST', body }, env);
    expect(await res.text()).toContain('<string>none</string>');
    expect(mockCreateSession).toHaveBeenCalled();
  });
});

describe('POST /qbwc work loop', () => {
  it('sendRequestXML returns the qbXML at the cursor', async () => {
    mockGetSession.mockResolvedValue({ queue: ['<QBXML>REQ</QBXML>'], cursor: 0, lastError: '' });
    const xml = await (await post(soap('sendRequestXML', '<ticket>t1</ticket>'))).text();
    // qbXML is xml-escaped inside the SOAP result
    expect(xml).toContain('&lt;QBXML&gt;REQ&lt;/QBXML&gt;');
  });

  it('sendRequestXML returns empty when the cursor is past the queue', async () => {
    mockGetSession.mockResolvedValue({ queue: ['<a/>'], cursor: 1, lastError: '' });
    const xml = await (await post(soap('sendRequestXML', '<ticket>t1</ticket>'))).text();
    expect(xml).toContain('<sendRequestXMLResult></sendRequestXMLResult>');
  });

  it('sendRequestXML returns empty for an unknown ticket', async () => {
    mockGetSession.mockResolvedValue(undefined);
    const xml = await (await post(soap('sendRequestXML', '<ticket>ghost</ticket>'))).text();
    expect(xml).toContain('<sendRequestXMLResult></sendRequestXMLResult>');
  });

  it('receiveResponseXML dispatches the response and reports percent complete', async () => {
    mockGetSession.mockResolvedValue({ queue: ['<a/>', '<b/>'], cursor: 0, lastError: '' });
    mockAdvanceCursor.mockResolvedValue(1);
    const body = soap('receiveResponseXML', '<ticket>t1</ticket><response>&lt;QBXML/&gt;</response><hresult></hresult>');
    const xml = await (await post(body)).text();
    expect(mockDispatchResponse).toHaveBeenCalledTimes(1);
    // 1 of 2 -> 50
    expect(xml).toContain('<receiveResponseXMLResult>50</receiveResponseXMLResult>');
  });

  it('receiveResponseXML records the error and skips dispatch when hresult is set', async () => {
    mockGetSession.mockResolvedValue({ queue: ['<a/>'], cursor: 0, lastError: '' });
    mockAdvanceCursor.mockResolvedValue(1);
    const body = soap('receiveResponseXML', '<ticket>t1</ticket><response></response><hresult>0x80040400</hresult><message>QB busy</message>');
    await post(body);
    expect(mockDispatchResponse).not.toHaveBeenCalled();
    expect(mockAdvanceCursor).toHaveBeenCalledWith(ENV, 't1', 'QB busy');
  });

  it('receiveResponseXML returns 100 for an unknown ticket', async () => {
    mockGetSession.mockResolvedValue(undefined);
    const xml = await (await post(soap('receiveResponseXML', '<ticket>ghost</ticket>'))).text();
    expect(xml).toContain('<receiveResponseXMLResult>100</receiveResponseXMLResult>');
  });
});

describe('POST /qbwc teardown', () => {
  it('getLastError echoes the session lastError', async () => {
    mockGetSession.mockResolvedValue({ queue: [], cursor: 0, lastError: 'kaboom' });
    const xml = await (await post(soap('getLastError', '<ticket>t1</ticket>'))).text();
    expect(xml).toContain('<getLastErrorResult>kaboom</getLastErrorResult>');
  });

  it('getLastError reports "No error" when none recorded', async () => {
    mockGetSession.mockResolvedValue({ queue: [], cursor: 0, lastError: '' });
    const xml = await (await post(soap('getLastError', '<ticket>t1</ticket>'))).text();
    expect(xml).toContain('<getLastErrorResult>No error</getLastErrorResult>');
  });

  it('connectionError tells QBWC to stop ("done")', async () => {
    const xml = await (await post(soap('connectionError', '<message>lost</message>'))).text();
    expect(xml).toContain('<connectionErrorResult>done</connectionErrorResult>');
  });

  it('closeConnection drops the session and returns OK', async () => {
    const xml = await (await post(soap('closeConnection', '<ticket>t1</ticket>'))).text();
    expect(mockDropSession).toHaveBeenCalledWith(ENV, 't1');
    expect(xml).toContain('<closeConnectionResult>OK</closeConnectionResult>');
  });

  it('400 for an unrecognized SOAP method', async () => {
    const res = await post(soap('bogusMethod'));
    expect(res.status).toBe(400);
  });
});
