/**
 * Pemecah aliran teks menjadi pesan JSON per baris. Dipakai klien ACP karena
 * agent (dan plugin-nya) kadang menulis log biasa ke stdout. Baris yang bukan
 * JSON dilewati, bukan dilempar: satu log nyasar tidak boleh menghentikan
 * percakapan.
 */
export function createLineParser(
  onMessage: (msg: unknown) => void,
  onSkip?: (line: string) => void,
): (chunk: string) => void {
  let buffer = "";

  function handleLine(raw: string): void {
    // `\r\n`: buang sisa `\r` (termasuk saat potongan terbelah tepat di antaranya).
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      onSkip?.(line);
      return;
    }
    // Di luar try: galat dari penerima pesan bukan "baris rusak" dan tak boleh tertelan.
    onMessage(parsed);
  }

  return (chunk: string): void => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      // Majukan buffer dulu: baris yang penerimanya melempar tak boleh diproses ulang.
      buffer = buffer.slice(index + 1);
      handleLine(line);
      index = buffer.indexOf("\n");
    }
  };
}
