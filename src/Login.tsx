import { useState, type FormEvent } from "react";
import { Logo } from "./api";
import { saveProfile, type Profile } from "./model";

export default function Login({ onLogin }: { onLogin: (profile: Profile) => void }) {
  const [name, setName] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const profile = { name: trimmed };
    saveProfile(profile);
    onLogin(profile);
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
          <p className="auth-tagline">
            Talk with your team, think with your agent, and keep what you decide.
          </p>
        </div>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <div className="auth-mobile-logo">
            <Logo />
          </div>
          <h1>Welcome</h1>
          <p className="muted">Log in with the name your team will see.</p>
          <label>
            Your name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Jia"
              maxLength={40}
              autoFocus
              autoComplete="nickname"
            />
          </label>
          <button className="btn primary block" type="submit" disabled={!name.trim()}>
            Log in
          </button>
          <p className="fine">Your name and chats are remembered on this device.</p>
        </form>
      </section>
    </main>
  );
}
