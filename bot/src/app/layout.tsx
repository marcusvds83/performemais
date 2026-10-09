import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Nytro Bot — Vercel",
  description: "Bot IA da Nytro para WhatsApp. Deploy Vercel + Odoo SaaS.",
  robots: "noindex",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 0 }}>
        {children}
      </body>
    </html>
  );
}
