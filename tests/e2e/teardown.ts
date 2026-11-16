/**
 * Pembersihan setelah seluruh spec selesai.
 *
 * Playwright menutup server uji dengan SIGKILL, jadi penangan sinyal di
 * `server.ts` tak sempat menghapus direktori sementara. Di sini lah
 * penghapusannya: direktori data uji dihapus setelah semua spec lewat.
 */

import { rm } from "node:fs/promises";
import { direktoriDataUji } from "./tmp-home";

export default async function globalTeardown(): Promise<void> {
  await rm(direktoriDataUji(), { recursive: true, force: true }).catch(() => undefined);
}
