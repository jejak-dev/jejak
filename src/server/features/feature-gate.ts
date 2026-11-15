/**
 * Gerbang fitur: manajer dibuat malas saat fitur dinyalakan dan ditutup
 * saat fitur dimatikan. Rute dan runner membaca `get()` pada setiap
 * permintaan sehingga status fitur berlaku seketika.
 */
export interface FeatureGateOptions<T> {
  /** Membuat manajer sekali saat fitur pertama kali dinyalakan. */
  create: () => T;
  /** Menutup manajer saat fitur dimatikan. */
  close: (manager: T) => void | Promise<void>;
}

export class FeatureGate<T> {
  private enabled = false;
  private manager: T | undefined;
  private readonly options: FeatureGateOptions<T>;

  constructor(options: FeatureGateOptions<T>) {
    this.options = options;
  }

  /** Apakah fitur sedang menyala. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Manajer aktif bila fitur menyala; `undefined` bila mati. */
  get(): T | undefined {
    if (!this.enabled) return undefined;
    if (this.manager === undefined) this.manager = this.options.create();
    return this.manager;
  }

  /** Nyalakan fitur; manajer dibuat saat pertama kali dipakai. */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Manajer yang sudah dibuat; `undefined` bila fitur mati atau belum pernah
   * dipakai. Tak pernah membuat manajer baru (dipakai jalur keluar proses).
   */
  peek(): T | undefined {
    return this.manager;
  }

  /** Matikan fitur: manajer ditutup dan dilepas. */
  async disable(): Promise<void> {
    this.enabled = false;
    const manager = this.manager;
    this.manager = undefined;
    if (manager === undefined) return;
    await this.options.close(manager);
  }

  /** Tutup manajer yang masih hidup (dipakai saat server berhenti). */
  async shutdown(): Promise<void> {
    await this.disable();
  }
}
