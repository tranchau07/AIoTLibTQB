import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { roomsApi } from './api';
import type {
  RoomCreationRequest,
  RoomFurnitureUpdateRequest,
  RoomThresholdConfig,
  RoomUpdateRequest,
} from '@/types/api';

export const roomKeys = {
  all: ['rooms'] as const,
  list: (params: { page?: number; size?: number; floor?: number }) =>
    ['rooms', 'list', params] as const,
  detail: (id: string) => ['rooms', 'detail', id] as const,
  furniture: (id: string, isPublic = false) =>
    ['rooms', 'furniture', id, isPublic ? 'public' : 'auth'] as const,
};

export function useRoomsQuery(
  params: { page?: number; size?: number; floor?: number } = {},
  enabled = true
) {
  return useQuery({
    queryKey: roomKeys.list(params),
    queryFn: () => roomsApi.list(params),
    enabled,
  });
}

export function useRoomDetailQuery(id: string | undefined) {
  return useQuery({
    queryKey: roomKeys.detail(id ?? ''),
    queryFn: () => roomsApi.getById(id!),
    enabled: Boolean(id),
  });
}

export function useRoomFurnitureQuery(
  id: string | undefined,
  enabled = true,
  isPublic = false
) {
  const isRealRoom = Boolean(id && !id.startsWith('PRESET_'));
  return useQuery({
    queryKey: roomKeys.furniture(id ?? '', isPublic),
    queryFn: () =>
      isPublic ? roomsApi.getPublicFurniture(id!) : roomsApi.getFurniture(id!),
    enabled: enabled && isRealRoom,
    retry: false,
  });
}

export function useCreateRoomMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RoomCreationRequest) => roomsApi.create(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: roomKeys.all });
    },
  });
}

export function useUpdateRoomMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RoomUpdateRequest }) =>
      roomsApi.update(id, body),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: roomKeys.all });
      void qc.invalidateQueries({ queryKey: roomKeys.detail(vars.id) });
    },
  });
}

export function useUpdateRoomThresholdsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RoomThresholdConfig }) =>
      roomsApi.updateThresholds(id, body),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: roomKeys.all });
      void qc.invalidateQueries({ queryKey: roomKeys.detail(vars.id) });
    },
  });
}

export function useUpdateRoomFurnitureMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: RoomFurnitureUpdateRequest;
    }) => roomsApi.updateFurniture(id, body),
    onSuccess: (data, vars) => {
      qc.setQueryData(roomKeys.furniture(vars.id, false), data);
      void qc.invalidateQueries({ queryKey: roomKeys.furniture(vars.id, true) });
    },
  });
}

export function usePublicRoomsQuery(floor?: number, enabled = true) {
  return useQuery({
    queryKey: ['public-rooms', floor] as const,
    queryFn: () => roomsApi.listPublic(floor),
    enabled,
    refetchInterval: 15000,
  });
}

export function useDeleteRoomMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => roomsApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: roomKeys.all });
    },
  });
}
