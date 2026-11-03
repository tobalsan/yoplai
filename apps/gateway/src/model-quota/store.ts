import type {
  LoginIdentity,
  QuotaSnapshot,
  QuotaSource,
  QuotaWindow,
} from "@yoplai/shared";
import { QUOTA_MAX_AGE_SECONDS } from "./constants.js";

type Observation = {
  windows: QuotaWindow[];
  observedAt?: number;
  stale: boolean;
  planLabel?: string;
  errorKind?: string;
  errorOrder?: number;
};
type Login = {
  identity: LoginIdentity;
  sources: Map<QuotaSource, Observation>;
};

export class QuotaStore {
  private errorOrder = 0;
  private readonly logins = new Map<string, Login>();

  constructor(
    private readonly deps: {
      now: () => number;
      isLoginActive: (identity: LoginIdentity) => boolean;
    }
  ) {}

  private key(identity: LoginIdentity): string {
    return JSON.stringify([identity.provider, identity.accountRef]);
  }

  record(
    identity: LoginIdentity,
    source: QuotaSource,
    windows: QuotaWindow[],
    observedAt: number,
    planLabel?: string
  ): void {
    const key = this.key(identity);
    let login = this.logins.get(key);
    if (!login) {
      login = { identity: { ...identity }, sources: new Map() };
      this.logins.set(key, login);
    }
    const previous = login.sources.get(source);
    if (previous?.observedAt !== undefined && observedAt < previous.observedAt)
      return;
    login.sources.set(source, {
      windows: structuredClone(windows),
      observedAt,
      stale: false,
      ...(planLabel === undefined ? {} : { planLabel }),
    });
  }

  markError(identity: LoginIdentity, source: QuotaSource, kind: string): void {
    const key = this.key(identity);
    let login = this.logins.get(key);
    if (!login) {
      login = { identity: { ...identity }, sources: new Map() };
      this.logins.set(key, login);
    }
    login.sources.set(source, {
      ...(login.sources.get(source) ?? { windows: [] }),
      stale: true,
      errorKind: kind,
      errorOrder: ++this.errorOrder,
    });
  }

  get(identity: LoginIdentity): QuotaSnapshot {
    if (!this.deps.isLoginActive(identity))
      this.logins.delete(this.key(identity));
    const login = this.logins.get(this.key(identity));
    const entries = login ? [...login.sources.entries()] : [];
    entries.sort(
      (a, b) => (b[1].observedAt ?? -Infinity) - (a[1].observedAt ?? -Infinity)
    );
    const effective = entries.find(
      ([, observation]) =>
        !observation.stale &&
        observation.observedAt !== undefined &&
        this.deps.now() - observation.observedAt <= QUOTA_MAX_AGE_SECONDS
    );
    const latestError = entries
      .filter(([, observation]) => observation.errorKind !== undefined)
      .sort((a, b) => (b[1].errorOrder ?? 0) - (a[1].errorOrder ?? 0))[0];
    const selected = effective ?? entries[0] ?? latestError;
    const snapshot: QuotaSnapshot = {
      ...identity,
      status: effective ? "known" : "unknown",
      windows: [],
      stale: !effective,
      ...(!effective
        ? { errorKind: latestError?.[1].errorKind ?? "never_seen" }
        : {}),
    };
    if (selected) {
      const [source, observation] = selected;
      snapshot.source = source;
      snapshot.windows = structuredClone(observation.windows);
      if (observation.observedAt !== undefined)
        snapshot.updatedAt = observation.observedAt;
      if (observation.planLabel !== undefined)
        snapshot.planLabel = observation.planLabel;
    }
    return snapshot;
  }

  latestHeaderAt(identity: LoginIdentity): number | undefined {
    if (!this.deps.isLoginActive(identity)) {
      this.logins.delete(this.key(identity));
      return undefined;
    }
    const headers = this.logins.get(this.key(identity))?.sources.get("headers");
    return headers?.stale ? undefined : headers?.observedAt;
  }

  list(): QuotaSnapshot[] {
    return [...this.logins.values()].flatMap((login) => {
      const snapshot = this.get(login.identity);
      return this.logins.has(this.key(login.identity)) ? [snapshot] : [];
    });
  }
}
