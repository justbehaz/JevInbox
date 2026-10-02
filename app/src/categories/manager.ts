// User category list with the hard cap of 48. System buckets (Auth, Junk, Needs review) do not
// count. Disabled categories DO count until they are deleted (decision recorded in 01-taxonomy.md).
import { Category, DEFAULT_CATEGORIES } from "../gate/categories";

export const CATEGORY_CAP = 48;
export const NAME_MAX = 40;

export interface ManagedCategory extends Category {
  custom: boolean;
  enabled: boolean;
}

export type CatResult = { ok: true; category?: ManagedCategory } | { ok: false; error: string };

export class CategoryManager {
  private cats: ManagedCategory[];
  private nextCustom: number;

  constructor(defaults: Category[] = DEFAULT_CATEGORIES) {
    this.cats = defaults.map((c) => ({ ...c, custom: false, enabled: true }));
    this.nextCustom = defaults.length + 1;
  }

  list(): ManagedCategory[] {
    return this.cats.map((c) => ({ ...c }));
  }

  /** Categories jev.ai is asked about. */
  enabled(): ManagedCategory[] {
    return this.list().filter((c) => c.enabled);
  }

  /** Counts toward the cap: enabled AND disabled. */
  count(): number {
    return this.cats.length;
  }

  get(id: string): ManagedCategory | undefined {
    const c = this.cats.find((x) => x.id === id);
    return c ? { ...c } : undefined;
  }

  nameOf(id: string | null | undefined): string {
    return this.cats.find((c) => c.id === id)?.name ?? "Uncategorised";
  }

  add(rawName: string): CatResult {
    const name = rawName.replace(/\s+/g, " ").trim();
    if (!name) return { ok: false, error: "Enter a category name." };
    if (name.length > NAME_MAX) return { ok: false, error: `Category names are at most ${NAME_MAX} characters.` };
    if (this.count() >= CATEGORY_CAP) {
      return { ok: false, error: `You've reached the ${CATEGORY_CAP}-category limit. Delete a category to add a new one (disabling does not free a slot).` };
    }
    if (this.cats.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: "A category with that name already exists." };
    }
    const id = `cat_${String(this.nextCustom++).padStart(3, "0")}`;
    const category: ManagedCategory = { id, name, question: `Is this message about ${name}?`, custom: true, enabled: true };
    this.cats.push(category);
    return { ok: true, category: { ...category } };
  }

  setEnabled(id: string, enabled: boolean): CatResult {
    const c = this.cats.find((x) => x.id === id);
    if (!c) return { ok: false, error: "Unknown category." };
    c.enabled = enabled; // still counts toward the cap either way
    return { ok: true, category: { ...c } };
  }

  /** Only disabled categories can be deleted. This frees one slot. */
  remove(id: string): CatResult {
    const i = this.cats.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: "Unknown category." };
    if (this.cats[i].enabled) return { ok: false, error: "Disable a category before deleting it." };
    const [gone] = this.cats.splice(i, 1);
    return { ok: true, category: { ...gone } };
  }
}
