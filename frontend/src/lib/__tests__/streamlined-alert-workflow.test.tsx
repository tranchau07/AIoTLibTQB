import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AlertsCenterPage from '@/app/(protected)/alerts/page';
import AdminRoomsPage from '@/app/(protected)/admin/rooms/page';
import AdminUsersPage from '@/app/(protected)/admin/users/page';
import { AppShell } from '@/components/layout/AppShell';
import { ToastProvider } from '@/components/ui/primitives';
import { alertsApi } from '@/features/alerts/api';
import { authApi } from '@/features/auth/api';
import { useAuthStore } from '@/features/auth/store';
import { devicesApi } from '@/features/devices/api';
import { iamApi } from '@/features/iam/api';
import { roomsApi } from '@/features/rooms/api';
import { buildCapabilities } from '@/lib/rbac/capabilities';
import { parseScopeString } from '@/lib/rbac/scope-parser';
import { stompManager } from '@/lib/realtime/stomp-client';
import type { AlertResponse, RoomResponse, UserResponse } from '@/types/api';

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
    id: 'alert-room-301',
    deviceId: 'dev-nw',
    hardwareId: 'ESP32_301_NW',
    roomId: 'room-301',
    zoneId: 'ZONE_A',
    type: 'NOISE_EXCEEDED',
    metricType: 'NOISE_AVG',
    unit: 'dBA',
    severity: 'HIGH',
    severityRank: 3,
    status: 'FIRING',
    workflowStatus: 'NEW',
    currentValue: 73.2,
    threshold: 65.0,
    message: 'Average noise level (73.2 dBA) exceeded threshold (65.0 dBA)',
    recommendedAction: 'SOP Tiếng ồn',
    startedAt: '2026-11-24T08:00:00Z',
    acknowledgedAt: null,
    resolvedAt: null,
    acknowledgedBy: null,
    resolvedBy: null,
    ...overrides,
  };
}

describe('Quy trình Cảnh báo Tinh gọn 2 Tầng & Quản trị Vận hành TQB', () => {
  const originalAudioContext = window.AudioContext;
  let oscStartSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    routerPushSpy.mockClear();
    oscStartSpy = vi.fn();

    class MockAudioContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      resume = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
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
  });

  afterEach(() => {
    cleanup();
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

  it('cho phép ZONE_MANAGER thực hiện 2-Tap (Nhận xử lý + Đã nhắc xong bằng Quick-Tag) ngay trên /alerts và hiển thị cụm N cảm biến + Đã êm — Chờ xác nhận', async () => {
    vi.spyOn(stompManager, 'isConnected').mockReturnValue(true);
    vi.spyOn(stompManager, 'onConnectionChange').mockImplementation((cb) => {
      cb(true);
      return vi.fn();
    });
    vi.spyOn(stompManager, 'onAlert').mockImplementation(() => vi.fn());

    const groupedAlert = makeAlert({
      id: 'alert-grouped-301',
      status: 'ACKNOWLEDGED',
      workflowStatus: 'IN_PROGRESS',
      assignedTo: 'zm_zone_a',
      sensorRecovered: true,
      sensorRecoveredAt: '2026-11-24T08:04:00Z',
      affectedNodes: [
        {
          deviceId: 'dev-nw',
          hardwareId: 'ESP32_301_NW',
          metricType: 'NOISE_AVG',
          currentValue: 61.0,
          threshold: 65.0,
        },
        {
          deviceId: 'dev-ne',
          hardwareId: 'ESP32_301_NE',
          metricType: 'NOISE_AVG',
          currentValue: 60.5,
          threshold: 65.0,
        },
        {
          deviceId: 'dev-se',
          hardwareId: 'ESP32_301_SE',
          metricType: 'NOISE_AVG',
          currentValue: 59.8,
          threshold: 65.0,
        },
      ],
    });

    vi.spyOn(alertsApi, 'list').mockResolvedValue({
      content: [groupedAlert],
      page: 0,
      size: 10,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(0);
    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [
        {
          id: 'room-301',
          code: 'TQB_301',
          name: 'Phòng đọc Multimedia 301',
          floor: 3,
          type: 'STUDY_ROOM',
        },
      ],
      page: 0,
      size: 100,
      totalElements: 1,
      totalPages: 1,
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

    const workflowSpy = vi.spyOn(alertsApi, 'updateWorkflow').mockResolvedValue({
      ...groupedAlert,
      status: 'RESOLVED',
      workflowStatus: 'RESOLVED',
      resolutionTag: 'MOVED_GROUP_F5',
      handlingNote:
        'Đã hướng dẫn nhóm sinh viên có nhu cầu thảo luận chuyển lên phòng nhóm Tầng 5.',
    });

    useAuthStore.setState({
      accessToken: 'token-zm',
      refreshToken: 'refresh-zm',
      user: {
        id: 'u-zm',
        username: 'zm_zone_a',
        active: true,
        roles: [{ name: 'ZONE_MANAGER', description: 'ZM', permissions: [] }],
        assignedZones: ['ZONE_A'],
      },
      capabilities: buildCapabilities(
        parseScopeString('ZONE_MANAGER VIEW_ALERTS ACKNOWLEDGE_ALERT READ_SENSOR_DATA')
      ),
      hydrated: true,
      isKioskSession: false,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AlertsCenterPage />
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Đã êm — Chờ xác nhận')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Tâm điểm: ESP32_301_NW \(\+2 trạm lan\)/)
    ).toBeInTheDocument();

    // Khi sensorRecovered = true, khay Quick-Tag đã tự mở sẵn -> ZONE_MANAGER bấm 1 chạm đóng luôn
    const quickTagChip = await screen.findByTestId(
      'alerts-tag-alert-grouped-301-MOVED_GROUP_F5'
    );
    fireEvent.click(quickTagChip);

    await waitFor(() => {
      expect(workflowSpy).toHaveBeenCalledWith('alert-grouped-301', {
        workflowStatus: 'RESOLVED',
        resolutionTag: 'MOVED_GROUP_F5',
        handlingNote:
          'Đã hướng dẫn nhóm sinh viên có nhu cầu thảo luận chuyển lên phòng nhóm Tầng 5.',
      });
    });
    expect(routerPushSpy).not.toHaveBeenCalled();
  });

  it('phát đúng 1 tiếng chuông nhẹ (0.3s) trên AppShell khi có cảnh báo FIRING mới chưa ai nhận, không lặp lại khi nhận bản tin STOMP trùng id', async () => {
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

    const librarianUser: UserResponse = {
      id: 'u-lib',
      username: 'thuthu_t3',
      active: true,
      roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
      assignedZones: ['ZONE_A'],
    };
    vi.spyOn(authApi, 'getMyInfo').mockResolvedValue(librarianUser);
    vi.spyOn(alertsApi, 'getUnreadCount').mockResolvedValue(0);
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
      accessToken: 'token-lib',
      refreshToken: 'refresh-lib',
      user: librarianUser,
      capabilities: buildCapabilities(
        parseScopeString('LIBRARIAN VIEW_ALERTS ACKNOWLEDGE_ALERT MANAGE_ALERT_CONFIG')
      ),
      hydrated: true,
      isKioskSession: false,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AppShell>
            <div>Quầy thủ thư</div>
          </AppShell>
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Quầy thủ thư')).toBeInTheDocument();
    });

    // Mở khóa Web Audio bằng tương tác người dùng đầu ca trực
    act(() => {
      window.dispatchEvent(new Event('pointerdown'));
    });

    // Cảnh báo FIRING mới chưa ai nhận -> phát 1 tiếng chuông nhẹ
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'firing-new-1',
          status: 'FIRING',
          workflowStatus: 'NEW',
          assignedTo: null,
        })
      );
    });
    expect(oscStartSpy).toHaveBeenCalledTimes(1);

    // Bản tin STOMP cập nhật cùng alert.id (ví dụ thêm node thứ 2 vào phòng) -> KHÔNG kêu lại
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'firing-new-1',
          status: 'FIRING',
          workflowStatus: 'NEW',
          currentValue: 75.0,
        })
      );
    });
    expect(oscStartSpy).toHaveBeenCalledTimes(1);

    // Cảnh báo đã được đồng nghiệp nhận xử lý -> KHÔNG phát chuông
    act(() => {
      capturedListener?.(
        makeAlert({
          id: 'claimed-by-peer-2',
          status: 'ACKNOWLEDGED',
          workflowStatus: 'IN_PROGRESS',
          assignedTo: 'thuthu_b',
        })
      );
    });
    expect(oscStartSpy).toHaveBeenCalledTimes(1);
  });

  it('ẩn ngưỡng độ ẩm cho Phòng tự học (STUDY_ROOM), hiện cho Kho sách (BOOK_STORAGE) và gửi noisePeakImmediate trong AdminRoomsPage', async () => {
    const studyRoom: RoomResponse = {
      id: 'room-301',
      code: 'TQB_301',
      name: 'Phòng đọc 301',
      floor: 3,
      capacity: 120,
      targetComfortScore: 85,
      type: 'STUDY_ROOM',
      thresholds: {
        noiseAvgMax: 65,
        noisePeakMax: 75,
        noisePeakImmediate: 85,
        tempMax: 32,
        humidityMin: 45,
        humidityMax: 60,
        pm25Max: 50,
      },
    };

    vi.spyOn(roomsApi, 'list').mockResolvedValue({
      content: [studyRoom],
      page: 0,
      size: 10,
      totalElements: 1,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(roomsApi, 'update').mockResolvedValue(studyRoom);
    const updateThSpy = vi
      .spyOn(roomsApi, 'updateThresholds')
      .mockResolvedValue(studyRoom);

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
        parseScopeString('ADMIN MANAGE_ZONES MANAGE_ALERT_CONFIG')
      ),
      hydrated: true,
      isKioskSession: false,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AdminRoomsPage />
        </ToastProvider>
      </QueryClientProvider>
    );

    const editBtn = await screen.findByRole('button', { name: /Sửa/i });
    fireEvent.click(editBtn);

    // Với STUDY_ROOM: có ô noisePeakImmediate (85), KHÔNG hiện ô độ ẩm, có ghi chú khí hậu Hà Nội
    const immediateInput = await screen.findByTestId('th-noise-peak-immediate');
    expect(immediateInput).toHaveValue(85);
    expect(screen.getByTestId('th-humidity-study-room-note')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Độ ẩm tối đa kho sách/i)).not.toBeInTheDocument();

    // Đổi sang BOOK_STORAGE -> hiện 2 ô độ ẩm kho sách
    fireEvent.change(screen.getByLabelText('Loại không gian'), {
      target: { value: 'BOOK_STORAGE' },
    });
    expect(screen.getByLabelText(/Độ ẩm tối đa kho sách/i)).toBeInTheDocument();

    // Đổi mức ồn khẩn cấp 0s lên 88 dBA và lưu
    fireEvent.change(immediateInput, { target: { value: '88' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));

    await waitFor(() => {
      expect(updateThSpy).toHaveBeenCalledWith(
        'room-301',
        expect.objectContaining({
          noisePeakImmediate: 88,
          humidityMin: 45,
          humidityMax: 60,
        })
      );
    });
  });

  it('cảnh báo rõ "Chưa gán Zone (0 cảnh báo)" cho tài khoản không phải Admin bị trống assignedZones trên AdminUsersPage và hỗ trợ chọn nhanh chip Zone', async () => {
    vi.spyOn(iamApi, 'listUsers').mockResolvedValue({
      content: [
        {
          id: 'u-admin',
          username: 'sys_admin',
          active: true,
          roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
          assignedZones: [],
        },
        {
          id: 'u-lib-no-zone',
          username: 'thuthu_quen_zone',
          active: true,
          roles: [{ name: 'LIBRARIAN', description: 'Librarian', permissions: [] }],
          assignedZones: [],
        },
      ],
      page: 0,
      size: 10,
      totalElements: 2,
      totalPages: 1,
      last: true,
    });
    vi.spyOn(iamApi, 'listRoles').mockResolvedValue([
      { name: 'ADMIN', description: 'Admin', permissions: [] },
      { name: 'LIBRARIAN', description: 'Librarian', permissions: [] },
      { name: 'ZONE_MANAGER', description: 'Zone Manager', permissions: [] },
    ]);

    useAuthStore.setState({
      accessToken: 'token-admin',
      refreshToken: 'refresh-admin',
      user: {
        id: 'u-admin',
        username: 'sys_admin',
        active: true,
        roles: [{ name: 'ADMIN', description: 'Admin', permissions: [] }],
        assignedZones: [],
      },
      capabilities: buildCapabilities(parseScopeString('ADMIN MANAGE_USERS')),
      hydrated: true,
      isKioskSession: false,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AdminUsersPage />
        </ToastProvider>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(
        screen.getByTestId('user-empty-zones-warn-thuthu_quen_zone')
      ).toHaveTextContent('Chưa gán Zone (0 cảnh báo)');
    });
    expect(screen.getByText('Toàn thư viện')).toBeInTheDocument();

    // Mở modal Thêm người dùng -> bấm chip ZONE_A và ZONE_B
    fireEvent.click(screen.getByRole('button', { name: /Thêm người dùng/i }));
    fireEvent.click(await screen.findByTestId('create-zone-chip-ZONE_A'));
    fireEvent.click(screen.getByTestId('create-zone-chip-ZONE_B'));

    expect(screen.getByLabelText(/Phân vùng quản lý/i)).toHaveValue(
      'ZONE_A, ZONE_B'
    );
  });
});
