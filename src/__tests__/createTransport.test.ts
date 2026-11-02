/**
 * Unit tests for createTransport factory.
 */

import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { wsUrlToWtUrl, createTransport } from '../connection/createTransport';
import { WebSocketTransport } from '../connection/WebSocketTransport';
import { WebTransportClient, isWebTransportAvailable } from '../connection/WebTransportClient';

// Mock the transport implementations
vi.mock('../connection/WebSocketTransport');
vi.mock('../connection/WebTransportClient');

describe('wsUrlToWtUrl', () => {
  // Helper to check URL has port in valid range (7778-7809)
  function expectValidWtUrl(result: string, expectedBase: string, expectedPath: string = '/wt', expectedQuery: string = '') {
    const url = new URL(result);
    const port = parseInt(url.port, 10);
    expect(port).toBeGreaterThanOrEqual(7778);
    expect(port).toBeLessThanOrEqual(7809);
    expect(url.protocol + '//' + url.hostname).toBe(expectedBase);
    expect(url.pathname).toBe(expectedPath);
    if (expectedQuery) {
      expect(url.search).toBe(expectedQuery);
    }
  }

  it('transforms wss:// to https:// with port in range 7778-7809', () => {
    const result = wsUrlToWtUrl('wss://smash-1.larksh.com/ws');
    expectValidWtUrl(result, 'https://smash-1.larksh.com');
  });

  it('transforms ws:// to http:// with port in range 7778-7809', () => {
    const result = wsUrlToWtUrl('ws://localhost/ws');
    expectValidWtUrl(result, 'http://localhost');
  });

  it('handles URLs with existing ports', () => {
    const result = wsUrlToWtUrl('wss://smash-1.larksh.com:443/ws');
    expectValidWtUrl(result, 'https://smash-1.larksh.com');
  });

  it('handles URLs with query parameters', () => {
    const result = wsUrlToWtUrl('wss://server.com/ws?token=abc');
    expectValidWtUrl(result, 'https://server.com', '/wt', '?token=abc');
  });

  it('handles URLs with different paths', () => {
    const result = wsUrlToWtUrl('wss://server.com/some/other/path');
    expectValidWtUrl(result, 'https://server.com');
  });

  it('uses random ports for load balancing', () => {
    // Call multiple times and verify we get different ports (probabilistically)
    const ports = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const result = wsUrlToWtUrl('wss://server.com/ws');
      const url = new URL(result);
      ports.add(parseInt(url.port, 10));
    }
    // With 100 calls and 32 possible ports, we should get multiple different ports
    expect(ports.size).toBeGreaterThan(1);
  });
});

describe('createTransport', () => {
  let mockWsInstance: { connect: Mock; send: Mock; sendVolatile: Mock; close: Mock; connected: boolean };
  let mockWtInstance: { connect: Mock; send: Mock; sendVolatile: Mock; close: Mock; connected: boolean };
  const mockCallbacks = {
    onMessage: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockWsInstance = {
      connect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      sendVolatile: vi.fn(),
      close: vi.fn(),
      connected: true,
    };

    mockWtInstance = {
      connect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      sendVolatile: vi.fn(),
      close: vi.fn(),
      connected: true,
    };

    (WebSocketTransport as unknown as Mock).mockImplementation(function () {
      return mockWsInstance;
    });
    (WebTransportClient as unknown as Mock).mockImplementation(function () {
      return mockWtInstance;
    });
  });

  describe('with transport: "websocket"', () => {
    it('uses WebSocket directly without trying WebTransport', async () => {
      const result = await createTransport(
        'wss://server.com/ws',
        mockCallbacks,
        { transport: 'websocket' }
      );

      expect(result.type).toBe('websocket');
      expect(result.transport).toBe(mockWsInstance);
      expect(result.url).toBe('wss://server.com/ws');
      expect(WebSocketTransport).toHaveBeenCalledWith(mockCallbacks);
      expect(WebTransportClient).not.toHaveBeenCalled();
    });
  });

  describe('with transport: "webtransport"', () => {
    it('throws if WebTransport is not available', async () => {
      (isWebTransportAvailable as unknown as Mock).mockReturnValue(false);

      await expect(
        createTransport('wss://server.com/ws', mockCallbacks, { transport: 'webtransport' })
      ).rejects.toThrow('WebTransport is not available');
    });

    it('uses WebTransport when available', async () => {
      (isWebTransportAvailable as unknown as Mock).mockReturnValue(true);

      const result = await createTransport(
        'wss://server.com/ws',
        mockCallbacks,
        { transport: 'webtransport' }
      );

      expect(result.type).toBe('webtransport');
      expect(result.transport).toBe(mockWtInstance);
      // URL should have port in range 7778-7809
      const url = new URL(result.url);
      expect(url.protocol).toBe('https:');
      expect(url.hostname).toBe('server.com');
      expect(parseInt(url.port, 10)).toBeGreaterThanOrEqual(7778);
      expect(parseInt(url.port, 10)).toBeLessThanOrEqual(7809);
      expect(url.pathname).toBe('/wt');
      expect(WebTransportClient).toHaveBeenCalledWith(mockCallbacks);
    });

    it('does not fallback to WebSocket on failure', async () => {
      (isWebTransportAvailable as unknown as Mock).mockReturnValue(true);
      mockWtInstance.connect.mockRejectedValue(new Error('Connection failed'));

      await expect(
        createTransport('wss://server.com/ws', mockCallbacks, { transport: 'webtransport' })
      ).rejects.toThrow('Connection failed');

      expect(WebSocketTransport).not.toHaveBeenCalled();
    });
  });

  describe('default (no transport option)', () => {
    it('uses WebSocket by default', async () => {
      (isWebTransportAvailable as unknown as Mock).mockReturnValue(true);

      const result = await createTransport('wss://server.com/ws', mockCallbacks);

      expect(result.type).toBe('websocket');
      expect(result.transport).toBe(mockWsInstance);
      expect(WebTransportClient).not.toHaveBeenCalled();
    });
  });

  describe('with transport: "auto"', () => {
    it('uses WebSocket when WebTransport is not available', async () => {
      (isWebTransportAvailable as unknown as Mock).mockReturnValue(false);

      const result = await createTransport('wss://server.com/ws', mockCallbacks, { transport: 'auto' });

      expect(result.type).toBe('websocket');
      expect(result.transport).toBe(mockWsInstance);
      expect(WebTransportClient).not.toHaveBeenCalled();
    });

    it('tries WebTransport first when available', async () => {
      (isWebTransportAvailable as unknown as Mock).mockReturnValue(true);

      const result = await createTransport('wss://server.com/ws', mockCallbacks, { transport: 'auto' });

      expect(result.type).toBe('webtransport');
      expect(result.transport).toBe(mockWtInstance);
    });

    it('falls back to WebSocket when WebTransport connection fails', async () => {
      (isWebTransportAvailable as unknown as Mock).mockReturnValue(true);
      mockWtInstance.connect.mockRejectedValue(new Error('WebTransport failed'));

      const result = await createTransport('wss://server.com/ws', mockCallbacks, { transport: 'auto' });

      expect(result.type).toBe('websocket');
      expect(result.transport).toBe(mockWsInstance);
      expect(WebTransportClient).toHaveBeenCalled();
      expect(WebSocketTransport).toHaveBeenCalled();
    });

    it('falls back to WebSocket when WebTransport connection times out', async () => {
      vi.useFakeTimers();
      (isWebTransportAvailable as unknown as Mock).mockReturnValue(true);
      // Connection that never resolves
      mockWtInstance.connect.mockImplementation(() => new Promise(() => {}));

      const resultPromise = createTransport('wss://server.com/ws', mockCallbacks, { transport: 'auto' });

      // Advance past the default 2000ms timeout
      await vi.advanceTimersByTimeAsync(2001);

      const result = await resultPromise;

      expect(result.type).toBe('websocket');
      expect(result.transport).toBe(mockWsInstance);
      expect(mockWtInstance.close).toHaveBeenCalled(); // Should clean up

      vi.useRealTimers();
    });

    it('uses custom webtransportTimeout', async () => {
      vi.useFakeTimers();
      (isWebTransportAvailable as unknown as Mock).mockReturnValue(true);
      mockWtInstance.connect.mockImplementation(() => new Promise(() => {}));

      const resultPromise = createTransport('wss://server.com/ws', mockCallbacks, {
        transport: 'auto',
        webtransportTimeout: 500,
      });

      // Should not have timed out yet
      await vi.advanceTimersByTimeAsync(400);

      // Advance past the custom 500ms timeout
      await vi.advanceTimersByTimeAsync(101);

      const result = await resultPromise;

      expect(result.type).toBe('websocket');

      vi.useRealTimers();
    });

    it('respects timeout when explicitly requesting webtransport', async () => {
      vi.useFakeTimers();
      (isWebTransportAvailable as unknown as Mock).mockReturnValue(true);
      mockWtInstance.connect.mockImplementation(() => new Promise(() => {}));

      const resultPromise = createTransport('wss://server.com/ws', mockCallbacks, {
        transport: 'webtransport',
        webtransportTimeout: 100,
      });

      // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
      const expectation = expect(resultPromise).rejects.toThrow('WebTransport connection timeout');

      await vi.advanceTimersByTimeAsync(101);

      await expectation;

      vi.useRealTimers();
    });
  });
});
