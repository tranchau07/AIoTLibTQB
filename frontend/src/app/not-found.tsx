import React from 'react';
import Link from 'next/link';
import { Compass, Home, Tv } from 'lucide-react';

export default function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-700">
          <Compass className="h-6 w-6" />
        </div>
        <p className="mt-3 font-mono text-xs font-semibold text-slate-400">
          404 · KHÔNG TÌM THẤY TRANG
        </p>
        <h1 className="mt-1 text-lg font-semibold text-slate-900">
          Đường dẫn không tồn tại
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Trang bạn đang truy cập đã được di chuyển hoặc không có trong hệ thống giám sát môi trường Thư viện Tạ Quang Bửu.
        </p>
        <div className="mt-6 flex items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="btn-primary inline-flex items-center gap-1.5"
          >
            <Home className="h-3.5 w-3.5" />
            <span>Bảng điều khiển</span>
          </Link>
          <Link
            href="/kiosk"
            className="btn-secondary inline-flex items-center gap-1.5"
          >
            <Tv className="h-3.5 w-3.5" />
            <span>Cổng Kiosk công cộng</span>
          </Link>
        </div>
      </div>
    </main>
  );
}
