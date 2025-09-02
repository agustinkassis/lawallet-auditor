import type { Metadata } from 'next';

import { Geist } from 'next/font/google';

const geist = Geist({
  subsets: ['latin'],
});

import './globals.css';

export const metadata: Metadata = {
  title: 'v0 App',
  description: 'Created with v0',
  generator: 'v0.app',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang='en' className={geist.className}>
      <body>{children}</body>
    </html>
  );
}
