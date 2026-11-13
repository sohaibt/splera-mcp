import { describe, it, expect, vi } from 'vitest';

// Server started without SPLERA_API_KEY (e.g. a directory introspecting it):
// every API call must fail with an actionable error and never hit the network.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, loadConfig: () => ({ apiKey: '', apiUrl: 'https://api.test' }) };
});

import { apiFetch } from '../apiClient.js';

describe('apiFetch without an API key', () => {
  it('throws SPLERA_API_KEY_MISSING with a fix-it hint and makes no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/api/me')).rejects.toMatchObject({
      code: 'SPLERA_API_KEY_MISSING',
      hint: expect.stringContaining('SPLERA_API_KEY'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
