import { useRef, useState } from "preact/hooks";
import type { ApiClient } from "../lib/api";
import {
  filesFromTransfer,
  hasFiles,
  pastedName,
  rejectReason,
  type Attachment,
} from "../lib/attachments";

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Gagal membaca ${file.name}.`));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Lampiran pesan: tambah (paste, drop, pilih berkas), hapus, dan status seret. */
export function useAttachments(api: ApiClient) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const countRef = useRef(0);
  const depthRef = useRef(0);

  const add = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    setError(undefined);
    for (const file of files) {
      const name = pastedName(file, new Date());
      const reason = rejectReason({ name, size: file.size }, countRef.current);
      if (reason !== undefined) {
        setError(reason);
        continue;
      }
      countRef.current += 1;
      setPending((value) => value + 1);
      try {
        const saved = await api.uploadAttachment({ name, data: await readBase64(file) });
        setItems((current) => [...current, saved]);
      } catch (caught) {
        countRef.current -= 1;
        setError(caught instanceof Error ? caught.message : `Gagal mengunggah ${name}.`);
      } finally {
        setPending((value) => value - 1);
      }
    }
  };

  const remove = (id: string): void => {
    countRef.current = Math.max(0, countRef.current - 1);
    setItems((current) => current.filter((item) => item.id !== id));
    setError(undefined);
  };

  const clear = (): void => {
    countRef.current = 0;
    setItems([]);
    setError(undefined);
  };

  /** Pasang di `<textarea onPaste>`: mengambil berkas (mis. gambar) dari clipboard. */
  const onPaste = (event: ClipboardEvent): void => {
    const files = filesFromTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void add(files);
  };

  /** Pasang di elemen yang menerima seretan berkas. */
  const dropProps = {
    onDragEnter: (event: DragEvent): void => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depthRef.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent): void => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
    },
    onDragLeave: (event: DragEvent): void => {
      if (!hasFiles(event.dataTransfer)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent): void => {
      if (!hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depthRef.current = 0;
      setDragging(false);
      void add(filesFromTransfer(event.dataTransfer));
    },
  };

  return { items, pending, error, dragging, add, remove, clear, onPaste, dropProps };
}
