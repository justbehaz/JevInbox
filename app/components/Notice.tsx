export type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function param(sp: SP, key: string): string | undefined {
  return one(sp[key]);
}

export default function Notice({ sp }: { sp: SP }) {
  const text = one(sp.notice);
  if (!text) return null;
  const kind = one(sp.kind) ?? "info";
  const color = kind === "error" ? "border-danger text-danger" : kind === "ok" ? "border-ok text-ok" : "border-line text-fg";
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`mb-3 rounded border bg-card px-3 py-2 text-sm ${color}`}>
      {text}
    </div>
  );
}
