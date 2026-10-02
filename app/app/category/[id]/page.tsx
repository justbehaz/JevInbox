import { notFound } from "next/navigation";
import Workspace from "../../../components/Workspace";
import { SP } from "../../../components/Notice";
import { getAppState } from "../../../src/ui/state";

export default async function CategoryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const cat = (await getAppState()).categories.get(id);
  if (!cat) notFound();
  return <Workspace title={cat.name} path={`/category/${id}`} view={{ kind: "category", id }} sp={await searchParams}
    intro={cat.enabled ? undefined : <p className="mb-3 text-sm text-warn">This category is disabled. New mail is not filed here, but it still counts toward the 48-category limit.</p>} />;
}
