'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw, Home } from 'lucide-react';

export default function GlobalErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[GlobalErrorBoundary]', error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-slate-900">
          Đã xảy ra lỗi không mong muốn
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          {error.message ||
            'Ứng dụng gặp sự cố trong quá trình hiển thị dữ liệu. Bạn có thể thử tải lại trang hoặc quay về trang tổng quan.'}
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="btn-primary inline-flex items-center gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Thử lại</span>
          </button>
          <Link
            href="/dashboard"
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <Home className="h-3.5 w-3.5" />
            <span>Về tổng quan</span>
          </Link>
        </div>
      </div>
    </main>
  );
}
