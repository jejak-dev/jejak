import { Elysia } from "elysia";
import { VERSION } from "../../shared/version";

export interface InfoRoutesOptions {
  cwd?: string;
  mock?: boolean;
}

export function infoRoutes(options: InfoRoutesOptions = {}): Elysia {
  const cwd = options.cwd ?? process.cwd();
  const mock = options.mock ?? false;

  const plugin = new Elysia({ name: "jejak-info-routes" }).get("/api/info", () => ({
    name: "jejak",
    version: VERSION,
    cwd,
    mock,
  }));

  return plugin as unknown as Elysia;
}
