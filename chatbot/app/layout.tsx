import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gloo AI Chatbot",
  description:
    "Streaming markdown chatbot powered by the Gloo Completions V2 API",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  );
}
