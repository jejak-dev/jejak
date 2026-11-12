import { afterEach, describe, expect, test } from "bun:test";
import {
  SqliteUsageLedger,
  UNKNOWN_MODEL,
  type UsageEntry,
} from "../src/server/budget/usage-ledger";

const ledgers: SqliteUsageLedger[] = [];

function open(): SqliteUsageLedger {
  const ledger = new SqliteUsageLedger(":memory:", { retentionDays: 3650 });
  ledgers.push(ledger);
  return ledger;
}

function entry(partial: Partial<UsageEntry> & { ts: string }): UsageEntry {
  return {
    sessionId: "s_1",
    profileId: "p_1",
    model: "claude-a",
    costUsd: 0.5,
    inputTokens: 100,
    outputTokens: 50,
    ...partial,
  };
}

afterEach(() => {
  while (ledgers.length > 0) ledgers.pop()?.close();
});

describe("ringkasan pemakaian", () => {
  test("total menjumlahkan biaya, token, dan giliran dalam rentang", () => {
    const ledger = open();
    ledger.record(entry({ ts: "2026-11-10T05:00:00.000Z", costUsd: 0.5 }));
    ledger.record(
      entry({
        ts: "2026-11-12T05:00:00.000Z",
        sessionId: "s_2",
        costUsd: 0.25,
        inputTokens: 200,
        outputTokens: 100,
      }),
    );

    const summary = ledger.summarize({
      sinceIso: "2026-11-10T00:00:00.000Z",
      untilIso: "2026-11-13T00:00:00.000Z",
    });

    expect(summary.totalCostUsd).toBeCloseTo(0.75, 6);
    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalOutputTokens).toBe(150);
    expect(summary.turns).toBe(2);
  });

  test("per hari mengisi hari kosong dengan nol dan urut naik", () => {
    const ledger = open();
    ledger.record(entry({ ts: "2026-11-10T05:00:00.000Z", costUsd: 0.5 }));
    ledger.record(
      entry({ ts: "2026-11-12T05:00:00.000Z", sessionId: "s_2", costUsd: 0.25 }),
    );

    const summary = ledger.summarize({
      sinceIso: "2026-11-10T00:00:00.000Z",
      untilIso: "2026-11-13T00:00:00.000Z",
    });

    expect(summary.byDay.map((day) => day.day)).toEqual([
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
    expect(summary.byDay[0]?.costUsd).toBeCloseTo(0.5, 6);
    expect(summary.byDay[0]?.turns).toBe(1);
    expect(summary.byDay[1]).toEqual({
      day: "2026-11-11",
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
    });
    expect(summary.byDay[2]?.costUsd).toBeCloseTo(0.25, 6);
  });

  test("zona waktu menggeser batas hari", () => {
    const ledger = open();
    ledger.record(entry({ ts: "2026-11-10T23:30:00.000Z" }));

    const utc = ledger.summarize({
      sinceIso: "2026-11-10T00:00:00.000Z",
      untilIso: "2026-11-12T00:00:00.000Z",
    });
    const wib = ledger.summarize({
      sinceIso: "2026-11-10T00:00:00.000Z",
      untilIso: "2026-11-12T00:00:00.000Z",
      tzOffsetMinutes: 420,
    });

    // 23:30 UTC masih 10 November; di UTC+7 sudah 11 November.
    expect(utc.byDay[0]?.day).toBe("2026-11-10");
    expect(utc.byDay[0]?.turns).toBe(1);
    expect(wib.byDay[0]?.day).toBe("2026-11-10");
    expect(wib.byDay[0]?.turns).toBe(0);
    expect(wib.byDay[1]?.day).toBe("2026-11-11");
    expect(wib.byDay[1]?.turns).toBe(1);
  });

  test("per model memakai label untuk model kosong", () => {
    const ledger = open();
    ledger.record(entry({ ts: "2026-11-10T05:00:00.000Z", model: "claude-a" }));
    ledger.record(
      entry({
        ts: "2026-11-10T06:00:00.000Z",
        sessionId: "s_2",
        model: undefined,
        costUsd: 0.25,
      }),
    );

    const summary = ledger.summarize({
      sinceIso: "2026-11-10T00:00:00.000Z",
      untilIso: "2026-11-11T00:00:00.000Z",
    });

    expect(summary.byModel.map((row) => row.model)).toEqual([
      "claude-a",
      UNKNOWN_MODEL,
    ]);
    expect(summary.byModel[1]?.turns).toBe(1);
  });

  test("per profil dikelompokkan per id profil", () => {
    const ledger = open();
    ledger.record(entry({ ts: "2026-11-10T05:00:00.000Z", profileId: "p_1" }));
    ledger.record(
      entry({
        ts: "2026-11-10T06:00:00.000Z",
        sessionId: "s_2",
        profileId: "p_2",
        costUsd: 0.9,
      }),
    );

    const summary = ledger.summarize({
      sinceIso: "2026-11-10T00:00:00.000Z",
      untilIso: "2026-11-11T00:00:00.000Z",
    });

    expect(summary.byProfile.map((row) => row.profileId)).toEqual(["p_2", "p_1"]);
    expect(summary.byProfile[0]?.costUsd).toBeCloseTo(0.9, 6);
  });

  test("sesi teratas sepuluh dan urut biaya turun", () => {
    const ledger = open();
    for (let index = 0; index < 12; index += 1) {
      ledger.record(
        entry({
          ts: "2026-11-10T05:00:00.000Z",
          sessionId: `s_${String(index).padStart(2, "0")}`,
          costUsd: index / 10,
        }),
      );
    }

    const summary = ledger.summarize({
      sinceIso: "2026-11-10T00:00:00.000Z",
      untilIso: "2026-11-11T00:00:00.000Z",
    });

    expect(summary.bySession).toHaveLength(10);
    expect(summary.bySession[0]?.sessionId).toBe("s_11");
    expect(summary.bySession[0]?.costUsd).toBeCloseTo(1.1, 6);
    expect(summary.bySession[0]?.lastTs).toBe("2026-11-10T05:00:00.000Z");
    expect(summary.bySession[9]?.sessionId).toBe("s_02");
  });

  test("entri di luar rentang tidak dihitung", () => {
    const ledger = open();
    ledger.record(entry({ ts: "2026-11-09T05:00:00.000Z", costUsd: 5 }));
    ledger.record(entry({ ts: "2026-11-15T05:00:00.000Z", costUsd: 7 }));

    const summary = ledger.summarize({
      sinceIso: "2026-11-10T00:00:00.000Z",
      untilIso: "2026-11-13T00:00:00.000Z",
    });

    expect(summary.totalCostUsd).toBe(0);
    expect(summary.turns).toBe(0);
    expect(summary.byDay.every((day) => day.turns === 0)).toBe(true);
    expect(summary.bySession).toHaveLength(0);
  });

  test("ledger kosong menghasilkan semua nol", () => {
    const ledger = open();

    const summary = ledger.summarize({
      sinceIso: "2026-11-10T00:00:00.000Z",
      untilIso: "2026-11-12T00:00:00.000Z",
    });

    expect(summary.totalCostUsd).toBe(0);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.turns).toBe(0);
    expect(summary.byDay).toHaveLength(2);
    expect(summary.byDay.every((day) => day.costUsd === 0)).toBe(true);
    expect(summary.byModel).toEqual([]);
    expect(summary.byProfile).toEqual([]);
    expect(summary.bySession).toEqual([]);
  });

  test("rentang dibatasi tiga ratus enam puluh enam hari", () => {
    const ledger = open();

    const summary = ledger.summarize({
      sinceIso: "2024-01-01T00:00:00.000Z",
      untilIso: "2026-11-12T00:00:00.000Z",
    });

    expect(summary.byDay).toHaveLength(366);
    expect(summary.byDay[summary.byDay.length - 1]?.day).toBe("2026-11-11");
  });
});
