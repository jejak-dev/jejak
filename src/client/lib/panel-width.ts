import { paneWidth } from "./pane-width";

export const PANEL_DEFAULT = 460;

export const panelWidth = paneWidth({
  key: "jejak.panelWidth",
  def: PANEL_DEFAULT,
  min: 320,
  max: 760,
  step: 20,
});
