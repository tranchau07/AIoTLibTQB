import { Client, IMessage, StompSubscription } from '@stomp/stompjs';
import { ENV } from '@/config/env';
import type { AlertResponse, TelemetryResponse } from '@/types/api';

/**
 * Pure reducer functions for STOMP incoming messages (FE-RT-05, FE-RT-06).
 */
export function mergeRealtimeTelemetry(
  current: TelemetryResponse | null | undefined,
  incoming: TelemetryResponse
): TelemetryResponse {
  if (!current || !current.timestamp) {
    return incoming;
  }
  const currentMs = new Date(current.timestamp).getTime();
  const incomingMs = new Date(incoming.timestamp).getTime();
  if (!Number.isNaN(currentMs) && !Number.isNaN(incomingMs) && incomingMs < currentMs) {
    return current;
  }
  return incoming;
}

export interface UpsertRealtimeAlertOptions {
  sortBy?: 'startedAt' | 'severity';
  direction?: 'ASC' | 'DESC';
  maxSize?: number;
}

const SEVERITY_WEIGHT: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function resolveAlertSeverityWeight(alert: AlertResponse): number {
  if (
    typeof alert.severityRank === 'number' &&
    !Number.isNaN(alert.severityRank)
  ) {
    return alert.severityRank;
  }
  return alert.severity ? (SEVERITY_WEIGHT[alert.severity] ?? 0) : 0;
}

function getStartedAtMs(alert: AlertResponse): number {
  const ms = new Date(alert.startedAt).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

export function upsertRealtimeAlertList(
  currentList: readonly AlertResponse[],
  incoming: AlertResponse,
  options?: UpsertRealtimeAlertOptions
): AlertResponse[] {
  const index = currentList.findIndex((a) => a.id === incoming.id);
  const updated =
    index === -1
      ? [incoming, ...currentList]
      : currentList.map((item, idx) => (idx === index ? incoming : item));

  if (options?.sortBy === 'severity') {
    const dir = options.direction === 'ASC' ? 1 : -1;
    updated.sort((a, b) => {
      const rankDiff =
        resolveAlertSeverityWeight(a) - resolveAlertSeverityWeight(b);
      if (rankDiff !== 0) {
        return dir * rankDiff;
      }
      return getStartedAtMs(b) - getStartedAtMs(a);
    });
  } else if (options?.sortBy === 'startedAt') {
    const dir = options.direction === 'ASC' ? 1 : -1;
    updated.sort((a, b) => dir * (getStartedAtMs(a) - getStartedAtMs(b)));
  }

  if (
    typeof options?.maxSize === 'number' &&
    options.maxSize > 0 &&
    updated.length > options.maxSize
  ) {
    return updated.slice(0, options.maxSize);
  }
  return updated;
}

export type ConnectionListener = (connected: boolean) => void;
export type AlertListener = (alert: AlertResponse) => void;
export type RoomTelemetryListener = (data: TelemetryResponse) => void;

/**
 * Singleton STOMP Client manager (FE-RT-01, FE-RT-02, FE-RT-09).
 */
class AiotStompManager {
  private client: Client | null = null;
  private connected = false;
  private allowPublicKiosk = false;
  private connectedWithToken = false;
  private tokenGetter: () => string | null = () => null;
  private canSubscribeAlertsGetter: () => boolean = () => false;

  private connectionListeners = new Set<ConnectionListener>();
  private alertListeners = new Set<AlertListener>();
  private roomListeners = new Map<string, Set<RoomTelemetryListener>>();
  private activeRoomSubs = new Map<string, StompSubscription>();
  private alertSub: StompSubscription | null = null;

  public configure(
    getAccessToken: () => string | null,
    canSubscribeAlerts: () => boolean
  ): void {
    this.tokenGetter = getAccessToken;
    this.canSubscribeAlertsGetter = canSubscribeAlerts;
  }

  public activate(allowPublicKiosk = false): void {
    if (typeof window === 'undefined') return;
    const token = this.tokenGetter();
    if (!token && !allowPublicKiosk) return;

    this.allowPublicKiosk = allowPublicKiosk;
    const hasToken = Boolean(token);

    if (this.client?.active) {
      if (this.connectedWithToken !== hasToken) {
        this.deactivate();
      } else {
        this.client.connectHeaders = hasToken
          ? { Authorization: `Bearer ${token}` }
          : { 'X-Public-Kiosk': 'true' };
        if (this.connected) {
          this.resubscribeAll();
        }
        return;
      }
    }

    this.connectedWithToken = hasToken;

    this.client = new Client({
      brokerURL: ENV.WS_URL,
      reconnectDelay: 5000,
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      beforeConnect: () => {
        const latestToken = this.tokenGetter();
        if (!this.client) return;
        if (latestToken) {
          this.connectedWithToken = true;
          this.client.connectHeaders = {
            Authorization: `Bearer ${latestToken}`,
          };
        } else if (this.allowPublicKiosk) {
          this.connectedWithToken = false;
          this.client.connectHeaders = {
            'X-Public-Kiosk': 'true',
          };
        } else {
          this.connectedWithToken = false;
          this.client.connectHeaders = {};
        }
      },
      onConnect: () => {
        this.setConnected(true);
        this.resubscribeAll();
      },
      onWebSocketClose: () => {
        this.setConnected(false);
      },
      onStompError: (frame) => {
        // FE-RT-09: Never log raw headers or tokens
        console.warn(
          '[STOMP] Broker error:',
          frame.headers['message'] || 'Unknown error'
        );
        this.setConnected(false);
      },
    });

    this.client.activate();
  }

  public deactivate(): void {
    this.alertSub?.unsubscribe();
    this.alertSub = null;
    this.activeRoomSubs.forEach((sub) => sub.unsubscribe());
    this.activeRoomSubs.clear();
    this.allowPublicKiosk = false;
    this.connectedWithToken = false;
    if (this.client) {
      void this.client.deactivate();
      this.client = null;
    }
    this.setConnected(false);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getListenerDiagnostics(): {
    connectionListenersCount: number;
    alertListenersCount: number;
    roomChannelCount: number;
    roomListenersCount: number;
    activeRoomSubsCount: number;
    hasAlertSub: boolean;
  } {
    let totalRoomListeners = 0;
    for (const set of this.roomListeners.values()) {
      totalRoomListeners += set.size;
    }
    return {
      connectionListenersCount: this.connectionListeners.size,
      alertListenersCount: this.alertListeners.size,
      roomChannelCount: this.roomListeners.size,
      roomListenersCount: totalRoomListeners,
      activeRoomSubsCount: this.activeRoomSubs.size,
      hasAlertSub: Boolean(this.alertSub),
    };
  }

  public onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    listener(this.connected);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  public onAlert(listener: AlertListener): () => void {
    this.alertListeners.add(listener);
    this.ensureAlertSubscription();
    return () => {
      this.alertListeners.delete(listener);
      if (this.alertListeners.size === 0 && this.alertSub) {
        this.alertSub.unsubscribe();
        this.alertSub = null;
      }
    };
  }

  public subscribeRoom(
    roomId: string,
    listener: RoomTelemetryListener
  ): () => void {
    if (!roomId) return () => {};
    let set = this.roomListeners.get(roomId);
    if (!set) {
      set = new Set();
      this.roomListeners.set(roomId, set);
    }
    set.add(listener);
    this.ensureRoomSubscription(roomId);

    return () => {
      const currentSet = this.roomListeners.get(roomId);
      if (!currentSet) return;
      currentSet.delete(listener);
      if (currentSet.size === 0) {
        this.roomListeners.delete(roomId);
        const sub = this.activeRoomSubs.get(roomId);
        if (sub) {
          sub.unsubscribe();
          this.activeRoomSubs.delete(roomId);
        }
      }
    };
  }

  private setConnected(state: boolean): void {
    this.connected = state;
    this.connectionListeners.forEach((cb) => cb(state));
  }

  private resubscribeAll(): void {
    this.alertSub = null;
    this.activeRoomSubs.clear();
    if (this.alertListeners.size > 0) {
      this.ensureAlertSubscription();
    }
    for (const roomId of this.roomListeners.keys()) {
      this.ensureRoomSubscription(roomId);
    }
  }

  private ensureAlertSubscription(): void {
    if (
      !this.connected ||
      !this.client ||
      this.alertSub ||
      !this.tokenGetter() ||
      !this.canSubscribeAlertsGetter()
    ) {
      return;
    }
    this.alertSub = this.client.subscribe('/topic/alerts', (msg: IMessage) => {
      try {
        const parsed = JSON.parse(msg.body) as AlertResponse;
        this.alertListeners.forEach((cb) => cb(parsed));
      } catch {
        // Ignore malformed frame
      }
    });
  }

  private ensureRoomSubscription(roomId: string): void {
    if (!this.connected || !this.client || this.activeRoomSubs.has(roomId)) {
      return;
    }
    const topic = this.connectedWithToken
      ? `/topic/rooms/${roomId}/telemetry`
      : `/topic/public/rooms/${roomId}/telemetry`;

    const sub = this.client.subscribe(topic, (msg: IMessage) => {
      try {
        const parsed = JSON.parse(msg.body) as TelemetryResponse;
        const listeners = this.roomListeners.get(roomId);
        listeners?.forEach((cb) => cb(parsed));
      } catch {
        // Ignore malformed frame
      }
    });
    this.activeRoomSubs.set(roomId, sub);
  }
}

export const stompManager = new AiotStompManager();
