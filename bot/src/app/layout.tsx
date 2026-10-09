import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Performe+ Bot — WhatsApp AI",
  description: "Bot IA da Performe+ para WhatsApp. Deploy Render + Odoo SaaS.",
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
