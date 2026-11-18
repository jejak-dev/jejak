import type { DeviceId } from "../lib/api";
import type { Rect } from "../lib/design-canvas";
import { DEVICE_IDS, deviceLabel } from "../lib/design-ui";
import { Dropdown } from "./Dropdown";

export interface DesignFrameProps {
  title: string;
  route?: string;
  device: DeviceId;
  rect: Rect;
  zoom: number;
  /** Frame sedang memuat iframe (beririsan viewport dan terpilih). */
  live: boolean;
  /** Berkas halaman belum ada di disk. */
  missing: boolean;
  /** Dokumen terakit; undefined selama belum dimuat. */
  html?: string;
  /** Jumlah peringatan perakitan halaman. */
  warnings: number;
  onLabelPointerDown: (event: PointerEvent) => void;
  onLabelPointerMove: (event: PointerEvent) => void;
  onLabelPointerUp: (event: PointerEvent) => void;
  onDevice: (device: DeviceId) => void;
  onReload: () => void;
  /** Pointer meninggalkan pembungkus frame; dipakai alat Pilih. */
  onPointerLeave?: () => void;
  setFrameRef: (element: HTMLIFrameElement | null) => void;
}

function isDeviceId(value: string): value is DeviceId {
  return (DEVICE_IDS as readonly string[]).includes(value);
}

/**
 * Satu frame di kanvas: label di atas (ukuran layar tetap lewat
 * `scale(1/zoom)`) dan kotak berukuran preset perangkat. Hanya memuat iframe
 * saat hidup; selain itu kotak penampung berjudul.
 */
export function DesignFrame(props: DesignFrameProps) {
  const { title, route, device, rect, zoom, live, missing, html, warnings } = props;

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
        <span class="jk-design-frame-title">{title}</span>
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
          sections={[
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
          ]}
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
        ) : live && html !== undefined ? (
          <iframe
            ref={props.setFrameRef}
            sandbox="allow-scripts"
            srcdoc={html}
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
