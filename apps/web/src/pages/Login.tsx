import { useNavigate } from "@solidjs/router";
import { Show, createEffect, createMemo, createSignal } from "solid-js";
import { capabilities } from "../lib/capabilities";
import { usePendingApprovalRefresh } from "../auth/approval";
import { signIn, useSession } from "../auth/client";

type SessionUser = {
  id?: string;
  approved?: boolean | null;
};

export default function LoginPage() {
  const navigate = useNavigate();
  const session = useSession();
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const user = createMemo(
    () => (session().data?.user ?? null) as SessionUser | null
  );
  const approvedFromMe = usePendingApprovalRefresh(user);
  const hasAccess = createMemo(
    () => session().data && (user()?.approved !== false || approvedFromMe())
  );

  createEffect(() => {
    if (!capabilities.multiUser) {
      void navigate("/", { replace: true });
      return;
    }
    if (hasAccess()) {
      void navigate("/", { replace: true });
    }
  });

  async function handleGoogleSignIn() {
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await signIn.social({
        provider: "google",
        callbackURL: window.location.origin + "/",
      });
      if (result?.error) {
        setError(result.error.message ?? "Sign-in failed.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <main class="login-page">
        <section class="login-card">
          <div class="login-brand">
            <Show
              when={capabilities.branding?.logo}
              fallback={
                <div class="login-mark">
                  {capabilities.branding?.name?.substring(0, 2).toUpperCase() ??
                    "AI"}
                </div>
              }
            >
              <img
                class="login-logo"
                src={capabilities.branding?.logo}
                alt={capabilities.branding?.name ?? "Yoplai"}
              />
            </Show>
            <div>
              <p class="login-eyebrow">
                {capabilities.branding?.name ?? "Yoplai"}
              </p>
              <h1>Sign in with Google</h1>
            </div>
          </div>
          <p class="login-copy">Use your Google account to continue.</p>
          <button
            class="login-google-button"
            type="button"
            onClick={() => void handleGoogleSignIn()}
            disabled={isSubmitting()}
          >
            <span class="login-google-icon" aria-hidden="true">
              G
            </span>
            <span>{isSubmitting() ? "Redirecting…" : "Continue with Google"}</span>
          </button>
          <Show when={session().data && user()?.approved === false && !approvedFromMe()}>
            <p class="login-note">
              Signed in already. Your account is waiting for admin approval.
            </p>
          </Show>
          <Show when={error()}>
            {(message) => <p class="login-error">{message()}</p>}
          </Show>
        </section>
      </main>
      <style>{`
        .login-page {
          min-height: 100vh;
          display: grid;
          place-items: center;
          padding: 24px;
          background:
            radial-gradient(circle at top, color-mix(in srgb, var(--accent, #60a5fa) 18%, transparent), transparent 34%),
            linear-gradient(180deg, color-mix(in srgb, var(--bg-primary) 94%, transparent), var(--bg-primary));
        }

        .login-card {
          width: min(440px, 100%);
          padding: 32px;
          border-radius: 24px;
          border: 1px solid var(--border-default);
          background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
          box-shadow: 0 24px 60px rgba(15, 23, 42, 0.2);
        }

        .login-brand {
          display: flex;
          align-items: center;
          gap: 16px;
          margin-bottom: 18px;
        }

        .login-mark {
          width: 52px;
          height: 52px;
          border-radius: 16px;
          display: grid;
          place-items: center;
          font-size: 1rem;
          font-weight: 800;
          letter-spacing: 0.08em;
          color: var(--text-primary);
          background: color-mix(in srgb, var(--bg-raised) 82%, transparent);
          border: 1px solid var(--border-default);
        }

        .login-logo {
          width: 52px;
          height: 52px;
          border-radius: 16px;
          object-fit: contain;
        }

        .login-eyebrow {
          margin: 0 0 4px;
          color: var(--text-secondary);
          font-size: 0.8rem;
          text-transform: uppercase;
          letter-spacing: 0.12em;
        }

        .login-card h1 {
          margin: 0;
          font-size: clamp(1.75rem, 4vw, 2.2rem);
          line-height: 1.05;
          color: var(--text-primary);
        }

        .login-copy,
        .login-note {
          margin: 0 0 18px;
          color: var(--text-secondary);
          line-height: 1.5;
        }

        .login-google-button {
          width: 100%;
          min-height: 52px;
          border: 1px solid var(--border-default);
          border-radius: 14px;
          background: var(--bg-primary);
          color: var(--text-primary);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 12px;
          font-size: 0.98rem;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
        }

        .login-google-button:hover:not(:disabled) {
          transform: translateY(-1px);
          background: var(--bg-raised);
        }

        .login-google-button:disabled {
          cursor: default;
          opacity: 0.7;
        }

        .login-google-icon {
          width: 28px;
          height: 28px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          background: linear-gradient(135deg, #fbbc05, #ea4335 55%, #4285f4);
          color: white;
          font-size: 0.95rem;
          font-weight: 700;
        }

        .login-error {
          margin: 16px 0 0;
          padding: 12px 14px;
          border-radius: 12px;
          background: color-mix(in srgb, #ef4444 16%, var(--bg-surface));
          color: var(--text-primary);
        }

        @media (max-width: 640px) {
          .login-card {
            padding: 24px;
            border-radius: 20px;
          }

          .login-brand {
            align-items: flex-start;
          }
        }
      `}</style>
    </>
  );
}
