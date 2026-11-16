import { expect, test } from "bun:test";

const app = await Bun.file("src/client/app.tsx").text();

test("panel tidak dibuka otomatis dari preferensi di layar sempit", () => {
  expect(app).toContain("readPanelPrefs().open && !window.matchMedia(NARROW_VIEWPORT_QUERY).matches");
});
