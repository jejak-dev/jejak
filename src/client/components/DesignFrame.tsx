import type { DeviceId } from "../lib/api";
import type { Rect } from "../lib/design-canvas";
import type { ExportScale } from "../lib/design-export";
import { DEVICE_IDS, deviceLabel } from "../lib/design-ui";
import { Dropdown, type DropdownSection } from "./Dropdown";

export interface DesignFrameProps {
  title: string;
  route?: string;
  /** Label varian halaman (mis. "gelap"); chip kecil di samping judul. */
  variant?: string;
  device: DeviceId;
  rect: Rect;
  zoom: number;
  /** Frame sedang memuat iframe (beririsan viewport dan terpilih). */
  live: boolean;
  /** Berkas halaman belum ada di disk. */
  missing: boolean;
  /** URL dokumen frame; undefined selama belum dimuat. */
  src?: string;
  /** Jumlah peringatan perakitan halaman. */
  warnings: number;
  onLabelPointerDown: (event: PointerEvent) => void;
  onLabelPointerMove: (event: PointerEvent) => void;
  onLabelPointerUp: (event: PointerEvent) => void;
  onDevice: (device: DeviceId) => void;
  onReload: () => void;
  /** Minta pembuatan varian baru dari halaman ini. */
  onCreateVariant?: () => void;
  /** Unduh halaman ini sebagai PNG (skala 1 atau 2). */
  onExportPng?: (scale: ExportScale) => void;
  /** Pointer meninggalkan pembungkus frame; dipakai alat Pilih. */
  onPointerLeave?: () => void;
  setFrameRef: (element: HTMLIFrameElement | null) => void;
}

function isDeviceId(value: string): value is DeviceId {
  return (DEVICE_IDS as readonly string[]).includes(value);
}

/**
 * Judul tanpa sufiks varian. Server menamai halaman varian sebagai
 * "Judul (varian)"; di label kanvas varian tampil sebagai chip terpisah.
 */
function judulTanpaVarian(title: string, variant: string | undefined): string {
  if (variant === undefined || variant === "") return title;
  const sufiks = ` (${variant})`;
  return title.endsWith(sufiks) ? title.slice(0, -sufiks.length) : title;
}

/**
 * Satu frame di kanvas: label di atas (ukuran layar tetap lewat
 * `scale(1/zoom)`) dan kotak berukuran preset perangkat. Hanya memuat iframe
 * saat hidup; selain itu kotak penampung berjudul.
 */
export function DesignFrame(props: DesignFrameProps) {
  const { title, route, device, rect, zoom, live, missing, src, warnings } = props;
  const varian = props.variant;
  const labelJudul = judulTanpaVarian(title, varian);

  const sections: DropdownSection[] = [
    {
      title: "Perangkat",
      value: device,
      options: DEVICE_IDS.map((id) => ({ value: id, label: deviceLabel(id) })),
      onSelect: (value) => {
        if (isDeviceId(value)) props.onDevice(value);
      },
    },
    {
      title: "Frame",
      options: [{ value: "reload", label: "Segarkan frame" }],
      onSelect: () => props.onReload(),
    },
  ];
  if (props.onCreateVariant !== undefined) {
    sections.push({
      title: "Varian",
      options: [{ value: "create", label: "Buat varian…" }],
      onSelect: () => props.onCreateVariant?.(),
    });
  }
  if (props.onExportPng !== undefined) {
    sections.push({
      title: "Ekspor",
      options: [
        { value: "png", label: "Unduh PNG" },
        { value: "png2", label: "Unduh PNG 2x" },
      ],
      onSelect: (value) => props.onExportPng?.(value === "png2" ? 2 : 1),
    });
  }

  return (
    <>
      <div
        class="jk-design-frame-label"
        style={{
          left: `${rect.x}px`,
          top: `${rect.y}px`,
          transform: `scale(${1 / zoom}) translateY(-100%)`,
        }}
        onPointerDown={props.onLabelPointerDown}
        onPointerMove={props.onLabelPointerMove}
        onPointerUp={props.onLabelPointerUp}
        onPointerCancel={props.onLabelPointerUp}
      >
        <span class="jk-design-frame-title">{labelJudul}</span>
        {varian !== undefined && varian !== "" && (
          <span class="jk-design-frame-variant">{varian}</span>
        )}
        <span class="jk-design-frame-meta">{deviceLabel(device)}</span>
        {route !== undefined && route !== "" && (
          <span class="jk-design-frame-meta">{route}</span>
        )}
        {warnings > 0 && (
          <span class="jk-design-frame-warn" title={`${warnings} peringatan perakitan`}>
            !
          </span>
        )}
        <Dropdown
          label="⋯"
          ariaLabel={`Menu frame ${title}`}
          placement="down"
          align="start"
          sections={sections}
        />
      </div>

      <div
        class="jk-design-frame"
        style={{
          left: `${rect.x}px`,
          top: `${rect.y}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        }}
        onPointerLeave={props.onPointerLeave}
      >
        {missing ? (
          <div class="jk-design-frame-empty">Berkas belum ada</div>
        ) : live && src !== undefined ? (
          <iframe
            ref={props.setFrameRef}
            sandbox="allow-scripts"
            src={src}
            title={`Halaman ${title}`}
            referrerpolicy="no-referrer"
          />
        ) : (
          <div class="jk-design-frame-empty">{title}</div>
        )}
      </div>
    </>
  );
}
