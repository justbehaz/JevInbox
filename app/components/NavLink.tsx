"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export default function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
  return (
    <Link href={href} aria-current={active ? "page" : undefined}
      className={`flex items-center justify-between gap-2 rounded px-3 py-1.5 text-sm hover:bg-sel ${active ? "bg-sel font-semibold" : ""}`}>
      {children}
    </Link>
  );
}
