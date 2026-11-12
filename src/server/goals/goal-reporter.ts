import type { GoalReport, GoalReportResult, GoalReporter } from "./goal";

/**
 * Pemegang reporter goal. Jembatan MCP dibuat lebih dulu daripada manajer
 * sesi, jadi pelapor ditautkan belakangan; panggilan sebelum tautan hanya
 * menjawab galat.
 */
export class GoalReporterHolder {
  private reporter: GoalReporter | undefined;
  private active: ((sessionId: string) => boolean) | undefined;

  attach(
    reporter: GoalReporter,
    active: (sessionId: string) => boolean,
  ): void {
    this.reporter = reporter;
    this.active = active;
  }

  report(sessionId: string, report: GoalReport): GoalReportResult {
    const reporter = this.reporter;
    if (reporter === undefined) {
      return { ok: false, error: "Mode Goal belum siap di server ini." };
    }
    return reporter(sessionId, report);
  }

  /** Apakah sesi punya tujuan aktif; menentukan tool `goal_update` tampil. */
  hasGoal(sessionId: string): boolean {
    return this.active?.(sessionId) === true;
  }
}
