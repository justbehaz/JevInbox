import type { ReactNode } from "react";
import Shell from "../components/Shell";
import "./globals.css";

export const metadata = { title: "Jev Inbox", description: "Mail sorted by jev.ai. Security mail never goes to junk." };
// State lives in memory on the server, so pages are rendered per request.
export const dynamic = "force-dynamic";

const themeScript = `try{var t=localStorage.getItem("jev-theme");if(!t){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2">Skip to content</a>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
