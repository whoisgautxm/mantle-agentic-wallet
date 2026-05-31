import "./style.css";

export const metadata = {
  title: "Mantle Human vs AI Wallet",
  description: "On-chain AI trading benchmark on Mantle",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
