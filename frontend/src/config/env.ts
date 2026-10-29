export const ENV = {
  API_BASE_URL:
    process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8080/api/v1',
  WS_URL: process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080/ws-aiot',
} as const;
