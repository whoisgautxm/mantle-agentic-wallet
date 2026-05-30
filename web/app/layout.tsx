export const metadata = { title: "Mantle Agent Wallet", description: "Live on-chain AI agent decisions" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
