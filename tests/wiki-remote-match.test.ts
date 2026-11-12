import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitProviderProfile } from "../src/server/gitprovider/provider-store";
import { matchRemote, originOf } from "../src/server/wiki/remote-match";

const GL: GitProviderProfile = {
  id: "gl",
  name: "GitLab kantor",
  kind: "gitlab",
  baseUrl: "https://git.example.test",
};

const GL_PORTO: GitProviderProfile = {
  id: "gl",
  name: "GitLab kantor",
  kind: "gitlab",
  baseUrl: "https://git.example.test:2222",
};

const LOKAL: GitProviderProfile = {
  id: "lokal",
  name: "Lokal",
  kind: "local",
  root: "/tmp/lokal",
};

describe("pencocokan remote", () => {
  test("https dengan dan tanpa akhiran .git", () => {
    expect(matchRemote("https://git.example.test/grup/proyek.git", [GL])).toEqual({
      providerId: "gl",
      fullPath: "grup/proyek",
    });
    expect(matchRemote("https://git.example.test/grup/proyek", [GL])).toEqual({
      providerId: "gl",
      fullPath: "grup/proyek",
    });
    expect(matchRemote("https://git.example.test/grup/sub/proyek.git", [GL])).toEqual({
      providerId: "gl",
      fullPath: "grup/sub/proyek",
    });
  });

  test("garis miring di ujung dan host huruf besar tetap cocok", () => {
    expect(matchRemote("https://git.example.test/grup/proyek/", [GL])).toEqual({
      providerId: "gl",
      fullPath: "grup/proyek",
    });
    expect(matchRemote("https://GIT.EXAMPLE.TEST/grup/proyek.git", [GL])).toEqual({
      providerId: "gl",
      fullPath: "grup/proyek",
    });
  });

  test("ssh dan gaya scp", () => {
    expect(matchRemote("ssh://git@git.example.test/grup/proyek.git", [GL])).toEqual({
      providerId: "gl",
      fullPath: "grup/proyek",
    });
    expect(matchRemote("git@git.example.test:grup/proyek.git", [GL])).toEqual({
      providerId: "gl",
      fullPath: "grup/proyek",
    });
    expect(matchRemote("git@git.example.test:grup/sub/proyek.git", [GL])).toEqual({
      providerId: "gl",
      fullPath: "grup/sub/proyek",
    });
  });

  test("port dibandingkan bila remote menyebut port", () => {
    expect(matchRemote("ssh://git@git.example.test:2222/grup/proyek.git", [GL_PORTO])).toEqual({
      providerId: "gl",
      fullPath: "grup/proyek",
    });
    expect(matchRemote("ssh://git@git.example.test:2222/grup/proyek.git", [GL])).toBeUndefined();
    expect(matchRemote("https://git.example.test:8443/grup/proyek.git", [GL])).toBeUndefined();
  });

  test("host berbeda, profil non-gitlab, dan alamat rusak tidak cocok", () => {
    expect(matchRemote("https://gitlab.lain.test/grup/proyek.git", [GL])).toBeUndefined();
    expect(matchRemote("https://git.example.test/grup/proyek.git", [LOKAL])).toBeUndefined();
    expect(matchRemote("https://git.example.test/grup/proyek.git", [])).toBeUndefined();
    expect(matchRemote("", [GL])).toBeUndefined();
    expect(matchRemote("bukan-url", [GL])).toBeUndefined();
    expect(matchRemote("https://git.example.test/", [GL])).toBeUndefined();
  });

  test("originOf membaca remote origin dan gagal bila tidak ada", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jejak-origin-"));
    try {
      const git = (...args: string[]): void => {
        const result = Bun.spawnSync({
          cmd: ["git", "-c", "user.name=Uji", "-c", "user.email=uji@example.test", ...args],
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      };
      git("init", "-q", "-b", "main");
      expect(await originOf(dir)).toBeUndefined();
      git("remote", "add", "origin", "https://git.example.test/grup/proyek.git");
      expect(await originOf(dir)).toBe("https://git.example.test/grup/proyek.git");
      expect(await originOf(join(dir, "tidak-ada"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
