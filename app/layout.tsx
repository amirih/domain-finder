import type { Metadata } from 'next';
import 'primereact/resources/themes/saga-blue/theme.css';
import 'primereact/resources/primereact.min.css';
import 'primeicons/primeicons.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Domain Combination Finder',
  description: 'Generate wildcard domain-name combinations and check domain registration status.'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
