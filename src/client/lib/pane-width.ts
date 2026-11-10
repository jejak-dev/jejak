export interface PaneWidthSpec {
  key: string;
  def: number;
  min: number;
  max: number;
  step: number;
}

/** Fungsi murni untuk lebar panel yang bisa digeser dan diingat di localStorage. */
export function paneWidth(spec: PaneWidthSpec) {
  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return spec.def;
    return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
  };
  const parse = (value: unknown): number => {
    if (typeof value !== "string" || value.trim() === "") return spec.def;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? clamp(parsed) : spec.def;
  };
  return {
    spec,
    clamp,
    parse,
    load(storage: Pick<Storage, "getItem"> | undefined): number {
      try {
        return parse(storage?.getItem(spec.key));
      } catch {
        return spec.def;
      }
    },
    save(storage: Pick<Storage, "setItem"> | undefined, width: number): void {
      try {
        storage?.setItem(spec.key, String(clamp(width)));
      } catch {
        // penyimpanan diblokir: lebar berlaku untuk sesi ini saja
      }
    },
    /** `grow` = arah panah yang memperlebar panel. */
    forKey(current: number, key: string, grow: "ArrowRight" | "ArrowLeft"): number | undefined {
      if (key === "Home") return spec.def;
      if (key === grow) return clamp(current + spec.step);
      if (key === (grow === "ArrowRight" ? "ArrowLeft" : "ArrowRight")) return clamp(current - spec.step);
      return undefined;
    },
  };
}
