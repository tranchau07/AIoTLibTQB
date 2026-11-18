'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  mergeRealtimeTelemetry,
  stompManager,
  upsertRealtimeAlertList,
} from './stomp-client';
import type { AlertResponse, PageResponse, TelemetryResponse } from '@/types/api';

export function useStompConnectionState(): boolean {
  const [connected, setConnected] = useState<boolean>(() =>
    stompManager.isConnected()
  );

  useEffect(() => {
    return stompManager.onConnectionChange(setConnected);
  }, []);

  return connected;
}

/**
 * Subscribes to `/topic/rooms/{roomId}/telemetry` for the lifecycle of the component
 * and updates TanStack Query cache directly (FE-RT-03, FE-RT-04, FE-RT-05).
 */
export function useRoomTelemetryStream(
  roomId: string | null | undefined,
  onPulse?: (latest: TelemetryResponse) => void
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!roomId) return;

    return stompManager.subscribeRoom(roomId, (incoming) => {
      queryClient.setQueryData<TelemetryResponse | null>(
        ['telemetry', 'room-latest', roomId],
        (prev) => mergeRealtimeTelemetry(prev, incoming)
      );
      const deviceId = incoming.metadata?.deviceId;
      if (deviceId) {
        queryClient.setQueryData<TelemetryResponse | null>(
          ['telemetry', 'device-latest', deviceId],
          (prev) => mergeRealtimeTelemetry(prev, incoming)
        );
      }
      onPulse?.(incoming);
    });
  }, [roomId, queryClient, onPulse]);
}

interface AlertListFilterKey {
  roomId?: string;
  type?: string;
  status?: string;
  sortBy?: 'startedAt' | 'severity';
  direction?: 'ASC' | 'DESC';
  page?: number;
  size?: number;
}

export interface AlertZoneScope {
  isAdmin: boolean;
  assignedZones?: readonly string[];
  allowedRoomIds?: ReadonlySet<string>;
  allowedDeviceIds?: ReadonlySet<string>;
}

/**
 * Client-side zone isolation check for incoming STOMP alerts (P0-1 / H1).
 * Fails closed for non-admins without assignedZones. When alert.zoneId is present,
 * it is authoritative (no fall-through to room/device fallback).
 */
export function isAlertInUserZones(
  alert: AlertResponse,
  isAdmin: boolean,
  assignedZones?: readonly string[],
  allowedRoomIds?: ReadonlySet<string>,
  allowedDeviceIds?: ReadonlySet<string>
): boolean {
  if (isAdmin === true) {
    return true;
  }
  if (!assignedZones || assignedZones.length === 0) {
    return false;
  }
  if (alert.zoneId && alert.zoneId.trim().length > 0) {
    return assignedZones.includes(alert.zoneId);
  }
  if (alert.deviceId && allowedDeviceIds?.has(alert.deviceId)) {
    return true;
  }
  if (alert.roomId && allowedRoomIds?.has(alert.roomId)) {
    return true;
  }
  return false;
}

/**
 * Subscribes to `/topic/alerts` when user has VIEW_ALERTS permission (FE-RT-06, FE-RBAC-05).
 */
export function useGlobalAlertStream(
  enabled: boolean,
  onNewAlert?: (alert: AlertResponse) => void,
  zoneScope?: AlertZoneScope
): void {
  const queryClient = useQueryClient();
  const onNewAlertRef = useRef(onNewAlert);
  const zoneScopeRef = useRef(zoneScope);

  useEffect(() => {
    onNewAlertRef.current = onNewAlert;
  }, [onNewAlert]);

  useEffect(() => {
    zoneScopeRef.current = zoneScope;
  }, [zoneScope]);

  useEffect(() => {
    if (!enabled) return;

    return stompManager.onAlert((incoming) => {
      const scope = zoneScopeRef.current;
      if (
        !isAlertInUserZones(
          incoming,
          scope?.isAdmin ?? false,
          scope?.assignedZones,
          scope?.allowedRoomIds,
          scope?.allowedDeviceIds
        )
      ) {
        return;
      }

      const existingQueries = queryClient.getQueriesData<
        PageResponse<AlertResponse>
      >({
        queryKey: ['alerts', 'list'],
      });

      for (const [queryKey, prev] of existingQueries) {
        if (!prev) continue;
        const params = (queryKey[2] ?? {}) as AlertListFilterKey;
        const matchesRoom = !params.roomId || params.roomId === incoming.roomId;
        const matchesType = !params.type || params.type === incoming.type;
        const matchesStatus =
          !params.status || params.status === incoming.status;
        const isFirstPage = !params.page || params.page === 0;
        const effectivePageSize =
          params.size && params.size > 0
            ? params.size
            : prev.size > 0
              ? prev.size
              : undefined;

        queryClient.setQueryData<PageResponse<AlertResponse>>(queryKey, () => {
          if (!matchesRoom || !matchesType) {
            return prev;
          }
          if (!matchesStatus) {
            const existedInPage = prev.content.some((a) => a.id === incoming.id);
            if (!existedInPage) {
              return prev;
            }
            const nextContent = prev.content.filter((a) => a.id !== incoming.id);
            const nextTotalElements = Math.max(0, prev.totalElements - 1);
            const pageSizeForTotals = effectivePageSize ?? 10;
            const nextTotalPages =
              nextTotalElements === 0
                ? 0
                : Math.ceil(nextTotalElements / pageSizeForTotals);
            const currentPage = params.page ?? prev.page ?? 0;
            return {
              ...prev,
              content: nextContent,
              totalElements: nextTotalElements,
              totalPages: nextTotalPages,
              last: nextTotalPages === 0 ? true : currentPage + 1 >= nextTotalPages,
            };
          }
          if (!isFirstPage) {
            const existsInPage = prev.content.some((a) => a.id === incoming.id);
            if (!existsInPage) return prev;
            return {
              ...prev,
              content: upsertRealtimeAlertList(prev.content, incoming, {
                sortBy: params.sortBy,
                direction: params.direction,
                maxSize: effectivePageSize,
              }),
            };
          }
          const existsInPage = prev.content.some((a) => a.id === incoming.id);
          const nextContent = upsertRealtimeAlertList(prev.content, incoming, {
            sortBy: params.sortBy,
            direction: params.direction,
            maxSize: effectivePageSize,
          });
          const nextTotalElements = existsInPage
            ? prev.totalElements
            : prev.totalElements + 1;
          const nextTotalPages = effectivePageSize
            ? nextTotalElements === 0
              ? 0
              : Math.ceil(nextTotalElements / effectivePageSize)
            : prev.totalPages;
          const currentPage = params.page ?? prev.page ?? 0;
          const nextLast = effectivePageSize
            ? nextTotalPages === 0
              ? true
              : currentPage + 1 >= nextTotalPages
            : prev.last;

          return {
            ...prev,
            content: nextContent,
            totalElements: nextTotalElements,
            totalPages: nextTotalPages,
            last: nextLast,
          };
        });
      }

      void queryClient.invalidateQueries({ queryKey: ['alerts', 'unread-count'] });
      onNewAlertRef.current?.(incoming);
    });
  }, [enabled, queryClient]);
}
