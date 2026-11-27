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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AlertsCenterPage from '@/app/(protected)/alerts/page';
import { AppShell } from '@/components/layout/AppShell';
import {
  ALERT_AUDIO_MUTED_STORAGE_KEY,
  ToastProvider,
  appendToastWithStickyProtection,
  type ToastItem,
  useToast,
} from '@/components/ui/primitives';
import { alertsApi } from '@/features/alerts/api';
import { authApi } from '@/features/auth/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { roomsApi } from '@/features/rooms/api';
import { formatBottleneckReasonVi } from '@/lib/format/metrics';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import {
  stompManager,
  upsertRealtimeAlertList,
} from '@/lib/realtime/stomp-client';
import {
  type AlertZoneScope,
  useGlobalAlertStream,
} from '@/lib/realtime/use-room-stream';
import type { AlertResponse, PageResponse, UserResponse } from '@/types/api';

const routerPushSpy = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: routerPushSpy,
    replace: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/alerts',
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
    id: 'alert-base',
    deviceId: 'dev-1',
    hardwareId: 'ESP32-NODE-1',
    roomId: 'room-1',
    zoneId: 'ZONE_A',
    type: 'NOISE_EXCEEDED',
    metricType: 'NOISE_AVG',
    unit: 'dBA',
    severity: 'MEDIUM',
    severityRank: 2,
    status: 'FIRING',
    currentValue: 68.4,
    threshold: 65.0,
    message: 'Average noise level (68.4 dBA) exceeded threshold (65.0 dBA)',
    startedAt: '2026-11-17T06:00:00Z',
    acknowledgedAt: null,
    resolvedAt: null,
    acknowledgedBy: null,
    resolvedBy: null,
    ...overrides,
  };
}

describe('Hạng mục 8 (F4): Bảo vệ Sticky Toast (appendToastWithStickyProtection & ToastProvider)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it('Test 1 (Pure): preserves 1 CRITICAL sticky toast when 6 subsequent MEDIUM non-sticky toasts overflow queue', () => {
    let queue: ToastItem[] = [];
    queue = appendToastWithStickyProtection(queue, {
      id: 'critical-sticky-1',
      title: 'Cảnh báo khẩn cấp',
      message: 'Tiếng ồn đột biến (88.0 dBA)',
      variant: 'danger',
      sticky: true,
    });

    for (let i = 1; i <= 6; i++) {
      queue = appendToastWithStickyProtection(queue, {
        id: `medium-${i}`,
        title: 'Cảnh báo mới',
        message: `Cảnh báo thường #${i}`,
        variant: 'danger',
        sticky: false,
      });
    }

    expect(queue).toHaveLength(5);
    expect(queue.some((t) => t.id === 'critical-sticky-1')).toBe(true);
    expect(queue.map((t) => t.id)).toEqual([
      'critical-sticky-1',
      'medium-3',
      'medium-4',
      'medium-5',
      'medium-6',
    ]);
  });

  it('drops the oldest sticky toast only when every active toast slot is sticky', () => {
    let queue: ToastItem[] = [];
    for (let i = 1; i <= 6; i++) {
      queue = appendToastWithStickyProtection(queue, {
        id: `sticky-${i}`,
        title: `Sticky #${i}`,
        message: `Msg #${i}`,
        variant: 'danger',
        sticky: true,
      });
    }

    expect(queue).toHaveLength(5);
    expect(queue.map((t) => t.id)).toEqual([
      'sticky-2',
      'sticky-3',
      'sticky-4',
      'sticky-5',
      'sticky-6',
    ]);
  });

  it('Test 1 (ToastProvider DOM): keeps sticky CRITICAL toast mounted after 6 MEDIUM toasts are pushed', () => {
    vi.useFakeTimers();

    function ToastHarness() {
      const { pushToast } = useToast();
      return (
        <div>
          <button
            type="button"
            onClick={() =>
              pushToast({
                title: 'Cảnh báo khẩn cấp CRITICAL',
                message: 'Peak Critical Kept',
                variant: 'danger',
                sticky: true,
              })
            }
          >
            Push Critical
          </button>
          <button
            type="button"
            onClick={() => {
              for (let i = 1; i <= 6; i++) {
                pushToast({
                  title: 'Cảnh báo mới',
                  message: `Medium Toast ${i}`,
                  variant: 'danger',
                  sticky: false,
                });
              }
            }}
          >
            Push 6 Medium
          </button>
        </div>
      );
    }

    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>
    );

    act(() => {
      fireEvent.click(screen.getByText('Push Critical'));
      fireEvent.click(screen.getByText('Push 6 Medium'));
    });

    expect(screen.getByText('Cảnh báo khẩn cấp CRITICAL')).toBeInTheDocument();
    expect(screen.getByText('Peak Critical Kept')).toBeInTheDocument();
    expect(screen.queryByText('Medium Toast 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Medium Toast 2')).not.toBeInTheDocument();
    expect(screen.getByText('Medium Toast 6')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(5);
  });
});

describe('Hạng mục 8 (F3): Sắp xếp Realtime theo Severity, cắt maxSize & đồng bộ totalElements', () => {
  let capturedListener: ((alert: AlertResponse) => void) | null = null;

  beforeEach(() => {
    capturedListener = null;
    vi.spyOn(stompManager, 'onAlert').mockImplementation((listener) => {
      capturedListener = listener;
      return vi.fn();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Test 2 (Pure): places CRITICAL above MEDIUM and LOW below MEDIUM when sortBy="severity", respecting maxSize', () => {
    const initialMedium = makeAlert({
      id: 'med-1',
      severity: 'MEDIUM',
      severityRank: 2,
      startedAt: '2026-11-17T06:00:00Z',
    });
    const criticalAlert = makeAlert({
      id: 'crit-1',
      severity: 'CRITICAL',
      severityRank: 4,
      startedAt: '2026-11-17T06:01:00Z',
    });
    const lowNewerAlert = makeAlert({
      id: 'low-1',
      severity: 'LOW',
      severityRank: 1,
      startedAt: '2026-11-17T06:05:00Z',
    });

    const afterCritical = upsertRealtimeAlertList([initialMedium], criticalAlert, {
      sortBy: 'severity',
      direction: 'DESC',
      maxSize: 10,
    });
    expect(afterCritical.map((a) => a.id)).toEqual(['crit-1', 'med-1']);

    const afterLow = upsertRealtimeAlertList(afterCritical, lowNewerAlert, {
      sortBy: 'severity',
      direction: 'DESC',
      maxSize: 10,
    });
    expect(afterLow.map((a) => a.id)).toEqual(['crit-1', 'med-1', 'low-1']);

    // Enforce maxSize truncation
    const extraMedium = makeAlert({
      id: 'med-2',
      severity: 'MEDIUM',
      severityRank: 2,
      startedAt: '2026-11-17T06:04:00Z',
    });
    const capped = upsertRealtimeAlertList(afterLow, extraMedium, {
      sortBy: 'severity',
      direction: 'DESC',
      maxSize: 3,
    });
    expect(capped).toHaveLength(3);
    expect(capped.map((a) => a.id)).toEqual(['crit-1', 'med-2', 'med-1']);
  });

  it('Test 2 (useGlobalAlertStream): re-sorts cached page by severity, caps to page size, and updates totalElements/totalPages/last', () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const listKey = [
      'alerts',
      'list',
      {
        status: 'FIRING',
        sortBy: 'severity' as const,
        direction: 'DESC' as const,
        page: 0,
        size: 3,
      },
    ] as const;

    const initialMedium = makeAlert({
      id: 'med-1',
      severity: 'MEDIUM',
      severityRank: 2,
      status: 'FIRING',
      startedAt: '2026-11-17T06:00:00Z',
    });

    qc.setQueryData<PageResponse<AlertResponse>>(listKey, {
      content: [initialMedium],
      page: 0,
      size: 3,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });

    const adminScope: AlertZoneScope = { isAdmin: true, assignedZones: [] };
    renderHook(() => useGlobalAlertStream(true, undefined, adminScope), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });

    // 1. Incoming CRITICAL moves to top and increments totalElements 1 -> 2
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'crit-1',
          severity: 'CRITICAL',
          severityRank: 4,
          status: 'FIRING',
          startedAt: '2026-11-17T06:01:00Z',
        })
      );
    });

    let cached = qc.getQueryData<PageResponse<AlertResponse>>(listKey);
    expect(cached?.content.map((a) => a.id)).toEqual(['crit-1', 'med-1']);
    expect(cached?.totalElements).toBe(2);
    expect(cached?.totalPages).toBe(1);
    expect(cached?.last).toBe(true);

    // 2. Incoming LOW settles below MEDIUM and increments totalElements 2 -> 3
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'low-1',
          severity: 'LOW',
          severityRank: 1,
          status: 'FIRING',
          startedAt: '2026-11-17T06:02:00Z',
        })
      );
    });

    cached = qc.getQueryData<PageResponse<AlertResponse>>(listKey);
    expect(cached?.content.map((a) => a.id)).toEqual(['crit-1', 'med-1', 'low-1']);
    expect(cached?.totalElements).toBe(3);

    // 3. Updating existing record keeps totalElements unchanged (3)
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'med-1',
          severity: 'MEDIUM',
          severityRank: 2,
          status: 'FIRING',
          currentValue: 69.9,
          startedAt: '2026-11-17T06:00:00Z',
        })
      );
    });
    cached = qc.getQueryData<PageResponse<AlertResponse>>(listKey);
    expect(cached?.totalElements).toBe(3);
    expect(cached?.content.find((a) => a.id === 'med-1')?.currentValue).toBe(69.9);

    // 4. Fourth HIGH alert overflows size=3 page -> truncated to top 3, totalElements=4, totalPages=2, last=false
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'high-1',
          severity: 'HIGH',
          severityRank: 3,
          status: 'FIRING',
          startedAt: '2026-11-17T06:03:00Z',
        })
      );
    });
    cached = qc.getQueryData<PageResponse<AlertResponse>>(listKey);
    expect(cached?.content.map((a) => a.id)).toEqual(['crit-1', 'high-1', 'med-1']);
    expect(cached?.totalElements).toBe(4);
    expect(cached?.totalPages).toBe(2);
    expect(cached?.last).toBe(false);

    // 5. Evicting RESOLVED alert not present in active page content leaves totalElements=4 untouched,
    //    whereas resolving crit-1 (present in FIRING list) decrements totalElements 4 -> 3
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'never-in-page',
          status: 'RESOLVED',
        })
      );
    });
    expect(qc.getQueryData<PageResponse<AlertResponse>>(listKey)?.totalElements).toBe(4);

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'crit-1',
          severity: 'CRITICAL',
          severityRank: 4,
          status: 'RESOLVED',
          startedAt: '2026-11-17T06:01:00Z',
        })
      );
    });
    cached = qc.getQueryData<PageResponse<AlertResponse>>(listKey);
    expect(cached?.content.map((a) => a.id)).toEqual(['high-1', 'med-1']);
    expect(cached?.totalElements).toBe(3);
    expect(cached?.totalPages).toBe(1);
    expect(cached?.last).toBe(true);
  });
});

describe('Hạng mục 8 (F5): AudioContext Singleton & Lưu Trạng thái Tắt Chuông trong localStorage', () => {
  let originalAudioContext: typeof window.AudioContext;
  let audioConstructedSpy: ReturnType<typeof vi.fn>;
  let oscStartSpy: ReturnType<typeof vi.fn>;
  let resumeSpy: ReturnType<typeof vi.fn>;
  let closeSpy: ReturnType<typeof vi.fn>;
  let mockState: 'running' | 'suspended';

  beforeEach(() => {
    window.localStorage.clear();
    originalAudioContext = window.AudioContext;
    audioConstructedSpy = vi.fn();
    oscStartSpy = vi.fn();
    resumeSpy = vi.fn().mockResolvedValue(undefined);
    closeSpy = vi.fn().mockResolvedValue(undefined);
    mockState = 'suspended';

    class MockSingletonAudioContext {
      currentTime = 0;
      destination = {};
      get state() {
        return mockState;
      }
      constructor() {
        audioConstructedSpy();
      }
      resume = resumeSpy;
      close = closeSpy;
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
      value: MockSingletonAudioContext,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
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

  it('reuses a single AudioContext across multiple chimes, closes on unmount, and persists mute flag across reloads', async () => {
    vi.useFakeTimers();

    function AudioHarness() {
      const { pushToast, audioMuted, setAudioMuted } = useToast();
      return (
        <div>
          <span data-testid="muted-state">{String(audioMuted)}</span>
          <button
            type="button"
            onClick={() =>
              pushToast({
                title: 'Chime',
                message: 'Ping',
                variant: 'danger',
                sticky: true,
                playSound: true,
              })
            }
          >
            Trigger Chime
          </button>
          <button type="button" onClick={() => setAudioMuted(!audioMuted)}>
            Toggle Mute
          </button>
        </div>
      );
    }

    const firstRender = render(
      <ToastProvider>
        <AudioHarness />
      </ToastProvider>
    );

    expect(screen.getByTestId('muted-state').textContent).toBe('false');

    // Unlock audio via user gesture
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });

    // Trigger 3 consecutive chimes -> AudioContext constructed ONCE, oscillator started 3 times
    act(() => {
      fireEvent.click(screen.getByText('Trigger Chime'));
      mockState = 'running';
      fireEvent.click(screen.getByText('Trigger Chime'));
      fireEvent.click(screen.getByText('Trigger Chime'));
    });

    expect(audioConstructedSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(oscStartSpy).toHaveBeenCalledTimes(3);

    // Mute -> stored in localStorage & blocks subsequent chime playback
    act(() => {
      fireEvent.click(screen.getByText('Toggle Mute'));
    });
    expect(screen.getByTestId('muted-state').textContent).toBe('true');
    expect(window.localStorage.getItem(ALERT_AUDIO_MUTED_STORAGE_KEY)).toBe('true');

    act(() => {
      fireEvent.click(screen.getByText('Trigger Chime'));
    });
    expect(oscStartSpy).toHaveBeenCalledTimes(3);

    // Unmount closes held AudioContext cleanly
    firstRender.unmount();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // Simulate reload (F5) by mounting fresh ToastProvider -> restores muted=true from localStorage
    audioConstructedSpy.mockClear();
    render(
      <ToastProvider>
        <AudioHarness />
      </ToastProvider>
    );

    expect(screen.getByTestId('muted-state').textContent).toBe('true');

    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });
    act(() => {
      fireEvent.click(screen.getByText('Trigger Chime'));
    });

    expect(audioConstructedSpy).not.toHaveBeenCalled();
    expect(oscStartSpy).toHaveBeenCalledTimes(3);
  });

  it('restores "Đã tắt chuông" label in AlertsCenterPage after page reload when localStorage mute flag is saved', async () => {
    window.localStorage.setItem(ALERT_AUDIO_MUTED_STORAGE_KEY, 'true');

    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'onAlert').mockImplementation(() => vi.fn());
    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 10,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(0);
    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });

    useAuthStore.setState({
      accessToken: 'token-admin',
      refreshToken: 'refresh-admin',
      user: {
        id: 'u-admin',
        username: 'admin',
        active: true,
        roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
        assignedZones: [],
      },
      capabilities: buildCapabilities(
        parseScopeString('ADMIN VIEW_ALERTS VIEW_DEVICE_STATUS')
      ),
      hydrated: true,
      isKioskSession: false,
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AlertsCenterPage />
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Đã tắt chuông')).toBeInTheDocument();
    });
  });
});

describe('Hạng mục 8 (F6): Việt hóa đầy đủ thông điệp cảnh báo trên Toast & Bảng /alerts', () => {
  afterEach(async () => {
    cleanup();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    window.localStorage.clear();
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

  it('Test 3 (Unit): translates all backend English alert message templates accurately to Vietnamese', () => {
    expect(
      formatBottleneckReasonVi(
        'Average noise level (68.4 dBA) exceeded threshold (65.0 dBA)'
      )
    ).toBe('Độ ồn trung bình (68.4 dBA) vượt ngưỡng cho phép (65.0 dBA)');

    expect(
      formatBottleneckReasonVi(
        'Peak noise spike (88.0 dBA) exceeded threshold (85.0 dBA)'
      )
    ).toBe('Tiếng ồn đột biến (88.0 dBA) vượt ngưỡng cho phép (85.0 dBA)');

    expect(
      formatBottleneckReasonVi(
        'Temperature (34.2 °C) exceeded threshold (32.0 °C)'
      )
    ).toBe('Nhiệt độ (34.2 °C) vượt ngưỡng cho phép (32.0 °C)');

    expect(
      formatBottleneckReasonVi(
        'Book storage humidity (68.5 %RH) exceeded max threshold (60.0 %RH)'
      )
    ).toBe('Độ ẩm kho sách (68.5 %RH) vượt ngưỡng tối đa (60.0 %RH)');

    expect(
      formatBottleneckReasonVi(
        'Book storage humidity (40.0 %RH) dropped below min threshold (45.0 %RH)'
      )
    ).toBe('Độ ẩm kho sách (40.0 %RH) xuống dưới ngưỡng tối thiểu (45.0 %RH)');

    expect(
      formatBottleneckReasonVi(
        'PM2.5 particulate level (62.0 µg/m³) exceeded threshold (50.0 µg/m³)'
      )
    ).toBe('Nồng độ bụi mịn PM2.5 (62.0 µg/m³) vượt ngưỡng cho phép (50.0 µg/m³)');

    expect(
      formatBottleneckReasonVi('Device is offline: hardwareId=ESP32-LIB-01')
    ).toBe('Thiết bị mất kết nối (mã phần cứng: ESP32-LIB-01)');

    // Existing comfort strings remain intact & custom Vietnamese strings pass through
    expect(
      formatBottleneckReasonVi('Sub-optimal comfort index')
    ).toBe('Chỉ số tiện nghi tổng hợp dưới mức tối ưu');
    expect(
      formatBottleneckReasonVi('  Cảnh báo tùy chỉnh tiếng Việt  ')
    ).toBe('Cảnh báo tùy chỉnh tiếng Việt');
  });

  it('localizes incoming STOMP alert message inside AppShell Toast notification', async () => {
    let capturedListener: ((alert: AlertResponse) => void) | null = null;
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

    const adminUser: UserResponse = {
      id: 'u-admin',
      username: 'sysadmin',
      active: true,
      roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
      assignedZones: [],
    };
    vi.spyOn(authApi, 'getMyInfo').mockResolvedValue(adminUser);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(1);
    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 30,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });

    useAuthStore.setState({
      accessToken: 'token-admin',
      refreshToken: 'refresh-admin',
      user: adminUser,
      capabilities: buildCapabilities(parseScopeString('ROLE_ADMIN VIEW_ALERTS')),
      hydrated: true,
      isKioskSession: false,
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AppShell>
            <div>Shell Body</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Shell Body')).toBeInTheDocument();
    });

    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'stomp-peak-1',
          severity: 'CRITICAL',
          severityRank: 4,
          status: 'FIRING',
          message: 'Peak noise spike (88.0 dBA) exceeded threshold (85.0 dBA)',
        })
      );
    });

    // Không tự động nhảy popup toast ở góc dưới
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // Nhấn vào icon chuông thông báo -> hiển thị cảnh báo đã Việt hóa đầy đủ ngay tại đó
    fireEvent.click(screen.getByTestId('alert-bell-button'));
    expect(await screen.findByTestId('alert-bell-popover')).toBeInTheDocument();
    expect(
      screen.getByText('Tiếng ồn đột biến (88.0 dBA) vượt ngưỡng cho phép (85.0 dBA)')
    ).toBeInTheDocument();
  });

  it('localizes alert messages in AlertsCenterPage table rows', async () => {
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'onAlert').mockImplementation(() => vi.fn());
    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [
        makeAlert({
          id: 'row-temp',
          type: 'AIR_UNHEALTHY',
          metricType: 'TEMPERATURE',
          unit: '°C',
          message: 'Temperature (34.2 °C) exceeded threshold (32.0 °C)',
        }),
        makeAlert({
          id: 'row-offline',
          type: 'DEVICE_OFFLINE',
          metricType: 'DEVICE_OFFLINE',
          unit: null,
          message: 'Device is offline: hardwareId=ESP32-201',
        }),
      ],
      page: 0,
      size: 10,
      totalElements: 2,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(2);
    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });
    vi.spyOn(devicesApi, 'list').mockResolvedValue({
      content: [],
      page: 0,
      size: 100,
      totalElements: 0,
      totalPages: 0,
      last: true,
    });

    useAuthStore.setState({
      accessToken: 'token-admin',
      refreshToken: 'refresh-admin',
      user: {
        id: 'u-admin',
        username: 'admin',
        active: true,
        roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
        assignedZones: [],
      },
      capabilities: buildCapabilities(
        parseScopeString('ADMIN VIEW_ALERTS VIEW_DEVICE_STATUS')
      ),
      hydrated: true,
      isKioskSession: false,
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AlertsCenterPage />
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(
        screen.getByText('Nhiệt độ (34.2 °C) vượt ngưỡng cho phép (32.0 °C)')
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText('Thiết bị mất kết nối (mã phần cứng: ESP32-201)')
    ).toBeInTheDocument();
  });
});
