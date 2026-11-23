import { useState, type FormEvent } from "react";
import { api, Logo } from "./api";

export default function Login({ onLogin }: { onLogin: (name: string) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const signup = mode === "signup";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !password) return;
    setError("");
    setPending(true);
    try {
      const signedIn = signup ? await api.signUp(name.trim(), password) : await api.logIn(name.trim(), password);
      onLogin(signedIn);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="screen auth-screen">
      <section className="auth-art" aria-hidden="true">
        <div className="auth-art-inner">
          <Logo />
          <div className="art-stack">
            <div className="art-bubble">Let's review the prototype on Monday.</div>
            <div className="art-bubble alt">Figma flow first, coding next phase.</div>
            <div className="art-decision">
              <span className="art-check">✓</span>
              Clickable Figma flow, then coding
            </div>
          </div>
          <p className="auth-tagline">Talk with your team, think with your agent, and keep what you decide.</p>
        </div>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <div className="auth-mobile-logo">
            <Logo />
          </div>
          <div className="auth-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={!signup}
              className={signup ? "" : "on"}
              onClick={() => {
                setMode("login");
                setError("");
              }}
            >
              Log in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={signup}
              className={signup ? "on" : ""}
              onClick={() => {
                setMode("signup");
                setError("");
              }}
            >
              Create account
            </button>
          </div>
          <h1>{signup ? "Create your account" : "Welcome back"}</h1>
          <p className="muted">
            {signup ? "Your teammates will see this name." : "Log in to see your groups and meetings."}
          </p>
          <label>
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Jia"
              maxLength={40}
              autoFocus
              autoComplete="username"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={signup ? "At least 6 characters" : ""}
              autoComplete={signup ? "new-password" : "current-password"}
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button className="btn primary block" type="submit" disabled={!name.trim() || !password || pending}>
            {pending ? "..." : signup ? "Create account" : "Log in"}
          </button>
        </form>
      </section>
    </main>
  );
}
