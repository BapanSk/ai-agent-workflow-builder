import './globals.css';

export const metadata = {
  title: 'Workflow Console',
  description: 'Multi-tenant workflow runner',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
