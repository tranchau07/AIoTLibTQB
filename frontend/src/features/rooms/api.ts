import { httpClient } from '@/lib/http/client';
import type {
  PageResponse,
  PublicRoomStatusResponse,
  RoomCreationRequest,
  RoomResponse,
  RoomThresholdConfig,
  RoomUpdateRequest,
} from '@/types/api';

export const roomsApi = {
  list: (params: { page?: number; size?: number; floor?: number } = {}) => {
    const search = new URLSearchParams();
    search.set('page', String(params.page ?? 0));
    search.set('size', String(params.size ?? 10));
    if (params.floor !== undefined) {
      search.set('floor', String(params.floor));
    }
    return httpClient.get<PageResponse<RoomResponse>>(
      `/rooms?${search.toString()}`
    );
  },

  getById: (id: string) => httpClient.get<RoomResponse>(`/rooms/${id}`),

  getByCode: (code: string) =>
    httpClient.get<RoomResponse>(`/rooms/code/${encodeURIComponent(code)}`),

  create: (body: RoomCreationRequest) =>
    httpClient.post<RoomResponse>('/rooms', body),

  update: (id: string, body: RoomUpdateRequest) =>
    httpClient.put<RoomResponse>(`/rooms/${id}`, body),

  updateThresholds: (id: string, body: RoomThresholdConfig) =>
    httpClient.put<RoomResponse>(`/rooms/${id}/thresholds`, body),

  listPublic: (floor?: number) => {
    const query = floor !== undefined ? `?floor=${floor}` : '';
    return httpClient.get<PublicRoomStatusResponse[]>(`/public/rooms${query}`);
  },

  remove: (id: string) => httpClient.delete<void>(`/rooms/${id}`),
};
