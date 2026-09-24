import { useLocation, useNavigate } from "@solidjs/router";
import { Show, createEffect, createMemo, type JSX } from "solid-js";
import { useSession } from "./client";
import { usePendingApprovalRefresh } from "./approval";
import { capabilities } from "../lib/capabilities";

type SessionUser = {
  id?: string;
  approved?: boolean | null;
};

function GuardSplash(props: { message: string }) {
  return (
    <>
      <div class="auth-guard-state">
        <div class="auth-guard-card">
          <div class="auth-guard-spinner" aria-hidden="true" />
          <p>{props.message}</p>
        </div>
      </div>
      <style>{`
        .auth-guard-state {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
          background:
            radial-gradient(circle at top, color-mix(in srgb, var(--accent, #60a5fa) 16%, transparent), transparent 34%),
            var(--bg-primary);
        }

        .auth-guard-card {
          width: min(420px, 100%);
          padding: 28px;
          border-radius: 18px;
          border: 1px solid var(--border-default);
          background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.18);
          display: grid;
          justify-items: center;
          gap: 14px;
          text-align: center;
          color: var(--text-secondary);
        }

        .auth-guard-spinner {
          width: 24px;
          height: 24px;
          border-radius: 999px;
          border: 2px solid var(--border-default);
          border-top-color: var(--text-primary);
          animation: auth-guard-spin 0.8s linear infinite;
        }

        @keyframes auth-guard-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </>
  );
}

function PendingApproval() {
  return (
    <>
      <div class="auth-guard-state">
        <div class="auth-guard-card">
          <h1>Pending approval</h1>
          <p>Your account is waiting for an admin to approve access.</p>
        </div>
      </div>
      <style>{`
        .auth-guard-state {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
          background:
            radial-gradient(circle at top, color-mix(in srgb, var(--accent, #60a5fa) 16%, transparent), transparent 34%),
            var(--bg-primary);
        }

        .auth-guard-card {
          width: min(420px, 100%);
          padding: 28px;
          border-radius: 18px;
          border: 1px solid var(--border-default);
          background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.18);
          display: grid;
          gap: 10px;
          text-align: center;
        }

        .auth-guard-card h1 {
          margin: 0;
          font-size: 1.5rem;
          color: var(--text-primary);
        }

        .auth-guard-card p {
          margin: 0;
          color: var(--text-secondary);
        }
      `}</style>
    </>
  );
}

export default function AuthGuard(props: { children?: JSX.Element }) {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const sessionState = createMemo(() => session());
  const user = createMemo(
    () => (sessionState().data?.user ?? null) as SessionUser | null
  );
  const approvedFromMe = usePendingApprovalRefresh(user);
  const hasAccess = createMemo(
    () => user()?.approved !== false || approvedFromMe()
  );

  createEffect(() => {
    if (!capabilities.multiUser) return;
    const state = sessionState();
    if (state.isPending) return;
    if (!state.data) {
      const returnTo = encodeURIComponent(location.pathname + location.search);
      void navigate(`/login?returnTo=${returnTo}`, { replace: true });
    }
  });

  return (
    <Show when={!capabilities.multiUser} fallback={
      <Show when={!sessionState().isPending} fallback={<GuardSplash message="Checking session…" />}>
        <Show when={sessionState().data} fallback={<GuardSplash message="Redirecting to login…" />}>
          <Show when={hasAccess()} fallback={<PendingApproval />}>
            {props.children}
          </Show>
        </Show>
      </Show>
    }>
      {props.children}
    </Show>
  );
}
