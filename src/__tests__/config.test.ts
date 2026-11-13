import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, isBelow } from '../config.js';

/**
 * loadConfig() fails fast via process.exit(1). We stub exit to throw so the
 * function short-circuits cleanly instead of continuing past the error with
 * undefined state. Tests then assert the throw + the exit call.
 */
describe('loadConfig', () => {
  const originalEnv = { ...process.env };
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clean slate — individual tests opt in to the env vars they need.
    delete process.env.SPLERA_API_KEY;
    delete process.env.SPLERA_API_URL;

    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore the real process.env to avoid cross-file contamination.
    process.env = { ...originalEnv };
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exits(1) when SPLERA_API_KEY is missing', () => {
    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('SPLERA_API_KEY not set')
    );
  });

  it('exits(1) when SPLERA_API_KEY is empty string (falsy)', () => {
    process.env.SPLERA_API_KEY = '';
    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits(1) when SPLERA_API_URL is malformed', () => {
    process.env.SPLERA_API_KEY = 'splera_live_abc';
    process.env.SPLERA_API_URL = 'not a url at all';

    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('not a valid URL')
    );
  });

  it('exits(1) when SPLERA_API_URL uses plain http with a non-localhost apex domain', () => {
    process.env.SPLERA_API_KEY = 'splera_live_abc';
    process.env.SPLERA_API_URL = 'http://splera.app';

    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('must use https://')
    );
  });

  it('exits(1) for non-https, non-localhost scheme like ftp://', () => {
    process.env.SPLERA_API_KEY = 'splera_live_abc';
    process.env.SPLERA_API_URL = 'ftp://splera.app';

    expect(() => loadConfig()).toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('allows plain http for localhost (local dev)', () => {
    process.env.SPLERA_API_KEY = 'splera_live_abc';
    process.env.SPLERA_API_URL = 'http://localhost:3000';

    const cfg = loadConfig();
    expect(cfg.apiKey).toBe('splera_live_abc');
    expect(cfg.apiUrl).toBe('http://localhost:3000');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('allows plain http for 127.0.0.1', () => {
    process.env.SPLERA_API_KEY = 'splera_live_abc';
    process.env.SPLERA_API_URL = 'http://127.0.0.1:3000';

    const cfg = loadConfig();
    expect(cfg.apiUrl).toBe('http://127.0.0.1:3000');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('allows plain http for 0.0.0.0', () => {
    process.env.SPLERA_API_KEY = 'splera_live_abc';
    process.env.SPLERA_API_URL = 'http://0.0.0.0:3000';

    const cfg = loadConfig();
    expect(cfg.apiUrl).toBe('http://0.0.0.0:3000');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('defaults SPLERA_API_URL to https://splera.app when unset', () => {
    process.env.SPLERA_API_KEY = 'splera_live_abc';

    const cfg = loadConfig();
    expect(cfg.apiUrl).toBe('https://splera.app');
  });

  it('returns the URL origin (strips trailing path) on a valid https URL', () => {
    process.env.SPLERA_API_KEY = 'splera_live_abc';
    process.env.SPLERA_API_URL = 'https://splera.app/some/extra/path';

    const cfg = loadConfig();
    expect(cfg.apiUrl).toBe('https://splera.app');
  });

  it('returns the parsed apiKey verbatim on the happy path', () => {
    process.env.SPLERA_API_KEY = 'splera_live_XYZ123';
    process.env.SPLERA_API_URL = 'https://splera.app';

    const cfg = loadConfig();
    expect(cfg.apiKey).toBe('splera_live_XYZ123');
  });
});

describe('isBelow', () => {
  it('returns true when current is strictly less than minimum (patch)', () => {
    expect(isBelow('0.1.0', '0.1.1')).toBe(true);
  });

  it('returns true when current is strictly less than minimum (minor)', () => {
    expect(isBelow('0.1.0', '0.2.0')).toBe(true);
  });

  it('returns true when current is strictly less than minimum (major)', () => {
    expect(isBelow('0.9.9', '1.0.0')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isBelow('0.1.0', '0.1.0')).toBe(false);
  });

  it('returns false when current is greater than minimum', () => {
    expect(isBelow('0.2.0', '0.1.9')).toBe(false);
  });

  it('returns false when current major is greater than minimum major', () => {
    expect(isBelow('2.0.0', '1.99.99')).toBe(false);
  });

  it('treats missing components as 0', () => {
    // '1' parsed as [1, NaN, NaN] → ?? 0 coerces, so '1' == '1.0.0'.
    expect(isBelow('1', '1.0.0')).toBe(false);
    expect(isBelow('1', '1.0.1')).toBe(true);
  });
});
