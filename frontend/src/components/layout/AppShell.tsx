'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Cpu,
  KeyRound,
  LayoutDashboard,
  Map,
  Menu,
  MonitorPlay,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  ShieldAlert,
  Table2,
  UserCircle2,
  Users,
  WifiOff,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '@/features/auth/store';
import { authKeys, useMyInfoQuery } from '@/features/auth/queries';
import { AlertBellPopover } from '@/features/alerts/components/AlertBellPopover';
import { useUnreadAlertsCountQuery } from '@/features/alerts/queries';
import { useDevicesQuery } from '@/features/devices/queries';
import { decodeJwtScope } from '@/lib/rbac/scope-parser';
import { upsertRealtimeAlertList } from '@/lib/realtime/stomp-client';
import {
  type AlertZoneScope,
  useGlobalAlertStream,
  useStompConnectionState,
} from '@/lib/realtime/use-room-stream';
import { UI_TEXT_VI } from '@/messages/vi';
import { Skeleton, useToast } from '@/components/ui/primitives';
import type { AlertResponse, UserResponse } from '@/types/api';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  visible: boolean;
  /** Chỉ coi là active khi khớp đúng (không gồm route con). */
  exact?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'tqb_desktop_sidebar_collapsed';

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { playAlertChime } = useToast();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [realtimeAlerts, setRealtimeAlerts] = useState<AlertResponse[]>([]);
  const chimedAlertIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      if (window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true') {
        setDesktopCollapsed(true);
      }
    } catch {
      // Ignore storage access failures
    }
  }, []);

  useEffect(() => {
    const onRequestCollapse = (ev: Event) => {
      const custom = ev as CustomEvent<{ collapsed?: boolean }>;
      if (typeof custom.detail?.collapsed === 'boolean') {
        setDesktopCollapsed(custom.detail.collapsed);
      }
    };
    window.addEventListener('tqb:sidebar-collapse', onRequestCollapse);
    return () =>
      window.removeEventListener('tqb:sidebar-collapse', onRequestCollapse);
  }, []);

  const toggleDesktopSidebar = useCallback(() => {
    setDesktopCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // Ignore storage access failures
      }
      return next;
    });
  }, []);

  const hydrated = useAuthStore((s) => s.hydrated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const user = useAuthStore((s) => s.user);
  const capabilities = useAuthStore((s) => s.capabilities);
  const hydrateFromStorage = useAuthStore((s) => s.hydrateFromStorage);
  const setUser = useAuthStore((s) => s.setUser);

  const stompConnected = useStompConnectionState();

  useEffect(() => {
    const storedRefresh = hydrateFromStorage(false);
    const state = useAuthStore.getState();
    if (!state.accessToken && !storedRefresh) {
      router.replace('/login');
    }
  }, [hydrateFromStorage, router]);

  const jwtSubject = useMemo(() => {
    const sub = accessToken ? decodeJwtScope(accessToken).username : null;
    return sub && sub.trim().length > 0 ? sub : null;
  }, [accessToken]);

  const isMatchingSessionUser = useCallback(
    (candidate: UserResponse | null | undefined): candidate is UserResponse =>
      Boolean(
        accessToken &&
          candidate &&
          (!jwtSubject || candidate.username === jwtSubject)
      ),
    [accessToken, jwtSubject]
  );

  const hasSessionToken = Boolean(accessToken || refreshToken);
  const myInfoQuery = useMyInfoQuery(hasSessionToken);

  const lastNonNullSessionRef = useRef<{
    token: string | null;
    subject: string | null;
  }>({
    token: accessToken,
    subject: jwtSubject,
  });
  const evictedStaleForTokenRef = useRef<string | null>(null);
  const evictedScopeCacheForTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!accessToken) {
      evictedStaleForTokenRef.current = null;
      evictedScopeCacheForTokenRef.current = null;
      chimedAlertIdsRef.current.clear();
      setRealtimeAlerts([]);
      queryClient.removeQueries({ queryKey: ['alerts'] });
      queryClient.removeQueries({ queryKey: ['devices'] });
      return;
    }

    const prevSession = lastNonNullSessionRef.current;
    const tokenChanged = prevSession.token !== accessToken;
    const sessionSwitchedInPlace =
      tokenChanged &&
      prevSession.token !== null &&
      (prevSession.subject !== jwtSubject || !jwtSubject);
    const hasMismatchedMyInfo = Boolean(
      myInfoQuery.data && !isMatchingSessionUser(myInfoQuery.data)
    );

    lastNonNullSessionRef.current = { token: accessToken, subject: jwtSubject };

    if (user && (!isMatchingSessionUser(user) || sessionSwitchedInPlace)) {
      setUser(null);
    }

    if (
      sessionSwitchedInPlace ||
      (hasMismatchedMyInfo && evictedStaleForTokenRef.current !== accessToken)
    ) {
      chimedAlertIdsRef.current.clear();
      setRealtimeAlerts([]);
      const shouldResetMyInfo =
        sessionSwitchedInPlace || !myInfoQuery.isFetching;
      if (shouldResetMyInfo) {
        evictedStaleForTokenRef.current = accessToken;
        void queryClient.resetQueries({ queryKey: authKeys.myInfo });
      }
      if (
        sessionSwitchedInPlace ||
        evictedScopeCacheForTokenRef.current !== accessToken
      ) {
        evictedScopeCacheForTokenRef.current = accessToken;
        queryClient.removeQueries({ queryKey: ['alerts'], type: 'inactive' });
        void queryClient.resetQueries({
          queryKey: ['alerts'],
          type: 'active',
          predicate: (q) =>
            sessionSwitchedInPlace || q.state.fetchStatus !== 'fetching',
        });
        queryClient.removeQueries({ queryKey: ['devices'], type: 'inactive' });
        void queryClient.resetQueries({
          queryKey: ['devices'],
          type: 'active',
          predicate: (q) =>
            sessionSwitchedInPlace || q.state.fetchStatus !== 'fetching',
        });
      }
    }
  }, [
    accessToken,
    jwtSubject,
    isMatchingSessionUser,
    myInfoQuery.data,
    myInfoQuery.isFetching,
    user,
    setUser,
    queryClient,
  ]);

  useEffect(() => {
    if (isMatchingSessionUser(myInfoQuery.data)) {
      setUser(myInfoQuery.data);
    }
  }, [isMatchingSessionUser, myInfoQuery.data, setUser]);

  useEffect(() => {
    return () => {
      if (!useAuthStore.getState().accessToken) {
        queryClient.removeQueries({ queryKey: authKeys.myInfo });
        queryClient.removeQueries({ queryKey: ['alerts'] });
        queryClient.removeQueries({ queryKey: ['devices'] });
      }
    };
  }, [queryClient]);

  useEffect(() => {
    if (hydrated && !accessToken && !refreshToken) {
      router.replace('/login');
    }
  }, [hydrated, accessToken, refreshToken, router]);

  // Đóng menu mobile khi đổi trang
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const unreadAlertsQuery = useUnreadAlertsCountQuery(
    Boolean(accessToken && capabilities.canViewAlerts)
  );

  // Đưa thẳng vào chuông thông báo, không bật popup toast góc dưới; chỉ phát 1 tiếng chime nhẹ 0.3s khi có sự cố Tầng 2 mới
  const handleIncomingAlert = useCallback(
    (alert: AlertResponse) => {
      if (
        alert.id &&
        alert.status === 'FIRING' &&
        !alert.sensorRecovered &&
        !alert.assignedTo &&
        !chimedAlertIdsRef.current.has(alert.id)
      ) {
        chimedAlertIdsRef.current.add(alert.id);
        playAlertChime();
      } else if (alert.id && alert.status === 'RESOLVED') {
        chimedAlertIdsRef.current.delete(alert.id);
      }

      setRealtimeAlerts((prev) =>
        upsertRealtimeAlertList(prev, alert, {
          sortBy: 'severity',
          direction: 'DESC',
          maxSize: 50,
        })
      );
    },
    [playAlertChime]
  );

  const hasMismatchedMyInfo = Boolean(
    myInfoQuery.data && !isMatchingSessionUser(myInfoQuery.data)
  );
  const validatedMyInfo = isMatchingSessionUser(myInfoQuery.data)
    ? myInfoQuery.data
    : null;
  const validatedStoreUser = isMatchingSessionUser(user) ? user : null;
  const effectiveUser = validatedMyInfo ?? validatedStoreUser;
  const isAdmin = useMemo(
    () =>
      capabilities.isAdmin ||
      Boolean(
        effectiveUser?.roles?.some(
          (r) => r.name === 'ADMIN' || r.name === 'ROLE_ADMIN'
        )
      ),
    [capabilities.isAdmin, effectiveUser?.roles]
  );
  const assignedZones = effectiveUser?.assignedZones;

  const shouldLoadScopeDevices = Boolean(
    accessToken &&
      capabilities.canViewAlerts &&
      !isAdmin &&
      assignedZones &&
      assignedZones.length > 0 &&
      capabilities.canViewDevices
  );
  const scopeDevicesQuery = useDevicesQuery(
    { page: 0, size: 100 },
    shouldLoadScopeDevices
  );

  const { allowedRoomIds, allowedDeviceIds } = useMemo(() => {
    const rooms = new Set<string>();
    const devices = new Set<string>();
    if (!assignedZones || assignedZones.length === 0) {
      return { allowedRoomIds: rooms, allowedDeviceIds: devices };
    }
    const assignedZoneSet = new Set(assignedZones);
    for (const device of scopeDevicesQuery.data?.content ?? []) {
      if (device.zoneId && assignedZoneSet.has(device.zoneId)) {
        devices.add(device.id);
        if (device.roomId) {
          rooms.add(device.roomId);
        }
      }
    }
    return { allowedRoomIds: rooms, allowedDeviceIds: devices };
  }, [assignedZones, scopeDevicesQuery.data]);

  const alertZoneScope = useMemo<AlertZoneScope>(
    () => ({
      isAdmin,
      assignedZones,
      allowedRoomIds,
      allowedDeviceIds,
    }),
    [isAdmin, assignedZones, allowedRoomIds, allowedDeviceIds]
  );

  useGlobalAlertStream(
    Boolean(accessToken && capabilities.canViewAlerts),
    handleIncomingAlert,
    alertZoneScope
  );

  const navGroups: NavGroup[] = useMemo(
    () => [
      {
        label: 'Giám sát',
        items: [
          { href: '/dashboard', label: 'Tổng quan', icon: LayoutDashboard, visible: true },
          { href: '/floorplan', label: 'Bản đồ tầng', icon: Map, visible: true },
          {
            href: '/alerts',
            label: 'Cảnh báo',
            icon: ShieldAlert,
            visible: capabilities.canViewAlerts,
          },
          {
            href: '/telemetry-explorer',
            label: 'Dữ liệu cảm biến',
            icon: Table2,
            visible: capabilities.canViewRawTelemetry,
          },
        ],
      },
      {
        label: 'Vận hành',
        items: [
          {
            href: '/admin/rooms',
            label: 'Phòng đọc',
            icon: Building2,
            visible: capabilities.canManageRooms,
          },
          {
            href: '/admin/devices',
            label: 'Thiết bị',
            icon: Cpu,
            visible: capabilities.canViewDevices,
            exact: true,
          },
          {
            href: '/admin/devices/discovery',
            label: 'Thiết bị mới',
            icon: Radar,
            visible: capabilities.canManageDevices,
          },
        ],
      },
      {
        label: 'Quản trị',
        items: [
          {
            href: '/admin/users',
            label: 'Người dùng',
            icon: Users,
            visible: capabilities.canManageUsers,
          },
          {
            href: '/admin/roles',
            label: 'Vai trò & quyền',
            icon: KeyRound,
            visible: capabilities.canManageRoles,
          },
        ],
      },
      {
        label: 'Khác',
        items: [
          { href: '/kiosk', label: 'Màn hình Kiosk', icon: MonitorPlay, visible: true },
        ],
      },
    ],
    [capabilities]
  );

  const isActive = useCallback(
    (item: NavItem) => {
      if (!pathname) return false;
      if (pathname === item.href) return true;
      if (item.exact) {
        // /admin/devices/[id] vẫn thuộc "Thiết bị", nhưng /admin/devices/discovery thì không
        return (
          pathname.startsWith(`${item.href}/`) &&
          !pathname.startsWith(`${item.href}/discovery`)
        );
      }
      return pathname.startsWith(`${item.href}/`);
    },
    [pathname]
  );

  if (!hydrated || !accessToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-8">
        <div className="w-full max-w-md space-y-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    );
  }

  const unreadCount = hasMismatchedMyInfo ? 0 : unreadAlertsQuery.data ?? 0;
  const initials = (effectiveUser?.username?.[0] ?? '?').toUpperCase();

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-[13px] font-semibold text-white">
            TQB
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-semibold text-slate-900">
              {UI_TEXT_VI.appName}
            </span>
            <span className="block text-2xs text-slate-500">Thư viện Tạ Quang Bửu</span>
          </span>
        </Link>
      </div>

      <nav aria-label="Điều hướng chính" className="flex-1 overflow-y-auto px-3 pb-4 pt-2">
        {navGroups.map((group) => {
          const items = group.items.filter((i) => i.visible);
          if (items.length === 0) return null;
          return (
            <div key={group.label} className="mb-5">
              <p className="mb-1 px-2 text-2xs font-medium text-slate-400">{group.label}</p>
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const active = isActive(item);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={`group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium transition-colors ${
                          active
                            ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-200'
                            : 'text-slate-600 hover:bg-slate-200/50 hover:text-slate-900'
                        }`}
                      >
                        <Icon
                          className={`h-4 w-4 shrink-0 ${
                            active ? 'text-brand-600' : 'text-slate-400 group-hover:text-slate-600'
                          }`}
                          aria-hidden="true"
                        />
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.href === '/alerts' && unreadCount > 0 && (
                          <span className="rounded bg-red-500 px-1.5 text-2xs font-semibold tabular-nums text-white">
                            {unreadCount}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-slate-200/80 p-3">
        <Link
          href="/profile"
          className={`flex items-center gap-2.5 rounded-md p-1.5 transition-colors hover:bg-slate-200/50 ${
            pathname === '/profile' ? 'bg-white shadow-xs ring-1 ring-slate-200' : ''
          }`}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
            {initials}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px] font-medium text-slate-900">
              {effectiveUser?.username ?? 'Đang tải…'}
            </span>
            <span className="block truncate text-2xs text-slate-500">
              {effectiveUser?.assignedZones && effectiveUser.assignedZones.length > 0
                ? `Phân vùng: ${effectiveUser.assignedZones.join(', ')}`
                : 'Hồ sơ & phiên đăng nhập'}
            </span>
          </span>
          <UserCircle2 className="h-4 w-4 text-slate-400" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );

  const allItems = navGroups.flatMap((g) => g.items);
  const currentTitle =
    pathname === '/profile'
      ? 'Hồ sơ cá nhân'
      : pathname?.startsWith('/rooms/')
      ? 'Chi tiết phòng đọc'
      : pathname?.endsWith('/polygon')
      ? 'Mặt bằng phòng'
      : allItems.find((i) => isActive(i))?.label ?? '';

  return (
    <div
      data-sidebar-collapsed={desktopCollapsed ? 'true' : 'false'}
      className="flex min-h-screen bg-canvas text-slate-900"
    >
      {/* Sidebar desktop */}
      <aside
        aria-label="Thanh điều hướng bên trái"
        aria-hidden={desktopCollapsed}
        data-testid="desktop-sidebar"
        data-collapsed={desktopCollapsed ? 'true' : 'false'}
        className={`sticky top-0 hidden h-screen shrink-0 overflow-hidden bg-slate-50 transition-[width,opacity] duration-200 ease-in-out lg:block ${
          desktopCollapsed
            ? 'invisible pointer-events-none w-0 border-r-0 opacity-0'
            : 'visible w-60 border-r border-slate-200/80 opacity-100'
        }`}
      >
        <div className="h-full w-60">{sidebar}</div>
      </aside>

      {/* Sidebar mobile */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-slate-900/30"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-slate-200 bg-slate-50 shadow-xl">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="btn-icon absolute right-2 top-3"
              aria-label="Đóng menu"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={`sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-slate-200/80 bg-white/80 px-4 backdrop-blur transition-[padding] duration-200 ${
            pathname?.startsWith('/floorplan')
              ? 'h-11 lg:px-3'
              : desktopCollapsed
                ? 'h-14 lg:px-4'
                : 'h-14 lg:px-8'
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="btn-icon lg:hidden"
              aria-label="Mở menu"
            >
              <Menu className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={toggleDesktopSidebar}
              data-testid="desktop-sidebar-toggle"
              aria-expanded={!desktopCollapsed}
              aria-label={
                desktopCollapsed ? 'Mở thanh điều hướng' : 'Thu gọn thanh điều hướng'
              }
              title={
                desktopCollapsed ? 'Mở thanh điều hướng' : 'Thu gọn thanh điều hướng'
              }
              className="btn-icon hidden lg:inline-flex"
            >
              {desktopCollapsed ? (
                <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
              ) : (
                <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
            <span className="truncate text-sm font-medium text-slate-900">{currentTitle}</span>
          </div>

          <div className="flex items-center gap-2">
            {!stompConnected && (
              <span
                role="status"
                aria-live="polite"
                title={UI_TEXT_VI.wsReconnectingBanner}
                className="badge-warning"
              >
                <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Đang kết nối lại realtime…</span>
              </span>
            )}
            {stompConnected && (
              <span className="hidden items-center gap-1.5 text-xs text-slate-500 sm:inline-flex">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                Trực tiếp
              </span>
            )}

            {capabilities.canViewAlerts && (
              <AlertBellPopover
                unreadCount={unreadCount}
                realtimeAlerts={hasMismatchedMyInfo ? [] : realtimeAlerts}
                onAlertUpdated={handleIncomingAlert}
                canViewAlerts={capabilities.canViewAlerts}
                canAcknowledgeAlert={capabilities.canAcknowledgeAlert}
                canResolveAlert={capabilities.canResolveAlert}
                canViewDevices={capabilities.canViewDevices}
              />
            )}
          </div>
        </header>

        <main
          className={
            pathname?.startsWith('/floorplan')
              ? 'flex-1 px-2 py-1.5 lg:px-2.5 lg:py-1.5'
              : desktopCollapsed
                ? 'flex-1 px-4 py-6 lg:px-5 lg:py-6'
                : 'flex-1 px-4 py-6 lg:px-8 lg:py-8'
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}
