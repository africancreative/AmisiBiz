import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { getAppUrlOrNull } from "@/lib/env";
import "@/styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    default: "AmisiBiz — Business, Simplified.",
    template: "%s | AmisiBiz",
  },
  description:
    "AmisiBiz is a modern multi-tenant business management platform for invoicing, CRM, inventory, HR, payroll, and more.",
  metadataBase: new URL(getAppUrlOrNull() ?? "http://localhost:3000"),
  icons: {
    icon: "/brand/amisi-genuine-logo.png",
    shortcut: "/brand/amisi-genuine-logo.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
