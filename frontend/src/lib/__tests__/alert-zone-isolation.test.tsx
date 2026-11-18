import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppShell } from '@/components/layout/AppShell';
import { ToastProvider } from '@/components/ui/primitives';
import { alertsApi } from '@/features/alerts/api';
import { authApi } from '@/features/auth/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import {
  type AlertZoneScope,
  isAlertInUserZones,
  useGlobalAlertStream,
} from '@/lib/realtime/use-room-stream';
import type {
  AlertResponse,
  DeviceResponse,
  PageResponse,
  UserResponse,
} from '@/types/api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/dashboard',
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function makeAlert(overrides: Partial<AlertResponse> = {}): AlertResponse {
  return {
    id: 'alert-1',
    deviceId: 'dev-a',
    hardwareId: 'ESP32-A1',
    roomId: 'room-a',
    zoneId: 'ZONE_A',
    type: 'NOISE_EXCEEDED',
    severity: 'HIGH',
    severityRank: 3,
    status: 'FIRING',
    currentValue: 72.5,
    threshold: 55.0,
    message: 'Độ ồn vượt ngưỡng tại phòng đọc',
    recommendedAction: 'Kiểm tra khu vực đọc',
    startedAt: '2026-11-17T05:00:00Z',
    acknowledgedAt: null,
    resolvedAt: null,
    acknowledgedBy: null,
    resolvedBy: null,
    ...overrides,
  };
}

function makeDevice(overrides: Partial<DeviceResponse> = {}): DeviceResponse {
  return {
    id: 'dev-a',
    name: 'Node Zone A',
    hardwareId: 'ESP32-A1',
    zoneId: 'ZONE_A',
    roomId: 'room-a',
    deviceType: 'ESP32_ENV_NOISE',
    active: true,
    lastSeenAt: '2026-11-17T05:00:00Z',
    connectionState: 'ONLINE',
    lastOfflineAt: null,
    online: true,
    ...overrides,
  };
}

function makeUser(overrides: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 'user-1',
    username: 'librarian_a',
    active: true,
    roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
    assignedZones: ['ZONE_A'],
    ...overrides,
  };
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

describe('P0-1 Zone Isolation: isAlertInUserZones()', () => {
  it('allows all alerts for ADMIN regardless of zoneId or assignedZones', () => {
    expect(
      isAlertInUserZones(makeAlert({ zoneId: 'ZONE_B' }), true, [])
    ).toBe(true);
    expect(
      isAlertInUserZones(makeAlert({ zoneId: null }), true, undefined)
    ).toBe(true);
  });

  it('fails closed when non-admin has undefined or empty assignedZones', () => {
    const rooms = new Set(['room-a']);
    const devices = new Set(['dev-a']);

    expect(
      isAlertInUserZones(
        makeAlert({ zoneId: 'ZONE_A' }),
        false,
        undefined,
        rooms,
        devices
      )
    ).toBe(false);
    expect(
      isAlertInUserZones(
        makeAlert({ zoneId: 'ZONE_A' }),
        false,
        [],
        rooms,
        devices
      )
    ).toBe(false);
  });

  it('treats non-blank alert.zoneId as authoritative without falling through to room/device sets', () => {
    const rooms = new Set(['room-a', 'room-b']);
    const devices = new Set(['dev-a', 'dev-b']);

    expect(
      isAlertInUserZones(
        makeAlert({ zoneId: 'ZONE_A', deviceId: 'dev-other', roomId: 'room-other' }),
        false,
        ['ZONE_A'],
        rooms,
        devices
      )
    ).toBe(true);

    // Even if deviceId/roomId appear in fallback sets, explicit ZONE_B must be rejected
    expect(
      isAlertInUserZones(
        makeAlert({ zoneId: 'ZONE_B', deviceId: 'dev-a', roomId: 'room-a' }),
        false,
        ['ZONE_A'],
        rooms,
        devices
      )
    ).toBe(false);
  });

  it('falls back to allowedDeviceIds and allowedRoomIds when alert.zoneId is null/undefined/blank', () => {
    const rooms = new Set(['room-a']);
    const devices = new Set(['dev-a']);

    // Matches via deviceId (including DEVICE_OFFLINE with roomId: null)
    expect(
      isAlertInUserZones(
        makeAlert({
          zoneId: null,
          type: 'DEVICE_OFFLINE',
          deviceId: 'dev-a',
          roomId: null,
        }),
        false,
        ['ZONE_A'],
        rooms,
        devices
      )
    ).toBe(true);

    // Matches via roomId when deviceId differs
    expect(
      isAlertInUserZones(
        makeAlert({
          zoneId: undefined,
          deviceId: 'dev-unknown',
          roomId: 'room-a',
        }),
        false,
        ['ZONE_A'],
        rooms,
        devices
      )
    ).toBe(true);

    // Blank whitespace zoneId triggers fallback; unknown device & room fail closed
    expect(
      isAlertInUserZones(
        makeAlert({
          zoneId: '   ',
          deviceId: 'dev-b',
          roomId: 'room-b',
        }),
        false,
        ['ZONE_A'],
        rooms,
        devices
      )
    ).toBe(false);

    // Missing fallback sets fail closed
    expect(
      isAlertInUserZones(
        makeAlert({ zoneId: '' }),
        false,
        ['ZONE_A']
      )
    ).toBe(false);
  });
});

describe('P0-1 Zone Isolation: useGlobalAlertStream() (Test 5)', () => {
  let capturedListener: ((alert: AlertResponse) => void) | null = null;
  let unsubscribeSpy: ReturnType<typeof vi.fn>;
  let onAlertSpy: MockInstance<typeof stompManager.onAlert>;

  beforeEach(() => {
    capturedListener = null;
    unsubscribeSpy = vi.fn();
    onAlertSpy = vi
      .spyOn(stompManager, 'onAlert')
      .mockImplementation((listener) => {
        capturedListener = listener;
        return unsubscribeSpy;
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks ZONE_B alerts for ZONE_A client (no cache mutation, no unread-count invalidation, no onNewAlert) while allowing ZONE_A', () => {
    const queryClient = createTestQueryClient();
    const listKey = ['alerts', 'list', { page: 0, size: 20 }] as const;
    const initialPage: PageResponse<AlertResponse> = {
      content: [],
      page: 0,
      size: 20,
      totalElements: 0,
      totalPages: 0,
      last: true,
    };
    queryClient.setQueryData(listKey, initialPage);
    queryClient.setQueryData(['alerts', 'unread-count'], 0);

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');
    const onNewAlert = vi.fn();

    const zoneScope: AlertZoneScope = {
      isAdmin: false,
      assignedZones: ['ZONE_A'],
      allowedRoomIds: new Set(['room-a']),
      allowedDeviceIds: new Set(['dev-a']),
    };

    renderHook(
      () => useGlobalAlertStream(true, onNewAlert, zoneScope),
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      }
    );

    expect(onAlertSpy).toHaveBeenCalledTimes(1);
    expect(capturedListener).not.toBeNull();

    // 1. Incoming ZONE_B alert must be completely dropped
    const zoneBAlert = makeAlert({
      id: 'alert-zone-b',
      deviceId: 'dev-b',
      hardwareId: 'ESP32-B1',
      roomId: 'room-b',
      zoneId: 'ZONE_B',
      status: 'FIRING',
      severity: 'CRITICAL',
      message: 'Cảnh báo giả lập Zone B',
    });

    act(() => {
      capturedListener?.(zoneBAlert);
    });

    expect(queryClient.getQueryData<PageResponse<AlertResponse>>(listKey)?.content).toEqual([]);
    expect(setQueryDataSpy).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(onNewAlert).not.toHaveBeenCalled();

    // 2. Incoming ZONE_A alert updates cache, invalidates unread-count, and fires onNewAlert
    const zoneAAlert = makeAlert({
      id: 'alert-zone-a',
      deviceId: 'dev-a',
      hardwareId: 'ESP32-A1',
      roomId: 'room-a',
      zoneId: 'ZONE_A',
      status: 'FIRING',
      severity: 'HIGH',
      message: 'Cảnh báo Zone A',
    });

    act(() => {
      capturedListener?.(zoneAAlert);
    });

    const updated = queryClient.getQueryData<PageResponse<AlertResponse>>(listKey);
    expect(updated?.content).toHaveLength(1);
    expect(updated?.content[0]?.id).toBe('alert-zone-a');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['alerts', 'unread-count'],
    });
    expect(onNewAlert).toHaveBeenCalledTimes(1);
    expect(onNewAlert).toHaveBeenCalledWith(zoneAAlert);
  });

  it('keeps STOMP subscription stable when zoneScope/onNewAlert update asynchronously via refs', () => {
    const queryClient = createTestQueryClient();
    const initialCallback = vi.fn();
    const updatedCallback = vi.fn();

    const initialScope: AlertZoneScope = {
      isAdmin: false,
      assignedZones: ['ZONE_A'],
      allowedRoomIds: new Set(),
      allowedDeviceIds: new Set(),
    };

    const { rerender } = renderHook(
      ({
        cb,
        scope,
      }: {
        cb: (alert: AlertResponse) => void;
        scope: AlertZoneScope;
      }) => useGlobalAlertStream(true, cb, scope),
      {
        initialProps: { cb: initialCallback, scope: initialScope },
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      }
    );

    expect(onAlertSpy).toHaveBeenCalledTimes(1);
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    // Before device list loads, legacy zoneId-less alert is blocked
    act(() => {
      capturedListener?.(
        makeAlert({ id: 'legacy-1', zoneId: null, deviceId: 'dev-a', roomId: 'room-a' })
      );
    });
    expect(initialCallback).not.toHaveBeenCalled();

    // Async device scope arrives -> updates refs without resubscribing STOMP
    const resolvedScope: AlertZoneScope = {
      isAdmin: false,
      assignedZones: ['ZONE_A'],
      allowedRoomIds: new Set(['room-a']),
      allowedDeviceIds: new Set(['dev-a']),
    };
    rerender({ cb: updatedCallback, scope: resolvedScope });

    expect(onAlertSpy).toHaveBeenCalledTimes(1);
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    const legacyAlert = makeAlert({
      id: 'legacy-2',
      zoneId: null,
      deviceId: 'dev-a',
      roomId: 'room-a',
    });
    act(() => {
      capturedListener?.(legacyAlert);
    });

    expect(initialCallback).not.toHaveBeenCalled();
    expect(updatedCallback).toHaveBeenCalledTimes(1);
    expect(updatedCallback).toHaveBeenCalledWith(legacyAlert);
  });

  it('fails closed when zoneScope is omitted and allows all zones when isAdmin is true', () => {
    const queryClient = createTestQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const onNewAlert = vi.fn();

    const { rerender } = renderHook(
      ({ scope }: { scope?: AlertZoneScope }) =>
        useGlobalAlertStream(true, onNewAlert, scope),
      {
        initialProps: { scope: undefined as AlertZoneScope | undefined },
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      }
    );

    act(() => {
      capturedListener?.(makeAlert({ id: 'omitted-scope', zoneId: 'ZONE_A' }));
    });
    expect(onNewAlert).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();

    rerender({ scope: { isAdmin: true, assignedZones: [] } });

    const zoneBAlert = makeAlert({ id: 'admin-zone-b', zoneId: 'ZONE_B' });
    act(() => {
      capturedListener?.(zoneBAlert);
    });
    expect(onNewAlert).toHaveBeenCalledTimes(1);
    expect(onNewAlert).toHaveBeenCalledWith(zoneBAlert);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['alerts', 'unread-count'],
    });
  });
});

describe('P0-1 Zone Isolation: AppShell Toast & Audio Chime Smoke Tests', () => {
  let capturedListener: ((alert: AlertResponse) => void) | null = null;
  let originalAudioContext: typeof window.AudioContext;
  let audioConstructedSpy: ReturnType<typeof vi.fn>;
  let oscStartSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedListener = null;
    originalAudioContext = window.AudioContext;
    audioConstructedSpy = vi.fn();
    oscStartSpy = vi.fn();

    class MockAudioContext {
      currentTime = 0;
      destination = {};
      constructor() {
        audioConstructedSpy();
      }
      createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: oscStartSpy,
          stop: vi.fn(),
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
        };
      }
    }

    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: MockAudioContext,
    });

    vi.spyOn(stompManager, 'onAlert').mockImplementation((listener) => {
      capturedListener = listener;
      return vi.fn();
    });
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: originalAudioContext,
    });
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
      capabilities: buildCapabilities(parseScopeString('')),
      hydrated: false,
      isKioskSession: false,
    });
    vi.restoreAllMocks();
  });

  it('triggers toast and audio chime ONLY for ZONE_A alerts and never for ZONE_B alerts for LIBRARIAN', async () => {
    const queryClient = createTestQueryClient();
    const librarianUser = makeUser({
      username: 'lib_zone_a',
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_A'],
    });

    useAuthStore.setState({
      accessToken: 'token-lib',
      refreshToken: 'refresh-lib',
      user: librarianUser,
      capabilities: buildCapabilities(parseScopeString('ROLE_LIBRARIAN')),
      hydrated: true,
      isKioskSession: false,
    });

    vi.spyOn(authApi, 'getMyInfo').mockResolvedValue(librarianUser);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(1);
    const devicesListSpy = vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [
        makeDevice({ id: 'dev-a', zoneId: 'ZONE_A', roomId: 'room-a' }),
        makeDevice({ id: 'dev-b', zoneId: 'ZONE_B', roomId: 'room-b' }),
      ],
      page: 0,
      size: 100,
      totalElements: 2,
      totalPages: 1,
      last: true,
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AppShell>
            <div>Dashboard Content</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(devicesListSpy).toHaveBeenCalledWith({ page: 0, size: 100 });
    });

    // Unlock Web Audio inside ToastProvider
    fireEvent.pointerDown(window);
    expect(capturedListener).not.toBeNull();

    // 1. Emit ZONE_B CRITICAL FIRING alert -> must NOT render toast or play chime
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'b-crit',
          deviceId: 'dev-b',
          roomId: 'room-b',
          zoneId: 'ZONE_B',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'Cảnh báo Zone B không được phép hiển thị',
        })
      );
    });

    expect(
      screen.queryByText('Cảnh báo Zone B không được phép hiển thị')
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(audioConstructedSpy).not.toHaveBeenCalled();
    expect(oscStartSpy).not.toHaveBeenCalled();

    // 2. Emit legacy zoneId: null alert for ZONE_B device -> also blocked
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'b-legacy',
          deviceId: 'dev-b',
          roomId: 'room-b',
          zoneId: null,
          severity: 'HIGH',
          status: 'FIRING',
          message: 'Cảnh báo legacy Zone B',
        })
      );
    });

    expect(screen.queryByText('Cảnh báo legacy Zone B')).not.toBeInTheDocument();
    expect(audioConstructedSpy).not.toHaveBeenCalled();

    // 3. Emit ZONE_A CRITICAL FIRING alert -> renders toast and plays chime
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'a-crit',
          deviceId: 'dev-a',
          roomId: 'room-a',
          zoneId: 'ZONE_A',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'Cảnh báo Zone A khẩn cấp',
        })
      );
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Cảnh báo khẩn cấp')).toBeInTheDocument();
    expect(screen.getByText('Cảnh báo Zone A khẩn cấp')).toBeInTheDocument();
    expect(audioConstructedSpy).toHaveBeenCalledTimes(1);
    expect(oscStartSpy).toHaveBeenCalledTimes(1);

    // 4. Emit legacy zoneId: null alert for ZONE_A device -> allowed via scoped device fallback
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'a-legacy',
          deviceId: 'dev-a',
          roomId: 'room-a',
          zoneId: null,
          severity: 'MEDIUM',
          status: 'FIRING',
          message: 'Cảnh báo legacy Zone A hợp lệ',
        })
      );
    });
    expect(screen.getByText('Cảnh báo legacy Zone A hợp lệ')).toBeInTheDocument();
  });

  it('skips /devices query for VIEWER (preventing 403) while still isolating ZONE_A vs ZONE_B toasts', async () => {
    const queryClient = createTestQueryClient();
    const viewerUser = makeUser({
      username: 'viewer_zone_a',
      roles: [{ name: 'VIEWER', description: 'Viewer', permissions: [] }],
      assignedZones: ['ZONE_A'],
    });

    useAuthStore.setState({
      accessToken: 'token-viewer',
      refreshToken: 'refresh-viewer',
      user: viewerUser,
      capabilities: buildCapabilities(parseScopeString('ROLE_VIEWER')),
      hydrated: true,
      isKioskSession: false,
    });

    vi.spyOn(authApi, 'getMyInfo').mockResolvedValue(viewerUser);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(0);
    const devicesListSpy = vi.spyOn(devicesApi, 'list');

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AppShell>
            <div>Viewer Content</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Viewer Content')).toBeInTheDocument();
    });

    expect(devicesListSpy).not.toHaveBeenCalled();

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'viewer-zone-b',
          zoneId: 'ZONE_B',
          status: 'FIRING',
          message: 'Viewer Zone B bị chặn',
        })
      );
    });
    expect(screen.queryByText('Viewer Zone B bị chặn')).not.toBeInTheDocument();

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'viewer-zone-a',
          zoneId: 'ZONE_A',
          status: 'FIRING',
          message: 'Viewer Zone A hợp lệ',
        })
      );
    });
    expect(screen.getByText('Viewer Zone A hợp lệ')).toBeInTheDocument();
  });

  it('fails closed before myInfo loads and skips /devices for custom VIEW_ALERTS-only role', async () => {
    const queryClient = createTestQueryClient();
    let resolveMyInfo!: (user: UserResponse) => void;
    const myInfoPromise = new Promise<UserResponse>((resolve) => {
      resolveMyInfo = resolve;
    });

    useAuthStore.setState({
      accessToken: 'token-custom',
      refreshToken: 'refresh-custom',
      user: null,
      capabilities: buildCapabilities(parseScopeString('VIEW_ALERTS')),
      hydrated: true,
      isKioskSession: false,
    });

    vi.spyOn(authApi, 'getMyInfo').mockReturnValue(myInfoPromise);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(0);
    const devicesListSpy = vi.spyOn(devicesApi, 'list');

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AppShell>
            <div>Custom Role Content</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    expect(screen.getByText('Custom Role Content')).toBeInTheDocument();

    // Before myInfo loads, even ZONE_A alerts fail closed
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'pre-hydrate-a',
          zoneId: 'ZONE_A',
          status: 'FIRING',
          message: 'Cảnh báo trước khi tải myInfo',
        })
      );
    });
    expect(
      screen.queryByText('Cảnh báo trước khi tải myInfo')
    ).not.toBeInTheDocument();

    // Resolve myInfo with assignedZones: ['ZONE_A'] and wait for React Query + effects to flush
    resolveMyInfo(
      makeUser({
        username: 'custom_alert_user',
        roles: [{ name: 'CUSTOM_MONITOR', description: 'Custom', permissions: [] }],
        assignedZones: ['ZONE_A'],
      })
    );

    await waitFor(() => {
      expect(screen.getByText('custom_alert_user')).toBeInTheDocument();
      expect(screen.getByText('Phân vùng: ZONE_A')).toBeInTheDocument();
    });

    expect(devicesListSpy).not.toHaveBeenCalled();

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'post-hydrate-b',
          zoneId: 'ZONE_B',
          status: 'FIRING',
          message: 'Custom Role Zone B bị chặn',
        })
      );
    });
    expect(
      screen.queryByText('Custom Role Zone B bị chặn')
    ).not.toBeInTheDocument();

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'post-hydrate-a',
          zoneId: 'ZONE_A',
          status: 'FIRING',
          message: 'Custom Role Zone A hợp lệ',
        })
      );
    });
    expect(screen.getByText('Custom Role Zone A hợp lệ')).toBeInTheDocument();
  });

  it('skips /devices query for ADMIN and delivers alerts from all zones', async () => {
    const queryClient = createTestQueryClient();
    const adminUser = makeUser({
      username: 'sysadmin',
      roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
      assignedZones: [],
    });

    useAuthStore.setState({
      accessToken: 'token-admin',
      refreshToken: 'refresh-admin',
      user: adminUser,
      capabilities: buildCapabilities(parseScopeString('ROLE_ADMIN')),
      hydrated: true,
      isKioskSession: false,
    });

    vi.spyOn(authApi, 'getMyInfo').mockResolvedValue(adminUser);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(2);
    const devicesListSpy = vi.spyOn(devicesApi, 'list');

    render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AppShell>
            <div>Admin Content</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Admin Content')).toBeInTheDocument();
    });

    expect(devicesListSpy).not.toHaveBeenCalled();

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'admin-zone-b',
          zoneId: 'ZONE_B',
          status: 'FIRING',
          severity: 'CRITICAL',
          message: 'Admin nhận cảnh báo Zone B',
        })
      );
    });

    expect(screen.getByText('Admin nhận cảnh báo Zone B')).toBeInTheDocument();
  });
});

function makeJwt(sub: string, scope: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url'
  );
  const payload = Buffer.from(JSON.stringify({ sub, scope })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function createSharedProvidersQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10000,
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
}

describe('P0-1 Zone Isolation: AppShell Cross-Session & Multi-Tab Security (REPRO-1/2/3)', () => {
  let capturedListener: ((alert: AlertResponse) => void) | null = null;
  let originalAudioContext: typeof window.AudioContext;
  let audioConstructedSpy: ReturnType<typeof vi.fn>;
  let oscStartSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedListener = null;
    originalAudioContext = window.AudioContext;
    audioConstructedSpy = vi.fn();
    oscStartSpy = vi.fn();

    class MockAudioContext {
      currentTime = 0;
      destination = {};
      constructor() {
        audioConstructedSpy();
      }
      createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: oscStartSpy,
          stop: vi.fn(),
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
        };
      }
    }

    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: MockAudioContext,
    });

    vi.spyOn(stompManager, 'onAlert').mockImplementation((listener) => {
      capturedListener = listener;
      return vi.fn();
    });
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'activate').mockImplementation(() => {});
    vi.spyOn(stompManager, 'deactivate').mockImplementation(() => {});
  });

  afterEach(async () => {
    cleanup();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    window.sessionStorage.clear();
    window.localStorage.clear();
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: originalAudioContext,
    });
    useAuthStore.setState({
      accessToken: null,
      refreshToken: null,
      user: null,
      capabilities: buildCapabilities(parseScopeString('')),
      hydrated: false,
      isKioskSession: false,
    });
    vi.restoreAllMocks();
  });

  it('REPRO-1 (Shared AppProviders QueryClient, staleTime=10000): ADMIN logout -> LIBRARIAN(ZONE_A) login does not escalate privileges or leak ZONE_B', async () => {
    const sharedQc = createSharedProvidersQueryClient();
    const adminJwt = makeJwt('admin_user', 'ROLE_ADMIN');
    const libAJwt = makeJwt('librarian_a', 'ROLE_LIBRARIAN VIEW_ALERTS');

    const adminUser = makeUser({
      id: 'u-admin',
      username: 'admin_user',
      roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
      assignedZones: [],
    });
    const libAUser = makeUser({
      id: 'u-lib-a',
      username: 'librarian_a',
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_A'],
    });

    const getMyInfoSpy = vi
      .spyOn(authApi, 'getMyInfo')
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce(libAUser);
    vi.spyOn(alertsApi, 'getUnreadCount')
      .mockResolvedValueOnce(99)
      .mockResolvedValueOnce(1);
    const devicesListSpy = vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [makeDevice({ id: 'dev-a', zoneId: 'ZONE_A', roomId: 'room-a' })],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });

    useAuthStore.getState().setTokens(adminJwt, 'ref-admin', false);

    const firstRender = render(
      <QueryClientProvider client={sharedQc}>
        <ToastProvider>
          <AppShell>
            <div>Admin View</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('admin_user')).toBeInTheDocument();
    });
    expect(devicesListSpy).not.toHaveBeenCalled();

    // Unmount before clearSession to also cover worst-case residual QueryClient cache within staleTime=10000
    firstRender.unmount();
    useAuthStore.getState().clearSession();
    useAuthStore.getState().setTokens(libAJwt, 'ref-lib-a', false);

    render(
      <QueryClientProvider client={sharedQc}>
        <ToastProvider>
          <AppShell>
            <div>Librarian View</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    fireEvent.pointerDown(window);

    // Must never display stale admin_user or stale unread count 99
    expect(screen.queryByText('admin_user')).not.toBeInTheDocument();
    expect(screen.queryByText('99')).not.toBeInTheDocument();

    // Emit ZONE_B alert immediately before/during refetch -> must fail closed
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'repro1-b-early',
          deviceId: 'dev-b',
          roomId: 'room-b',
          zoneId: 'ZONE_B',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REPRO1_ZONE_B_LEAKED_EARLY',
        })
      );
    });
    expect(
      screen.queryByText('REPRO1_ZONE_B_LEAKED_EARLY')
    ).not.toBeInTheDocument();
    expect(audioConstructedSpy).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByText('librarian_a')).toBeInTheDocument();
      expect(screen.getByText('Phân vùng: ZONE_A')).toBeInTheDocument();
    });
    expect(getMyInfoSpy).toHaveBeenCalledTimes(2);
    expect(devicesListSpy).toHaveBeenCalledTimes(1);

    // After librarian_a loads, ZONE_B must remain blocked and ZONE_A must deliver
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'repro1-b-post',
          deviceId: 'dev-b',
          roomId: 'room-b',
          zoneId: 'ZONE_B',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REPRO1_ZONE_B_LEAKED',
        })
      );
    });
    expect(screen.queryByText('REPRO1_ZONE_B_LEAKED')).not.toBeInTheDocument();
    expect(audioConstructedSpy).not.toHaveBeenCalled();
    expect(oscStartSpy).not.toHaveBeenCalled();

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'repro1-a-post',
          deviceId: 'dev-a',
          roomId: 'room-a',
          zoneId: 'ZONE_A',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REPRO1_ZONE_A_ALLOWED',
        })
      );
    });
    expect(screen.getByText('REPRO1_ZONE_A_ALLOWED')).toBeInTheDocument();
    expect(audioConstructedSpy).toHaveBeenCalledTimes(1);
    expect(oscStartSpy).toHaveBeenCalledTimes(1);
  });

  it('REPRO-2 (Shared QueryClient, staleTime=0): LIBRARIAN(ZONE_B) logout -> LIBRARIAN(ZONE_A) login fails closed while getMyInfo is pending', async () => {
    const sharedQc = createTestQueryClient();
    const libBJwt = makeJwt('librarian_b', 'ROLE_LIBRARIAN VIEW_ALERTS');
    const libAJwt = makeJwt('librarian_a', 'ROLE_LIBRARIAN VIEW_ALERTS');

    const libBUser = makeUser({
      id: 'u-lib-b',
      username: 'librarian_b',
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_B'],
    });
    const libAUser = makeUser({
      id: 'u-lib-a',
      username: 'librarian_a',
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_A'],
    });

    let resolveLibA!: (user: UserResponse) => void;
    const pendingLibAPromise = new Promise<UserResponse>((resolve) => {
      resolveLibA = resolve;
    });

    const getMyInfoSpy = vi
      .spyOn(authApi, 'getMyInfo')
      .mockResolvedValueOnce(libBUser)
      .mockReturnValueOnce(pendingLibAPromise);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(0);
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [
        makeDevice({ id: 'dev-a', zoneId: 'ZONE_A', roomId: 'room-a' }),
        makeDevice({ id: 'dev-b', zoneId: 'ZONE_B', roomId: 'room-b' }),
      ],
      page: 0,
      size: 100,
      totalElements: 2,
      totalPages: 1,
      last: true,
    });

    useAuthStore.getState().setTokens(libBJwt, 'ref-lib-b', false);

    const firstRender = render(
      <QueryClientProvider client={sharedQc}>
        <ToastProvider>
          <AppShell>
            <div>Lib B View</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('librarian_b')).toBeInTheDocument();
      expect(screen.getByText('Phân vùng: ZONE_B')).toBeInTheDocument();
    });

    // Unmount before clearSession to preserve stale librarian_b in sharedQc during refetch
    firstRender.unmount();
    useAuthStore.getState().clearSession();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    useAuthStore.getState().setTokens(libAJwt, 'ref-lib-a', false);

    render(
      <QueryClientProvider client={sharedQc}>
        <ToastProvider>
          <AppShell>
            <div>Lib A View</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    fireEvent.pointerDown(window);

    expect(screen.queryByText('librarian_b')).not.toBeInTheDocument();
    expect(screen.queryByText('Phân vùng: ZONE_B')).not.toBeInTheDocument();

    // While librarian_a's getMyInfo is pending, BOTH ZONE_B and ZONE_A fail closed
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'repro2-b-pending',
          deviceId: 'dev-b',
          roomId: 'room-b',
          zoneId: 'ZONE_B',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REPRO2_ZONE_B_LEAKED_DURING_FETCH',
        })
      );
      capturedListener?.(
        makeAlert({
          id: 'repro2-a-pending',
          deviceId: 'dev-a',
          roomId: 'room-a',
          zoneId: 'ZONE_A',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REPRO2_ZONE_A_PREMATURE',
        })
      );
    });

    expect(
      screen.queryByText('REPRO2_ZONE_B_LEAKED_DURING_FETCH')
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('REPRO2_ZONE_A_PREMATURE')
    ).not.toBeInTheDocument();
    expect(audioConstructedSpy).not.toHaveBeenCalled();

    // Resolve librarian_a -> only ZONE_A allowed, single refetch preserved
    resolveLibA(libAUser);
    await waitFor(() => {
      expect(screen.getByText('librarian_a')).toBeInTheDocument();
      expect(screen.getByText('Phân vùng: ZONE_A')).toBeInTheDocument();
    });
    expect(getMyInfoSpy).toHaveBeenCalledTimes(2);

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'repro2-b-after',
          deviceId: 'dev-b',
          roomId: 'room-b',
          zoneId: 'ZONE_B',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REPRO2_ZONE_B_AFTER',
        })
      );
    });
    expect(screen.queryByText('REPRO2_ZONE_B_AFTER')).not.toBeInTheDocument();
    expect(audioConstructedSpy).not.toHaveBeenCalled();

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'repro2-a-after',
          deviceId: 'dev-a',
          roomId: 'room-a',
          zoneId: 'ZONE_A',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REPRO2_ZONE_A_AFTER',
        })
      );
    });
    expect(screen.getByText('REPRO2_ZONE_A_AFTER')).toBeInTheDocument();
    expect(audioConstructedSpy).toHaveBeenCalledTimes(1);
    expect(oscStartSpy).toHaveBeenCalledTimes(1);
  });

  it('REPRO-3 (In-place setTokens / BroadcastChannel switch without unmount): ADMIN -> LIBRARIAN(ZONE_A) drops privileges immediately and evicts stale cache', async () => {
    const sharedQc = createSharedProvidersQueryClient();
    const adminJwt = makeJwt('admin_user', 'ROLE_ADMIN');
    const libAJwt = makeJwt('librarian_a', 'ROLE_LIBRARIAN VIEW_ALERTS');

    const adminUser = makeUser({
      id: 'u-admin',
      username: 'admin_user',
      roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
      assignedZones: [],
    });
    const libAUser = makeUser({
      id: 'u-lib-a',
      username: 'librarian_a',
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_A'],
    });

    let resolveLibA!: (user: UserResponse) => void;
    const pendingLibAPromise = new Promise<UserResponse>((resolve) => {
      resolveLibA = resolve;
    });

    const getMyInfoSpy = vi
      .spyOn(authApi, 'getMyInfo')
      .mockResolvedValueOnce(adminUser)
      .mockReturnValueOnce(pendingLibAPromise);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(0);
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [makeDevice({ id: 'dev-a', zoneId: 'ZONE_A', roomId: 'room-a' })],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });

    useAuthStore.getState().setTokens(adminJwt, 'ref-admin', false);

    render(
      <QueryClientProvider client={sharedQc}>
        <ToastProvider>
          <AppShell>
            <div>In-Place Switch View</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('admin_user')).toBeInTheDocument();
    });
    fireEvent.pointerDown(window);

    // Switch account in-place (simulating BroadcastChannel TOKENS_UPDATED without unmount)
    act(() => {
      useAuthStore.getState().setTokens(libAJwt, 'ref-lib-a', false);
    });

    expect(useAuthStore.getState().user).toBeNull();
    expect(screen.queryByText('admin_user')).not.toBeInTheDocument();
    expect(getMyInfoSpy).toHaveBeenCalledTimes(2);

    // Immediately after in-place switch while getMyInfo is pending, ZONE_B must be blocked
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'repro3-b-pending',
          deviceId: 'dev-b',
          roomId: 'room-b',
          zoneId: 'ZONE_B',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REPRO3_ZONE_B_LEAKED_IN_PLACE',
        })
      );
    });
    expect(
      screen.queryByText('REPRO3_ZONE_B_LEAKED_IN_PLACE')
    ).not.toBeInTheDocument();
    expect(audioConstructedSpy).not.toHaveBeenCalled();

    // After librarian_a resolves, ZONE_B remains blocked and ZONE_A delivers
    resolveLibA(libAUser);
    await waitFor(() => {
      expect(screen.getByText('librarian_a')).toBeInTheDocument();
      expect(screen.getByText('Phân vùng: ZONE_A')).toBeInTheDocument();
    });

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'repro3-b-resolved',
          deviceId: 'dev-b',
          roomId: 'room-b',
          zoneId: 'ZONE_B',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REPRO3_ZONE_B_AFTER_RESOLVE',
        })
      );
    });
    expect(
      screen.queryByText('REPRO3_ZONE_B_AFTER_RESOLVE')
    ).not.toBeInTheDocument();
    expect(audioConstructedSpy).not.toHaveBeenCalled();

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'repro3-a-resolved',
          deviceId: 'dev-a',
          roomId: 'room-a',
          zoneId: 'ZONE_A',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REPRO3_ZONE_A_ALLOWED',
        })
      );
    });
    expect(screen.getByText('REPRO3_ZONE_A_ALLOWED')).toBeInTheDocument();
    expect(audioConstructedSpy).toHaveBeenCalledTimes(1);
    expect(oscStartSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves session and caches smoothly on same-user JWT refresh', async () => {
    const sharedQc = createSharedProvidersQueryClient();
    const libAJwt1 = makeJwt('librarian_a', 'ROLE_LIBRARIAN VIEW_ALERTS');

    // Distinct token string (e.g. rotated iat/jti claim) with identical sub
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
      'base64url'
    );
    const payload2 = Buffer.from(
      JSON.stringify({
        sub: 'librarian_a',
        scope: 'ROLE_LIBRARIAN VIEW_ALERTS',
        jti: 'rotated-2',
      })
    ).toString('base64url');
    const rotatedJwt = `${header}.${payload2}.sig`;
    expect(rotatedJwt).not.toBe(libAJwt1);

    const libAUser = makeUser({
      id: 'u-lib-a',
      username: 'librarian_a',
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_A'],
    });

    const getMyInfoSpy = vi.spyOn(authApi, 'getMyInfo').mockResolvedValue(libAUser);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(1);
    const devicesListSpy = vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [makeDevice({ id: 'dev-a', zoneId: 'ZONE_A', roomId: 'room-a' })],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });

    useAuthStore.getState().setTokens(libAJwt1, 'ref-1', false);

    render(
      <QueryClientProvider client={sharedQc}>
        <ToastProvider>
          <AppShell>
            <div>Refresh Preserved View</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('librarian_a')).toBeInTheDocument();
      expect(devicesListSpy).toHaveBeenCalledTimes(1);
    });
    expect(getMyInfoSpy).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(window);

    // Rotate JWT for the SAME subject -> must NOT clear store.user or wipe myInfo/devices
    act(() => {
      useAuthStore.getState().setTokens(rotatedJwt, 'ref-2', false);
    });

    expect(useAuthStore.getState().user?.username).toBe('librarian_a');
    expect(screen.getByText('librarian_a')).toBeInTheDocument();
    expect(screen.getByText('Phân vùng: ZONE_A')).toBeInTheDocument();
    expect(getMyInfoSpy).toHaveBeenCalledTimes(1);
    expect(devicesListSpy).toHaveBeenCalledTimes(1);

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'refresh-b',
          zoneId: 'ZONE_B',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REFRESH_ZONE_B_BLOCKED',
        })
      );
      capturedListener?.(
        makeAlert({
          id: 'refresh-a',
          zoneId: 'ZONE_A',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'REFRESH_ZONE_A_ALLOWED',
        })
      );
    });

    expect(screen.queryByText('REFRESH_ZONE_B_BLOCKED')).not.toBeInTheDocument();
    expect(screen.getByText('REFRESH_ZONE_A_ALLOWED')).toBeInTheDocument();
    expect(audioConstructedSpy).toHaveBeenCalledTimes(1);
  });

  it('evicts stale user and refetches myInfo on in-place opaque non-JWT token switch', async () => {
    const sharedQc = createSharedProvidersQueryClient();
    const adminUser = makeUser({
      id: 'u-admin',
      username: 'admin_user',
      roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
      assignedZones: [],
    });
    const libAUser = makeUser({
      id: 'u-lib-a',
      username: 'librarian_a',
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_A'],
    });

    const getMyInfoSpy = vi
      .spyOn(authApi, 'getMyInfo')
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce(libAUser);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(0);
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [makeDevice({ id: 'dev-a', zoneId: 'ZONE_A', roomId: 'room-a' })],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });

    useAuthStore.setState({
      accessToken: 'opaque-admin-token',
      refreshToken: 'ref-admin',
      user: adminUser,
      capabilities: buildCapabilities(parseScopeString('ROLE_ADMIN')),
      hydrated: true,
      isKioskSession: false,
    });

    render(
      <QueryClientProvider client={sharedQc}>
        <ToastProvider>
          <AppShell>
            <div>Opaque Switch View</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('admin_user')).toBeInTheDocument();
    });

    fireEvent.pointerDown(window);

    // Switch in-place to a different opaque non-JWT token
    act(() => {
      useAuthStore.setState({
        accessToken: 'opaque-lib-token',
        refreshToken: 'ref-lib',
        capabilities: buildCapabilities(parseScopeString('ROLE_LIBRARIAN VIEW_ALERTS')),
      });
    });

    await waitFor(() => {
      expect(screen.getByText('librarian_a')).toBeInTheDocument();
      expect(screen.getByText('Phân vùng: ZONE_A')).toBeInTheDocument();
    });
    expect(getMyInfoSpy).toHaveBeenCalledTimes(2);

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'opaque-b',
          zoneId: 'ZONE_B',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'OPAQUE_ZONE_B_BLOCKED',
        })
      );
      capturedListener?.(
        makeAlert({
          id: 'opaque-a',
          zoneId: 'ZONE_A',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'OPAQUE_ZONE_A_ALLOWED',
        })
      );
    });

    expect(screen.queryByText('OPAQUE_ZONE_B_BLOCKED')).not.toBeInTheDocument();
    expect(screen.getByText('OPAQUE_ZONE_A_ALLOWED')).toBeInTheDocument();
    expect(audioConstructedSpy).toHaveBeenCalledTimes(1);
  });

  it('evicts myInfo, alerts, and devices caches when clearSession runs before unmount (standard SPA logout flow)', async () => {
    const sharedQc = createSharedProvidersQueryClient();
    const adminJwt = makeJwt('admin_user', 'ROLE_ADMIN');
    const libAJwt = makeJwt('librarian_a', 'ROLE_LIBRARIAN VIEW_ALERTS');

    const adminUser = makeUser({
      id: 'u-admin',
      username: 'admin_user',
      roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
      assignedZones: [],
    });
    const libAUser = makeUser({
      id: 'u-lib-a',
      username: 'librarian_a',
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_A'],
    });

    vi.spyOn(authApi, 'getMyInfo')
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce(libAUser);
    vi.spyOn(alertsApi, 'getUnreadCount')
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(1);
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [makeDevice({ id: 'dev-a', zoneId: 'ZONE_A', roomId: 'room-a' })],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });

    sharedQc.setQueryData(['alerts', 'list', { page: 0, size: 20 }], {
      content: [makeAlert({ id: 'stale-b', zoneId: 'ZONE_B' })],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    sharedQc.setQueryData(['devices', 'list', { page: 0, size: 100 }], {
      content: [makeDevice({ id: 'dev-b', zoneId: 'ZONE_B', roomId: 'room-b' })],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });

    useAuthStore.getState().setTokens(adminJwt, 'ref-admin', false);

    const view = render(
      <QueryClientProvider client={sharedQc}>
        <ToastProvider>
          <AppShell>
            <div>Logout Flow View</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('admin_user')).toBeInTheDocument();
    });

    // Standard SPA logout: clearSession() then unmount (e.g. router.replace('/login'))
    act(() => {
      useAuthStore.getState().clearSession();
    });
    view.unmount();

    expect(sharedQc.getQueryData(['auth', 'myInfo'])).toBeUndefined();
    expect(sharedQc.getQueryData(['alerts', 'list', { page: 0, size: 20 }])).toBeUndefined();
    expect(sharedQc.getQueryData(['alerts', 'unread-count'])).toBeUndefined();
    expect(sharedQc.getQueryData(['devices', 'list', { page: 0, size: 100 }])).toBeUndefined();

    // Subsequent login as LIBRARIAN(ZONE_A) starts clean and blocks ZONE_B
    useAuthStore.getState().setTokens(libAJwt, 'ref-lib-a', false);
    render(
      <QueryClientProvider client={sharedQc}>
        <ToastProvider>
          <AppShell>
            <div>Next User View</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('librarian_a')).toBeInTheDocument();
    });

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'logout-flow-b',
          zoneId: 'ZONE_B',
          severity: 'CRITICAL',
          status: 'FIRING',
          message: 'LOGOUT_FLOW_ZONE_B_BLOCKED',
        })
      );
    });
    expect(screen.queryByText('LOGOUT_FLOW_ZONE_B_BLOCKED')).not.toBeInTheDocument();
    expect(audioConstructedSpy).not.toHaveBeenCalled();
  });
});

