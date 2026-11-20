import type { Metadata } from 'next';
import './globals.css';
import { AppProviders } from './providers';

export const metadata: Metadata = {
  title: 'AIoTLibTQB — Giám sát Vi khí hậu & Âm học Thư viện Tạ Quang Bửu',
  description:
    'Hệ thống quản lý và giám sát chất lượng môi trường, âm học phòng đọc thời gian thực.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
