'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/features/auth/store';
import { Skeleton } from '@/components/ui/primitives';

export default function HomePage() {
  const router = useRouter();
  const hydrated = useAuthStore((s) => s.hydrated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const refreshToken = useAuthStore((s) => s.refreshToken);
  const hydrateFromStorage = useAuthStore((s) => s.hydrateFromStorage);

  useEffect(() => {
    hydrateFromStorage();
  }, [hydrateFromStorage]);

  useEffect(() => {
    if (!hydrated) return;
    if (accessToken || refreshToken) {
      router.replace('/dashboard');
    } else {
      router.replace('/kiosk');
    }
  }, [hydrated, accessToken, refreshToken, router]);

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <Skeleton className="h-24 w-full" />
    </main>
  );
}
