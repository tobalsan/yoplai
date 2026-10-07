import type Database from "better-sqlite3";

export type OnboardingStatus = "done" | "skipped";

export type OnboardingState = {
  status: OnboardingStatus | null;
  at: string | null;
};

export type OnboardingStore = {
  get(userId: string): OnboardingState;
  set(userId: string, status: OnboardingStatus): OnboardingState;
  clear(userId: string): OnboardingState;
};

export function createOnboardingStore(db: Database.Database): OnboardingStore {
  const get = (userId: string): OnboardingState => {
    const row = db
      .prepare("SELECT status, at FROM user_onboarding WHERE userId = ?")
      .get(userId) as
      | { status: OnboardingStatus; at: string }
      | undefined;
    return row ? { status: row.status, at: row.at } : { status: null, at: null };
  };
  return {
    get,
    set(userId, status) {
      db.prepare(
        `INSERT INTO user_onboarding (userId, status, at) VALUES (?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET status = excluded.status, at = excluded.at`
      ).run(userId, status, new Date().toISOString());
      return get(userId);
    },
    clear(userId) {
      db.prepare("DELETE FROM user_onboarding WHERE userId = ?").run(userId);
      return get(userId);
    },
  };
}
